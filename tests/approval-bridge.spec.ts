/**
 * 决策 6 单测：PM 代为审批——子 agent 的鉴权操作转给任务指派方。
 *
 * 覆盖面（对应 docs/verification.md 决策 6 / acceptance criteria）：
 * - 转交：worker 执行 working 任务中触发 approval/request → 桥接管
 *   （不调 next()）、pending 登记、PM（assignedBy）被通知（含谁/什么操作/
 *   为什么/任务上下文/如何回答）、respond_approval(allow) 后 worker 收到
 *   'allowed-once'；
 * - PM 判定：无 working 任务 → 转 fullAccessSessions 兜底；两者皆无 →
 *   next() 委托 harness 原链（agent-bus 不介入）；
 * - 拒绝带理由+方案：respond_approval(reject, reason, suggestion) →
 *   worker 收到 'rejected'，且子 agent 收到含理由+方案的旁路通知；reject
 *   缺 reason/suggestion 时报错指明字段；
 * - 越权拒绝：非 approver 调 respond_approval → 报错；
 * - 超时兜底：PM 不响应 → fail-closed 'unavailable'、挂起清理、子 agent
 *   收到「可请求 PM 或调整方案」提示，不永久挂起。
 *
 * 核心逻辑全部真实实现：ledger（in-memory 域）、approval-bridge、respond_
 * approval 工具体；仅 ctx 事件面（on/tools/agents）为协作方桩——approval/
 * request 是 host 事件，测试直接调用捕获的监听器并注入 next spy。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { clearNoticeMerges, flushNoticeMerges } from '../src/delivery.ts'
import { TaskLedger } from '../src/ledger.ts'
import { installApprovalBridge, type ApprovalBridgeConfig } from '../src/approval-bridge.ts'
import { TaskId } from '../src/domain/types.ts'
import {
  createMemoryCtx,
  makeNewTask,
  SESSION_A,
  SESSION_B,
  WORKSPACE,
} from './helpers/memory-ctx.ts'

/** 最小 live-agent 桩：记录 followup/steer 收到的消息（与 tool-harness 同面，
 * 但本套件不依赖 tools.ts，避免被并发在制品的 import 拉入）。 */
interface FakeAgent {
  readonly id: SessionId
  readonly status: 'running' | 'idle'
  readonly session: { header: { cwd?: string; origin?: string } }
  readonly followups: unknown[]
  followup(message: unknown): void
  steer(message: unknown): void
  cancel(): void
}

function makeAgent(id: SessionId): FakeAgent {
  const followups: unknown[] = []
  return {
    id,
    status: 'running',
    session: { header: { cwd: WORKSPACE } },
    followups,
    followup: (message) => {
      followups.push(message)
    },
    steer: () => {},
    cancel: () => {},
  }
}

/** 假 Agent 注册表：ctx.agents 的 get/list 两面。 */
class FakeAgentRegistry {
  private readonly byId = new Map<string, FakeAgent>()
  add(agent: FakeAgent): void {
    this.byId.set(String(agent.id), agent)
  }
  get(id: SessionId): FakeAgent | undefined {
    return this.byId.get(String(id))
  }
  list(): FakeAgent[] {
    return [...this.byId.values()]
  }
}

/** 收件箱消息的 model 可见文本。 */
function textOf(message: unknown): string {
  const block = (message as { content: { type: string; text: string }[] }).content[0]
  if (block === undefined) throw new Error('message has no text block')
  return block.text
}

/** 一个最小合法的 approval/request 载荷。 */
function approvalReq(agent: FakeAgent, toolName = 'pwsh', reason?: string): unknown {
  return {
    agent,
    toolName,
    ...(reason !== undefined ? { reason } : {}),
    signal: new AbortController().signal,
  }
}

/** 测试基座：真实 ledger + 捕获的 approval/request 监听 + 已注册的 respond_approval。 */
interface ApprovalHarness {
  readonly ledger: TaskLedger
  readonly tools: Map<string, ToolDefinition>
  readonly agents: FakeAgentRegistry
  /** 捕获的 approval/request 监听器与 tools/execute 监听器。 */
  readonly handlers: Map<string, (...args: unknown[]) => unknown>
  /** 调用 approval/request 监听器，返回待决 promise 与 next spy。 */
  invoke(req: unknown): { readonly promise: Promise<unknown>; readonly next: ReturnType<typeof vi.fn> }
  /** 以 caller 身份调用已注册工具的真实 execute 体。 */
  runTool(name: string, args: unknown, caller: FakeAgent): Promise<unknown>
  /** 立即投递合并窗口内的系统通知（decision 3 批处理）。 */
  notify(): void
  dispose(): Promise<void>
}

async function createApprovalHarness(
  config: Partial<ApprovalBridgeConfig> = {},
): Promise<ApprovalHarness> {
  const base = await createMemoryCtx()
  const ledger = await TaskLedger.open(base.ctx)
  const tools = new Map<string, ToolDefinition>()
  const agents = new FakeAgentRegistry()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    agents,
    sessionTitle: { get: () => undefined },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(event, listener)
      return () => handlers.delete(event)
    },
    emit: () => {},
    get: () => undefined,
    effect: () => () => {},
  } as unknown as Context
  const disposeBridge = installApprovalBridge(ctx, ledger, {
    approvalTimeoutMs: config.approvalTimeoutMs ?? 60_000,
    fullAccessSessions: config.fullAccessSessions ?? [],
  })
  return {
    ledger,
    tools,
    agents,
    handlers,
    invoke: (req) => {
      const listener = handlers.get('approval/request')
      if (listener === undefined) throw new Error('no approval/request listener registered')
      const next = vi.fn(async () => 'unavailable' as const)
      const promise = Promise.resolve(
        (listener as (r: unknown, n: () => Promise<unknown>) => Promise<unknown>)(req, next),
      )
      return { promise, next }
    },
    runTool: async (name, args, caller) => {
      const def = tools.get(name)
      if (def === undefined) throw new Error(`tool "${name}" is not registered in the harness`)
      return def.execute(args, { agent: caller as unknown as Agent } as unknown as ToolRunContext)
    },
    notify: () => flushNoticeMerges(ctx),
    dispose: async () => {
      // 未决审批按 'cancelled' 清理（disposer 语义），再关域。
      disposeBridge()
      await base.dispose()
    },
  }
}

/** 建立一个 A 派发给 B 且已进入 working 的任务。 */
async function workingTask(h: ApprovalHarness, id = 't1'): Promise<void> {
  const created = await h.ledger.record(makeNewTask({
    id: TaskId(id),
    assignedBy: SESSION_A,
    assignedTo: SESSION_B,
    workspacePath: WORKSPACE,
  }), 20)
  expect(created.ok).toBe(true)
  const advanced = await h.ledger.transition(TaskId(id), 'working')
  expect(advanced.ok).toBe(true)
}

describe('决策6 approval-bridge：A2A 转交', () => {
  afterEach(() => {
    clearNoticeMerges()
  })

  it('worker 任务中触发审批 → 桥接管(不调 next)、PM 被通知、allow 后 worker 收到 allowed-once', async () => {
    const h = await createApprovalHarness()
    const worker = makeAgent(SESSION_B)
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise, next } = h.invoke(approvalReq(worker, 'pwsh', 'escalate sandbox to workspace-write'))

    // 任务上下文存在 → 接管，不委托 harness 原链。
    expect(next).not.toHaveBeenCalled()

    // PM（assignedBy）收到含四要素上下文的审批通知。
    h.notify()
    expect(pm.followups).toHaveLength(1)
    const notice = textOf(pm.followups[0])
    expect(notice).toContain('审批请求')
    expect(notice).toContain(SESSION_B.slice(0, 8))
    expect(notice).toContain('pwsh')
    expect(notice).toContain('escalate sandbox to workspace-write')
    expect(notice).toContain('t1')
    expect(notice).toContain('respond_approval')

    // PM allow → worker 的工具调用拿到 allowed-once。
    const approvalId = /approval_id = ([0-9a-f-]{36})/.exec(notice)?.[1]
    expect(approvalId).toBeTruthy()
    const answered = await h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'allow',
    }, pm)
    expect(answered).toEqual({ approvalId, outcome: 'allowed-once' })

    const outcome = await promise
    expect(outcome).toBe('allowed-once')
    await h.dispose()
  })

  it('PM 拒绝必须带理由+方案：随拒绝一并旁路告知子 agent', async () => {
    const h = await createApprovalHarness()
    const worker = makeAgent(SESSION_B)
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise, next } = h.invoke(approvalReq(worker, 'fs:write'))
    expect(next).not.toHaveBeenCalled()
    h.notify()
    const notice = textOf(pm.followups[0])
    const approvalId = /approval_id = ([0-9a-f-]{36})/.exec(notice)?.[1]
    expect(approvalId).toBeTruthy()

    const answered = await h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'reject',
      reason: '不需要写仓库外文件',
      suggestion: '改用 workspace 内的路径,或调整任务范围',
    }, pm)
    // 拒绝时理由+suggestion 随返回同步附上（主通道），不再只靠旁路。
    expect(answered).toEqual({
      approvalId,
      outcome: 'rejected',
      reason: '不需要写仓库外文件',
      suggestion: '改用 workspace 内的路径,或调整任务范围',
    })

    // 子 agent 仍收到旁路通知（冗余，与返回面一致）。
    h.notify()
    expect(worker.followups).toHaveLength(1)
    const workerNotice = textOf(worker.followups[0])
    expect(workerNotice).toContain('拒绝')
    expect(workerNotice).toContain('不需要写仓库外文件')
    expect(workerNotice).toContain('改用 workspace 内的路径,或调整任务范围')

    const outcome = await promise
    expect(outcome).toBe('rejected')
    await h.dispose()
  })

  it('reject 缺理由或方案 → 报错指明字段', async () => {
    const h = await createApprovalHarness()
    const worker = makeAgent(SESSION_B)
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise } = h.invoke(approvalReq(worker, 'pwsh'))
    h.notify()
    const notice = textOf(pm.followups[0])
    const approvalId = /approval_id = ([0-9a-f-]{36})/.exec(notice)?.[1]
    expect(approvalId).toBeTruthy()

    await expect(h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'reject',
    }, pm)).rejects.toThrow('reason')
    await expect(h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'reject',
      reason: 'no',
    }, pm)).rejects.toThrow('suggestion')

    // 未决：挂起仍等 PM（没有因校验错误误结算）。
    expect(h.ledger.get(TaskId('t1'))?.status).toBe('working')
    // 校验失败不影响挂起；dispose 时未决审批按 'cancelled' 清理（不永久挂起）。
    const cancelled = await h.dispose()
    void cancelled
    await expect(promise).resolves.toBe('cancelled')
  })
})

describe('决策6 approval-bridge：PM 判定', () => {
  afterEach(() => {
    clearNoticeMerges()
  })

  it('无 working 任务但有 fullAccessSessions → 转 full-access 兜底会话', async () => {
    const full = makeAgent(SessionId('session-full'))
    const h = await createApprovalHarness({ fullAccessSessions: [full.id] })
    const worker = makeAgent(SESSION_B)
    h.agents.add(worker)
    h.agents.add(full)

    const { promise, next } = h.invoke(approvalReq(worker, 'pwsh'))
    expect(next).not.toHaveBeenCalled()
    h.notify()
    expect(full.followups).toHaveLength(1)
    expect(textOf(full.followups[0])).toContain('会话级操作')
    const notice = textOf(full.followups[0])
    const approvalId = /approval_id = ([0-9a-f-]{36})/.exec(notice)?.[1]
    expect(approvalId).toBeTruthy()

    const answered = await h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'allow',
    }, full)
    expect(answered.outcome).toBe('allowed-once')
    const outcome = await promise
    expect(outcome).toBe('allowed-once')
    await h.dispose()
  })

  it('无 working 任务且无 fullAccessSessions → 调 next() 委托 harness 原链,不介入', async () => {
    const h = await createApprovalHarness()
    const worker = makeAgent(SESSION_B)
    h.agents.add(worker)

    const { promise, next } = h.invoke(approvalReq(worker, 'pwsh'))
    expect(next).toHaveBeenCalledTimes(1)
    // 不产生任何通知（无 approver 可通知）。
    h.notify()
    const outcome = await promise
    expect(outcome).toBe('unavailable') // next 的返回值透传
    await h.dispose()
  })
})

describe('决策6 approval-bridge：越权与超时兜底', () => {
  afterEach(() => {
    clearNoticeMerges()
  })

  it('非 approver 调 respond_approval → 报错「仅任务发起方可回答」', async () => {
    const h = await createApprovalHarness()
    const worker = makeAgent(SESSION_B)
    const pm = makeAgent(SESSION_A)
    const intruder = makeAgent(SessionId('session-intruder'))
    h.agents.add(worker)
    h.agents.add(pm)
    h.agents.add(intruder)
    await workingTask(h)

    const { promise } = h.invoke(approvalReq(worker, 'pwsh'))
    h.notify()
    const notice = textOf(pm.followups[0])
    const approvalId = /approval_id = ([0-9a-f-]{36})/.exec(notice)?.[1]
    expect(approvalId).toBeTruthy()

    await expect(h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'allow',
    }, intruder)).rejects.toThrow('仅任务发起方')

    // 越权失败不影响 PM 正常回答。
    const answered = await h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'allow',
    }, pm)
    expect(answered.outcome).toBe('allowed-once')
    const outcome = await promise
    expect(outcome).toBe('allowed-once')
    await h.dispose()
  })

  it('PM 不响应超时 → fail-closed unavailable、挂起清理、子 agent 收到可请求 PM 提示', async () => {
    const h = await createApprovalHarness({ approvalTimeoutMs: 30 })
    const worker = makeAgent(SESSION_B)
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise, next } = h.invoke(approvalReq(worker, 'pwsh'))
    expect(next).not.toHaveBeenCalled()
    h.notify()
    expect(pm.followups).toHaveLength(1)

    const outcome = await promise
    expect(outcome).toBe('unavailable')

    // 子 agent 收到 fail-closed 提示（可请求 PM 或调整方案）。
    h.notify()
    expect(worker.followups).toHaveLength(1)
    const workerNotice = textOf(worker.followups[0])
    expect(workerNotice).toContain('超时')
    expect(workerNotice).toContain('fail-closed')
    expect(workerNotice).toContain('任务发起方')

    // 超时后同一 approval_id 再回答已无挂起（幂等 no-op 由工具报错兜底）。
    const notice = textOf(pm.followups[0])
    const approvalId = /approval_id = ([0-9a-f-]{36})/.exec(notice)?.[1]
    await expect(h.runTool('respond_approval', {
      approval_id: approvalId,
      decision: 'allow',
    }, pm)).rejects.toThrow('no pending approval')
    await h.dispose()
  })
})
