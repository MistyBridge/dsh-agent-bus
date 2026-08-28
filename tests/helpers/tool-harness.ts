/**
 * 工具执行级测试基座：真实 in-memory ledger + 最小 ctx 桩，让 send_note、
 * create_task、list_tasks、get_task 等工具的 execute 体以真实实现端到端跑通。
 *
 * 只有三类边界是假件（协作方桩，非核心逻辑 mock，套件不触发它们的行为）：
 * - ctx.agents：假 Agent（记录 followup/steer 收到的消息）。wakeSession 的
 *   resume 永不成功（无模型路由），因此「注册但不在线」的会话就是离线目标，
 *   send_note 的离线入队路径可端到端测试；
 * - ctx.workspaceRegistry：按路径解析的最小注册表桩（resolveByPath /
 *   list / archivedSessionIds 三面）；
 * - deps.reports：报告存储桩，本套件不调用 save/read/archive。
 *
 * ledger、DispatchRateLimiter、admitContent、authorize*、delivery 消息构造
 * 全部使用真实实现。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ReportStore } from '../../src/external.ts'
import { TaskLedger } from '../../src/ledger/ledger.ts'
import { QuestionRegistry } from '../../src/question-bridge.ts'
import { DispatchRateLimiter } from '../../src/rate-limit.ts'
import { registerAgentBusTools, type ToolsConfig, type ToolsDeps } from '../../src/tools.ts'
import { createMemoryCtx, SESSION_A, SESSION_B, SESSION_REVIEWER, WORKSPACE } from './memory-ctx.ts'

/** 假 Agent 的构造选项。cwd 缺省为工作区路径；传 `null` 表示无工作区。 */
export interface FakeAgentOptions {
  readonly cwd?: string | null
  readonly origin?: string
  readonly status?: 'running' | 'idle'
  /** 附加到假 session 的事件日志（决策/R1:注入上下文判定的 session.events 面）。 */
  readonly events?: readonly SessionEvent[]
  /** Agent 作用域 ctx（reconfigure_member 的 role 经 agent.ctx.get('systemPrompt') 注册）。 */
  readonly ctx?: Context
}

/**
 * 最小 live-agent 桩：记录 followup/steer 收到的消息，供交付断言读取。
 * session.header 只带 authorize/resolveWorkspacePath 用到的面。
 */
export interface FakeAgent {
  readonly id: SessionId
  readonly status: 'running' | 'idle'
  readonly session: { id: SessionId; header: { cwd?: string; origin?: string } }
  readonly ctx: Context
  readonly followups: unknown[]
  readonly steers: unknown[]
  followup(message: unknown): void
  steer(message: unknown): void
  cancel(): void
  /**
   * 收件箱认领顺序：harness 的 `Inbox.claim` 在每个边界先取全部 next-step
   * (steer) 再取 next-turn (followup)，因此跨轮次的完整认领序列就是
   * steers 在前、followups 在后。任务优先级即依赖这一顺序。
   */
  claimOrder(): unknown[]
}

/** 构造一个假 Agent；默认 cwd 指向工作区（`cwd: null` 则无工作区）。 */
export function makeAgent(id: SessionId, options: FakeAgentOptions = {}): FakeAgent {
  const followups: unknown[] = []
  const steers: unknown[] = []
  const ctx = options.ctx ?? ({
    get: (name: string): unknown => name === 'systemPrompt' ? { section: () => () => {} } : undefined,
  } as unknown as Context)
  return {
    id,
    status: options.status ?? 'running',
    session: {
      id,
      header: {
        ...(options.cwd === null ? {} : { cwd: options.cwd ?? WORKSPACE }),
        ...(options.origin !== undefined ? { origin: options.origin } : {}),
      },
      ...(options.events !== undefined ? { events: options.events } : {}),
    },
    ctx,
    followups,
    steers,
    followup: (message) => {
      followups.push(message)
    },
    steer: (message) => {
      steers.push(message)
    },
    cancel: () => {},
    claimOrder: () => [...steers, ...followups],
  }
}

/** 假 Agent 注册表：ctx.agents 的 get/list/resume 三面。 */
export class FakeAgentRegistry {
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

  resume(): never {
    throw new Error('wake/resume is not exercised in unit tests')
  }
}

/** 一个注册工作区的桩面：路径 + 该工作区下已知会话。 */
export interface FakeWorkspaceState {
  readonly path: string
  readonly sessionIds: SessionId[]
}

/** 最小工作区注册表桩：覆盖 resolveByPath / list / archivedSessionIds / archiveSession。 */
export class FakeWorkspaceRegistry {
  private readonly archived: SessionId[]

  constructor(
    private readonly workspaces: readonly FakeWorkspaceState[],
    archived: readonly SessionId[] = [],
  ) {
    this.archived = [...archived]
  }

  get archivedSessionIds(): readonly SessionId[] {
    return this.archived
  }

  async resolveByPath(path: string): Promise<{ path: string } | undefined> {
    return this.workspaces.find(workspace => workspace.path === path)
  }

  list(): readonly FakeWorkspaceState[] {
    return this.workspaces
  }

  archiveSession(sessionId: SessionId): Promise<void> {
    if (!this.archived.includes(sessionId)) this.archived.push(sessionId)
    return Promise.resolve()
  }
}

/** 与 index.ts apply() 相同的默认上限（测试钉住这些默认值本身）。 */
const DEFAULT_CONFIG: ToolsConfig = {
  maxContentLength: 16000,
  maxPendingPerAgent: 20,
  maxSendsPerMinute: 10,
  maxMessagesPerMinute: 20,
  maxInlineReport: 400,
}

export interface ToolHarnessOptions {
  readonly config?: Partial<ToolsConfig>
  readonly workspaces?: readonly FakeWorkspaceState[]
  readonly archived?: readonly SessionId[]
  /** Per-session title, read by send_note/create_task/reassign_task title resolution. */
  readonly titles?: Readonly<Record<string, string>>
}

/** 一个就绪的工具基座：真实 ledger + 捕获的工具定义 + 可执行调用的 run()。 */
export interface ToolHarness {
  readonly ledger: TaskLedger
  readonly config: ToolsConfig
  readonly tools: Map<string, ToolDefinition>
  readonly agents: FakeAgentRegistry
  readonly workspaces: FakeWorkspaceRegistry
  readonly limiter: DispatchRateLimiter
  readonly messageLimiter: DispatchRateLimiter
  /** 工具注册用的最小 ctx 桩（含 agents 注册表），供 notifySession/flush 等直测。 */
  readonly ctx: Context
  /** Register (or clear) a session's title, read by title-based target resolution. */
  setTitle(sessionId: SessionId, title: string | undefined): void
  /** 以 caller 身份调用已注册工具的真实 execute 体。 */
  run(name: string, args: unknown, callerId: SessionId): Promise<unknown>
  dispose(): Promise<void>
}

/**
 * 构造工具基座。默认工作区包含 A/B/REVIEWER 三个会话（后两者可作离线目标）。
 *
 * @param options - 配置覆盖、工作区与归档会话。
 * @returns 就绪的基座。
 */
export async function createToolHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  const base = await createMemoryCtx()
  const ledger = await TaskLedger.open(base.ctx)
  const config: ToolsConfig = { ...DEFAULT_CONFIG, ...options.config }
  const tools = new Map<string, ToolDefinition>()
  const agents = new FakeAgentRegistry()
  const registry = new FakeWorkspaceRegistry(
    options.workspaces ?? [{
      path: WORKSPACE,
      sessionIds: [SESSION_A, SESSION_B, SESSION_REVIEWER],
    }],
    options.archived,
  )
  const limiter = new DispatchRateLimiter(config.maxSendsPerMinute, 60_000)
  const messageLimiter = new DispatchRateLimiter(config.maxMessagesPerMinute, 60_000)
  // 标题面：title 解析走 session 上的 id(见 makeAgent)。缺省无标题。
  const titles = new Map(Object.entries(options.titles ?? {}))
  // 本套件不调用报告存储；桩保持类型兼容即可。
  const reports = {
    save: async () => '',
    read: async () => undefined,
    archive: async () => {},
    sweep: async () => 0,
  } as unknown as ReportStore
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    agents,
    sessionTitle: {
      get: (session: { id: SessionId }) => {
        const title = titles.get(String(session.id))
        return title === undefined ? undefined : { title }
      },
    },
    emit: () => {},
    get: () => undefined,
    effect: () => () => {},
  } as unknown as Context
  const deps: ToolsDeps = {
    ledger,
    workspaces: registry as unknown as WorkspaceRegistry,
    limiter,
    messageLimiter,
    reports,
    questions: new QuestionRegistry(),
    // 心跳活跃态冷却的记录面:单测不驱动 index.ts 的心跳,no-op 即可。
    noteActivity: () => {},
  }
  registerAgentBusTools(ctx, config, deps)
  return {
    ledger,
    config,
    tools,
    agents,
    workspaces: registry,
    limiter,
    messageLimiter,
    ctx,
    setTitle(sessionId, title) {
      if (title === undefined) titles.delete(String(sessionId))
      else titles.set(String(sessionId), title)
    },
    async run(name, args, callerId) {
      const def = tools.get(name)
      if (def === undefined) throw new Error(`tool "${name}" is not registered in the harness`)
      const caller = agents.get(callerId)
      if (caller === undefined) throw new Error(`session "${callerId}" is not a live harness agent`)
      return def.execute(args, { agent: caller as unknown as Agent } as unknown as ToolRunContext)
    },
    dispose: () => base.dispose(),
  }
}
