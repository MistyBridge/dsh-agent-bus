/**
 * scheduler.ts 启动恢复扫描单测(决策10 B 部分)。
 *
 * 覆盖:
 * - resumeStrandedTasks 唤醒 dormant 执行者并投递一条恢复通知
 * - 同一执行者的多个滞留任务只收一条通知(按 session 聚合)
 * - live 执行者不被触碰(正在跑,非滞留)
 * - 无法唤醒的执行者维持现状(不报错,offlineGrace 兜底)
 * - 终态与 queued 任务不触发恢复
 *
 * @module tests/scheduler
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TaskId } from '../src/domain/types.ts'
import { resumeStrandedTasks } from '../src/scheduler.ts'
import { TaskLedger } from '../src/ledger/ledger.ts'
import {
  createMemoryCtx,
  makeNewTask,
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
  type LedgerContext,
} from './helpers/memory-ctx.ts'

// wakeSession 是 ESM 命名导出,不能 spy;用模块级 mock 替换实现。
// 测试基座里没有真实 agents 注册表,唤醒结果由各用例的 wakeResults 表驱动。
const wakeResults = new Map<string, Agent | undefined>()
vi.mock('../src/members/wake.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/members/wake.ts')>()
  return {
    ...actual,
    wakeSession: async (_ctx: Context, id: SessionId): Promise<Agent | undefined> =>
      wakeResults.get(String(id)),
  }
})

/** 记录 followup 收到的消息。 */
interface FakeInbox {
  readonly messages: string[]
}

/** 构造一个最小 fake agent(仅 followup 面)。消息以对象传入,提取首个 text 块。 */
function fakeAgent(id: SessionId, inbox: FakeInbox): Agent {
  return {
    id,
    session: { id } as Agent['session'],
    followup: vi.fn(async (content: unknown) => {
      const record = content as { content?: unknown[] }
      const first = record.content?.[0] as { type?: string; text?: unknown } | undefined
      const text = first?.type === 'text' ? String(first.text ?? '') : ''
      inbox.messages.push(text)
      return 'msg-1'
    }),
  } as unknown as Agent
}

/** 构造一个 fake ctx:agents(仅 get 面)。live 表决定「执行者是否在线」。 */
function ctxWithAgents(live: Map<string, Agent>): Context {
  const ctx = new Context()
  ctx.provide('agents', {
    get: (id: string): Agent | undefined => live.get(String(id)),
  } as never)
  return ctx
}

/** 打开 ledger + harness(harness 提供 dispose 清理内存后端)。 */
async function openHarness(): Promise<{ ledger: TaskLedger; harness: LedgerContext }> {
  const harness = await createMemoryCtx()
  const ledger = await TaskLedger.open(harness.ctx)
  return { ledger, harness }
}

/** 创建一条任务并转移到指定状态。queued 用未结算依赖直接创建。 */
async function seedTask(
  ledger: TaskLedger,
  id: string,
  status: 'working' | 'submitted' | 'input-required' | 'completed' | 'canceled' | 'queued',
  overrides: Partial<Parameters<typeof makeNewTask>[0]> = {},
): Promise<void> {
  if (status === 'queued') {
    // 真 queued:先建一个未结算的依赖行(执行者非本用例的 worker,唤醒失败→跳过),
    // 再建依赖它的任务 → record 写成 queued。
    const dep = await ledger.record(
      makeNewTask({ id: TaskId('missing-dep'), assignedTo: SESSION_REVIEWER }),
      20,
    )
    if (!dep.ok) throw new Error(`seed failed: ${dep.message}`)
    const blocked = await ledger.record(
      makeNewTask({ id: TaskId(id), dependencies: [TaskId('missing-dep')], ...overrides }),
      20,
    )
    if (!blocked.ok) throw new Error(`seed failed: ${blocked.message}`)
    return
  }
  const created = await ledger.record(makeNewTask({ id: TaskId(id), ...overrides }), 20)
  if (!created.ok) throw new Error(`seed failed: ${created.message}`)
  if (status === 'submitted') return
  if (status === 'completed') {
    await ledger.transition(TaskId(id), 'working')
    await ledger.transition(TaskId(id), 'completed')
    return
  }
  if (status === 'canceled') {
    await ledger.transition(TaskId(id), 'canceled')
    return
  }
  await ledger.transition(TaskId(id), status)
}

describe('resumeStrandedTasks', () => {
  it('wakes a dormant executor and delivers exactly one recovery notice', async () => {
    wakeResults.clear()
    const { ledger, harness } = await openHarness()
    const inbox: FakeInbox = { messages: [] }
    const woken = fakeAgent(SESSION_B, inbox)
    wakeResults.set(String(SESSION_B), woken)
    await seedTask(ledger, 'task-1', 'working')
    const ctx = ctxWithAgents(new Map())

    const count = await resumeStrandedTasks(ctx, ledger)
    expect(count).toBe(1)
    expect(inbox.messages).toHaveLength(1)
    expect(inbox.messages[0]).toContain('系统恢复通知')
    expect(inbox.messages[0]).toContain('task-1')
    await harness.dispose()
  })

  it('aggregates multiple stranded tasks of one worker into a single notice', async () => {
    wakeResults.clear()
    const { ledger, harness } = await openHarness()
    const inbox: FakeInbox = { messages: [] }
    const woken = fakeAgent(SESSION_B, inbox)
    wakeResults.set(String(SESSION_B), woken)
    await seedTask(ledger, 'task-1', 'working')
    await seedTask(ledger, 'task-2', 'submitted')
    await seedTask(ledger, 'task-3', 'input-required')
    const ctx = ctxWithAgents(new Map())

    const count = await resumeStrandedTasks(ctx, ledger)
    expect(count).toBe(1) // 一名 worker,尽管有 3 个滞留任务
    expect(inbox.messages).toHaveLength(1)
    await harness.dispose()
  })

  it('leaves a live executor untouched', async () => {
    wakeResults.clear()
    const { ledger, harness } = await openHarness()
    const inbox: FakeInbox = { messages: [] }
    const live = fakeAgent(SESSION_B, inbox)
    wakeResults.set(String(SESSION_B), live)
    await seedTask(ledger, 'task-1', 'working')
    const ctx = ctxWithAgents(new Map([[String(SESSION_B), live]]))

    const count = await resumeStrandedTasks(ctx, ledger)
    expect(count).toBe(0)
    expect(inbox.messages).toHaveLength(0)
    await harness.dispose()
  })

  it('skips a task whose executor cannot be woken without failing', async () => {
    wakeResults.clear()
    const { ledger, harness } = await openHarness()
    wakeResults.set(String(SESSION_B), undefined)
    await seedTask(ledger, 'task-1', 'working')
    const ctx = ctxWithAgents(new Map())

    const count = await resumeStrandedTasks(ctx, ledger)
    expect(count).toBe(0) // 唤醒失败 → 维持现状,不报错
    await harness.dispose()
  })

  it('ignores terminal and queued tasks', async () => {
    wakeResults.clear()
    const { ledger, harness } = await openHarness()
    const inbox: FakeInbox = { messages: [] }
    const woken = fakeAgent(SESSION_B, inbox)
    wakeResults.set(String(SESSION_B), woken)
    await seedTask(ledger, 'task-done', 'completed')
    await seedTask(ledger, 'task-queued', 'queued')
    await seedTask(ledger, 'task-canceled', 'canceled')
    const ctx = ctxWithAgents(new Map())

    const count = await resumeStrandedTasks(ctx, ledger)
    expect(count).toBe(0)
    expect(inbox.messages).toHaveLength(0)
    await harness.dispose()
  })

  it('wakes two different executors with one notice each', async () => {
    wakeResults.clear()
    const { ledger, harness } = await openHarness()
    const inboxA: FakeInbox = { messages: [] }
    const inboxB: FakeInbox = { messages: [] }
    const wokenA = fakeAgent(SESSION_A, inboxA)
    const wokenB = fakeAgent(SESSION_B, inboxB)
    wakeResults.set(String(SESSION_A), wokenA)
    wakeResults.set(String(SESSION_B), wokenB)
    await seedTask(ledger, 'task-a', 'working', { assignedTo: SESSION_A })
    await seedTask(ledger, 'task-b', 'input-required', { assignedTo: SESSION_B })
    const ctx = ctxWithAgents(new Map())

    const count = await resumeStrandedTasks(ctx, ledger)
    expect(count).toBe(2)
    expect(inboxA.messages).toHaveLength(1)
    expect(inboxB.messages).toHaveLength(1)
    await harness.dispose()
  })
})
