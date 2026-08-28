/**
 * TaskLedger 完整单测（T2）。覆盖 verification.md §1 的 ledger 行：
 * 状态机转换、queued 迁移与调度释放、依赖校验、DAG 失败传播、
 * edit/reassign 语义、交接文档、生命周期收尾、深度/内容上限。
 *
 * 核心逻辑全部跑在真实 in-memory 域上（T1 的 openLedger/createMemoryCtx），
 * 不 mock；仅调度派发路径 stub 了 harness 的 agent 注册表（投递边界，
 * 非 ledger 核心），用于驱动 dispatchOne 的 transition + recordDelivery +
 * 交接拼接全路径。
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  TaskLedger,
  blockedByOf,
  canTransition,
  detectCycle,
  isSettledSuccess,
  isTerminal,
  validateDependencies,
  type LedgerResult,
  type NewTask,
} from '../src/ledger/ledger.ts'
import { dispatchOne, dispatchReadyTasks, releaseDependents } from '../src/scheduler.ts'
import { admitContent } from '../src/delivery.ts'
import { TaskId, type TaskRecord } from '../src/domain/types.ts'
import {
  MemoryMediaPool,
} from '../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
  WORKSPACE,
  createMemoryCtx,
  makeNewTask,
  openLedger,
} from './helpers/memory-ctx.ts'

/** 断言一次 ledger 变更成功并返回新行。 */
function expectOk(result: LedgerResult): TaskRecord {
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`)
  return result.task
}

/** 失败的 LedgerResult 信息。 */
function messageOf(result: LedgerResult): string {
  if (result.ok) throw new Error('expected a refusal')
  return result.message
}

/** 一条被投递的消息（fake agent 捕获）。 */
interface Delivered {
  messageId: string
  text: string
}

/**
 * 带 stub agent 注册表的基座：ctx.agents.get 恒返回同一个 fake agent，
 * followup 捕获消息文本，供 dispatchOne/releaseDependents/dispatchReadyTasks
 * 走完整投递路径。
 */
async function schedulerHarness(pool?: MemoryMediaPool) {
  const base = await createMemoryCtx(pool)
  const delivered: Delivered[] = []
  const agent = {
    followup: (message: { id: string; content: { type: string; text: string }[] }) => {
      delivered.push({
        messageId: String(message.id),
        text: message.content.map(block => block.type === 'text' ? block.text : '').join(''),
      })
    },
  } as unknown as Agent
  base.ctx.provide('agents', {
    get: () => agent,
    list: () => [agent],
  } as never)
  const ledger = await TaskLedger.open(base.ctx)
  return { ...base, ledger, delivered }
}

const STATUSES = [
  'queued',
  'submitted',
  'working',
  'input-required',
  'auth-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const

/** 期望的合法迁移表（与 ledger.ts 的 ALLOWED_TRANSITIONS 一致）。 */
const LEGAL: Readonly<Record<string, readonly string[]>> = {
  queued: ['submitted', 'failed', 'canceled'],
  submitted: ['working', 'failed', 'canceled', 'queued'],
  working: ['completed', 'input-required', 'failed', 'canceled', 'submitted'],
  'input-required': ['working', 'failed', 'canceled'],
  'auth-required': [],
  completed: ['submitted'],
  failed: [],
  canceled: [],
  rejected: [],
}

describe('state machine transitions', () => {
  it('canTransition admits exactly the legal matrix', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(LEGAL[from]!.includes(to))
      }
    }
  })

  it('isTerminal flags exactly the terminal statuses', () => {
    for (const status of STATUSES) {
      expect(isTerminal(status), status).toBe(LEGAL[status]!.length === 0)
    }
    // completed is NOT terminal: a failure verdict sends it back to submitted.
    expect(isTerminal('completed')).toBe(false)
  })

  it('isSettledSuccess requires completed with a success verdict', () => {
    const base = { status: 'completed' as const, outcome: 'success' as const }
    expect(isSettledSuccess(base as TaskRecord)).toBe(true)
    expect(isSettledSuccess({ ...base, outcome: 'failure' } as TaskRecord)).toBe(false)
    expect(isSettledSuccess({ ...base, status: 'submitted' } as TaskRecord)).toBe(false)
    expect(isSettledSuccess({ ...base, outcome: undefined } as TaskRecord)).toBe(false)
  })

  it('transition() rejects an illegal target and an unknown id, naming both', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    await ledger.transition(TaskId('t1'), 'working')
    await ledger.transition(TaskId('t1'), 'completed')
    // completed → working is not in the matrix
    const illegal = await ledger.transition(TaskId('t1'), 'working')
    expect(messageOf(illegal)).toMatch(/completed; it cannot become working/)
    // unknown id
    const unknown = await ledger.transition(TaskId('ghost'), 'failed')
    expect(messageOf(unknown)).toMatch(/no such task/)
    // the row is unchanged by the rejections
    expect(ledger.get(TaskId('t1'))?.status).toBe('completed')
  })

  it('recordDelivery stamps the message identity and the auto flag without moving the status', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1') }), 8))
    const stamped = expectOk(await ledger.recordDelivery(TaskId('t1'), 'msg-1', true))
    expect(stamped.messageId).toBe('msg-1')
    expect(stamped.auto).toBe(true)
    expect(stamped.status).toBe('submitted')
    // unknown id
    expect((await ledger.recordDelivery(TaskId('ghost'), 'x')).ok).toBe(false)
  })

  it('walks the whole rework loop on one task id', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('loop') }), 8))
    await ledger.transition(TaskId('loop'), 'working')
    await ledger.transition(TaskId('loop'), 'completed', { report: 'attempt 1' })
    await ledger.settle(TaskId('loop'), 'failure', 'fix it')
    // rework: the same id is executable again
    expect(ledger.get(TaskId('loop'))?.status).toBe('submitted')
    await ledger.transition(TaskId('loop'), 'working')
    await ledger.transition(TaskId('loop'), 'completed', { report: 'attempt 2' })
    await ledger.settle(TaskId('loop'), 'success', undefined)
    const final = ledger.get(TaskId('loop'))!
    expect(final.status).toBe('completed')
    expect(final.outcome).toBe('success')
    expect(final.retries).toBe(1)
  })
})

describe('queued DAG migration and release', () => {
  it('creates a task with unsettled dependencies as queued, discarding any passed messageId', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('r1') }), 8))
    const child = expectOk(await ledger.record(makeNewTask({
      id: TaskId('c1'),
      dependencies: [TaskId('r1')],
      messageId: 'stale',
    }), 8))
    expect(child.status).toBe('queued')
    expect(ledger.get(TaskId('c1'))?.messageId).toBeUndefined()
    expect(blockedByOf(ledger.get(TaskId('c1'))!, ledger.listAll())).toEqual([TaskId('r1')])
  })

  it('creates a task whose dependencies are all settled as submitted, keeping the messageId', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('r1') }), 8))
    await ledger.transition(TaskId('r1'), 'working')
    await ledger.transition(TaskId('r1'), 'completed')
    await ledger.settle(TaskId('r1'), 'success', undefined)
    const child = expectOk(await ledger.record(makeNewTask({
      id: TaskId('c1'),
      dependencies: [TaskId('r1')],
      messageId: 'm1',
    }), 8))
    expect(child.status).toBe('submitted')
    expect(child.messageId).toBe('m1')
  })

  it('pendingReleases returns ready dependents in creation order, idempotently, and excludes blocked or dispatched rows', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('r1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('r2') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('c1'), dependencies: [TaskId('r1')] }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('c2'), dependencies: [TaskId('r1')] }), 8))
    await ledger.transition(TaskId('r1'), 'working')
    await ledger.transition(TaskId('r1'), 'completed')
    await ledger.settle(TaskId('r1'), 'success', undefined)
    expect(await ledger.pendingReleases(TaskId('r1'))).toEqual([TaskId('c1'), TaskId('c2')])
    // idempotent: the same set until a row leaves queued
    expect(await ledger.pendingReleases(TaskId('r1'))).toEqual([TaskId('c1'), TaskId('c2')])
    // a dependent still blocked by a second unsettled dependency is not released
    expectOk(await ledger.record(makeNewTask({
      id: TaskId('c3'),
      dependencies: [TaskId('r1'), TaskId('r2')],
    }), 8))
    expect(await ledger.pendingReleases(TaskId('r1'))).toEqual([TaskId('c1'), TaskId('c2')])
    // a dispatched row vanishes from the release set
    await ledger.transition(TaskId('c1'), 'submitted')
    expect(await ledger.pendingReleases(TaskId('r1'))).toEqual([TaskId('c2')])
    // an unsettled root releases nothing
    expect(await ledger.pendingReleases(TaskId('r2'))).toEqual([])
  })

  it('dispatchReadyTasks is a startup sweep: dispatches queued-unblocked tasks once, idempotently', async () => {
    const { ctx, ledger, delivered, dispose } = await schedulerHarness()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('r1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('c1'), dependencies: [TaskId('r1')] }), 8))
    await ledger.transition(TaskId('r1'), 'working')
    await ledger.transition(TaskId('r1'), 'completed')
    await ledger.settle(TaskId('r1'), 'success', undefined)
    const dispatched = await dispatchReadyTasks(ctx, ledger)
    expect(dispatched).toBe(1)
    const row = ledger.get(TaskId('c1'))!
    expect(row.status).toBe('submitted')
    expect(row.auto).toBe(true)
    expect(row.messageId).toBeDefined()
    // the delivery actually carried the relay header
    expect(delivered.some(d => d.text.includes('task="c1"') && d.text.includes('scheduler'))).toBe(true)
    // second sweep delivers nothing and does not change the message identity
    const again = await dispatchReadyTasks(ctx, ledger)
    expect(again).toBe(0)
    expect(ledger.get(TaskId('c1'))?.messageId).toBe(row.messageId)
    await dispose()
  })

  it('releaseDependents dispatches every ready dependent of a settled task', async () => {
    const { ctx, ledger, dispose } = await schedulerHarness()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('r1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('c1'), dependencies: [TaskId('r1')] }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('c2'), dependencies: [TaskId('r1')] }), 8))
    await ledger.transition(TaskId('r1'), 'working')
    await ledger.transition(TaskId('r1'), 'completed')
    await ledger.settle(TaskId('r1'), 'success', undefined)
    const count = await releaseDependents(ctx, ledger, TaskId('r1'))
    expect(count).toBe(2)
    expect(ledger.get(TaskId('c1'))?.status).toBe('submitted')
    expect(ledger.get(TaskId('c2'))?.status).toBe('submitted')
    await dispose()
  })

  it('restart recovery: queued rows survive reopen and the startup sweep dispatches them', async () => {
    const pool = new MemoryMediaPool()
    const first = await schedulerHarness(pool)
    // r1 带 messageId（已投递）→ 重开后仍是 submitted，不被 v1.4 迁移
    expectOk(await first.ledger.record(makeNewTask({ id: TaskId('r1'), messageId: 'm1' }), 8))
    expectOk(await first.ledger.record(makeNewTask({ id: TaskId('c1'), dependencies: [TaskId('r1')] }), 8))
    await first.dispose()

    const second = await schedulerHarness(pool)
    expect(second.ledger.get(TaskId('c1'))?.status).toBe('queued')
    expect(second.ledger.get(TaskId('r1'))?.status).toBe('submitted')
    await second.ledger.transition(TaskId('r1'), 'working')
    await second.ledger.transition(TaskId('r1'), 'completed')
    await second.ledger.settle(TaskId('r1'), 'success', undefined)
    const count = await dispatchReadyTasks(second.ctx, second.ledger)
    expect(count).toBe(1)
    expect(second.ledger.get(TaskId('c1'))?.status).toBe('submitted')
    expect(second.ledger.get(TaskId('c1'))?.auto).toBe(true)
    await second.dispose()
  })

  it('reopen migrates a pre-v7 submitted row without messageId to queued (v1.4 shape migration)', async () => {
    const pool = new MemoryMediaPool()
    const first = await createMemoryCtx(pool)
    const ledger = await TaskLedger.open(first.ctx)
    expectOk(await ledger.record(makeNewTask({ id: TaskId('legacy') }), 8))
    expect(ledger.get(TaskId('legacy'))?.status).toBe('submitted')
    await first.dispose()

    const second = await createMemoryCtx(pool)
    const reopened = await TaskLedger.open(second.ctx)
    expect(reopened.get(TaskId('legacy'))?.status).toBe('queued')
    await second.dispose()
  })

  it('dispatchOne skips an already-delivered or missing task', async () => {
    const { ctx, ledger, delivered, dispose } = await schedulerHarness()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    await dispatchOne(ctx, ledger, TaskId('t1')) // submitted, not queued → no-op
    expect(ledger.get(TaskId('t1'))?.messageId).toBe('m1')
    await dispatchOne(ctx, ledger, TaskId('ghost')) // missing → no-op
    expect(delivered).toHaveLength(0)
    await dispose()
  })
})

describe('dependency validation', () => {
  it('detectCycle accepts acyclic graphs and rejects cycles', () => {
    expect(detectCycle(new Map())).toBe(false)
    expect(detectCycle(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toBe(false)
    expect(detectCycle(new Map([['a', ['b']], ['b', ['a']]]))).toBe(true)
    expect(detectCycle(new Map([['a', ['a']]]))).toBe(true)
    expect(detectCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toBe(true)
  })

  it('rejects self, duplicate, unknown, cross-workspace, and cross-flow references', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('a') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('b'), flowId: 'flow-a' }), 8))
    const all = ledger.listAll()
    expect(validateDependencies(TaskId('c'), [TaskId('a')], all, WORKSPACE, 'flow-a')).toMatch(/flow/)
    expect(validateDependencies(TaskId('c'), [TaskId('c')], all, WORKSPACE)).toMatch(/cannot depend on itself/)
    expect(validateDependencies(TaskId('c'), [TaskId('a'), TaskId('a')], all, WORKSPACE)).toMatch(/duplicate/)
    expect(validateDependencies(TaskId('c'), [TaskId('ghost')], all, WORKSPACE)).toMatch(/unknown task/)
    expect(validateDependencies(TaskId('c'), [TaskId('a')], all, '/other-workspace')).toMatch(/another workspace/)
    // same-flow reference is accepted; empty/undefined pass
    expect(validateDependencies(TaskId('c'), [TaskId('b')], all, WORKSPACE, 'flow-a')).toBeNull()
    expect(validateDependencies(TaskId('c'), [], all, WORKSPACE)).toBeNull()
    expect(validateDependencies(TaskId('c'), undefined, all, WORKSPACE)).toBeNull()
  })

  it('rejects a dependency cycle through the edit path', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('a') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('b'), dependencies: [TaskId('a')] }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('c'), dependencies: [TaskId('b')] }), 8))
    // a → b would close a → b → c → ... a: rejected by editTask revalidation
    const cycle = await ledger.editTask(TaskId('a'), { dependencies: [TaskId('b')] })
    expect(messageOf(cycle)).toMatch(/dependency cycle/)
    expect(ledger.get(TaskId('a'))?.dependencies).toBeUndefined()
  })

  it('caps dependencies at 16 and rejects 17', async () => {
    const ledger = await openLedger()
    const ids: TaskId[] = []
    // 16 个前置任务都投给同一 recipient，cap 用 32 避免 pending 上限干扰依赖上限
    for (let i = 0; i < 16; i++) {
      expectOk(await ledger.record(makeNewTask({ id: TaskId(`dep-${i}`) }), 32))
      ids.push(TaskId(`dep-${i}`))
    }
    expectOk(await ledger.record(makeNewTask({ id: TaskId('at-limit'), dependencies: ids }), 32))
    const over = await ledger.record(makeNewTask({
      id: TaskId('over'),
      dependencies: [...ids, TaskId('extra')],
    }), 32)
    expect(messageOf(over)).toMatch(/at the 16 limit/)
  })
})

describe('DAG failure propagation', () => {
  it('fails a dependent chain recursively with dependency-failed, never dispatching it', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t2'), dependencies: [TaskId('t1')] }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t3'), dependencies: [TaskId('t2')] }), 8))
    await ledger.transition(TaskId('t1'), 'failed', { reason: 'timeout' })
    for (const id of ['t2', 't3']) {
      const row = ledger.get(TaskId(id))!
      expect(row.status).toBe('failed')
      expect(row.reason).toBe('dependency-failed')
      // never dispatched: no delivery identity
      expect(row.messageId).toBeUndefined()
    }
  })

  it('propagates dependency-canceled for a canceled root', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t2'), dependencies: [TaskId('t1')] }), 8))
    await ledger.transition(TaskId('t1'), 'canceled', { reason: 'dropped' })
    expect(ledger.get(TaskId('t2'))?.status).toBe('failed')
    expect(ledger.get(TaskId('t2'))?.reason).toBe('dependency-canceled')
  })

  it('waits for a still-active sibling dependency instead of failing early', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t2') }), 8))
    expectOk(await ledger.record(makeNewTask({
      id: TaskId('t3'),
      dependencies: [TaskId('t1'), TaskId('t2')],
    }), 8))
    await ledger.transition(TaskId('t1'), 'failed', { reason: 'timeout' })
    expect(ledger.get(TaskId('t3'))?.status).toBe('queued')
    await ledger.transition(TaskId('t2'), 'failed', { reason: 'timeout' })
    expect(ledger.get(TaskId('t3'))?.status).toBe('failed')
    expect(ledger.get(TaskId('t3'))?.reason).toBe('dependency-failed')
  })

  it('leaves a settled-success dependent untouched by failure propagation', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t2'), dependencies: [TaskId('t1')] }), 8))
    await ledger.transition(TaskId('t1'), 'working')
    await ledger.transition(TaskId('t1'), 'completed')
    await ledger.settle(TaskId('t1'), 'success', undefined)
    await ledger.transition(TaskId('t2'), 'submitted')
    await ledger.transition(TaskId('t2'), 'working')
    await ledger.transition(TaskId('t2'), 'completed', { report: 'done' })
    await ledger.settle(TaskId('t2'), 'success', undefined)
    // a NEW dependent of the settled-success row fails; the settled row is untouched
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t3'), dependencies: [TaskId('t2')] }), 8))
    await ledger.transition(TaskId('t3'), 'failed', { reason: 'timeout' })
    expect(ledger.get(TaskId('t2'))?.status).toBe('completed')
    expect(ledger.get(TaskId('t2'))?.outcome).toBe('success')
  })

  it('a terminal failure with no dependents propagates nothing', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('solo') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('other') }), 8))
    await ledger.transition(TaskId('solo'), 'failed', { reason: 'timeout' })
    expect(ledger.get(TaskId('solo'))?.status).toBe('failed')
    expect(ledger.get(TaskId('other'))?.status).toBe('submitted')
  })
})

describe('edit_task semantics', () => {
  it('edits content and acceptance criteria of an undispatched task, leaving the rest intact', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1') }), 8))
    const edited = await ledger.editTask(TaskId('t1'), {
      content: 'rewritten requirement',
      acceptanceCriteria: 'stricter criteria',
    })
    expectOk(edited)
    const row = ledger.get(TaskId('t1'))!
    expect(row.content).toBe('rewritten requirement')
    expect(row.acceptanceCriteria).toBe('stricter criteria')
    expect(row.title).toBe('Do the thing')
    expect(row.assignedTo).toBe(SESSION_B)
  })

  it('revalidates dependencies on a dependency or flow edit and rejects a cycle', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('a') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('b'), dependencies: [TaskId('a')] }), 8))
    // valid dependency edit
    const depEdit = await ledger.editTask(TaskId('b'), { dependencies: [TaskId('a')] })
    expectOk(depEdit)
    // cycle edit rejected
    const cycle = await ledger.editTask(TaskId('a'), { dependencies: [TaskId('b')] })
    expect(messageOf(cycle)).toMatch(/cycle/)
  })

  it('rejects editing a delivered or running task', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('delivered'), messageId: 'm1' }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('running'), messageId: 'm2' }), 8))
    await ledger.transition(TaskId('running'), 'working')
    expect(messageOf(await ledger.editTask(TaskId('delivered'), { content: 'x' }))).toMatch(/already delivered/)
    expect(messageOf(await ledger.editTask(TaskId('running'), { content: 'x' }))).toMatch(/only an undispatched task/)
    expect(ledger.get(TaskId('delivered'))?.content).toBe('do the thing')
  })

  it('rejects editing an unknown task', async () => {
    const ledger = await openLedger()
    expect(messageOf(await ledger.editTask(TaskId('ghost'), { content: 'x' }))).toMatch(/no such task/)
  })
})

describe('reassign semantics', () => {
  it('moves the executor, voiding the old delivery, and preserves id, history, deps, and flow', async () => {
    const ledger = await openLedger()
    const flow = await ledger.createFlow('flow-1', 'Flow', 'desc', SESSION_A, WORKSPACE)
    expectOk(await ledger.record(makeNewTask({ id: TaskId('dep-1'), flowId: flow.id }), 8))
    expectOk(await ledger.record(makeNewTask({
      id: TaskId('t1'),
      dependencies: [TaskId('dep-1')],
      flowId: flow.id,
    }), 8))
    // t1 is queued (dep-1 unsettled); reassign the executor
    const reassigned = await ledger.reassign(TaskId('t1'), { executor: SESSION_REVIEWER })
    expectOk(reassigned)
    const row = ledger.get(TaskId('t1'))!
    expect(row.assignedTo).toBe(SESSION_REVIEWER)
    expect(row.dependencies).toEqual([TaskId('dep-1')])
    expect(row.flowId).toBe(flow.id)
    expect(row.id).toBe(TaskId('t1'))
  })

  it('clears the delivery identity and token snapshot on an executor change of a working task', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({
      id: TaskId('t1'),
      messageId: 'm1',
      tokensAtStart: { [SESSION_B]: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    }), 8))
    await ledger.transition(TaskId('t1'), 'working')
    expect(ledger.findByMessage('m1')?.id).toBe(TaskId('t1'))
    const reassigned = expectOk(await ledger.reassign(TaskId('t1'), { executor: SESSION_REVIEWER }))
    const row = ledger.get(TaskId('t1'))!
    expect(row.messageId).toBeUndefined()
    expect(row.tokensAtStart).toBeUndefined()
    expect(row.turn).toBeUndefined()
    // the old delivery no longer resolves to the task
    expect(ledger.findByMessage('m1')).toBeUndefined()
    // createdAt history preserved
    expect(row.createdAt).toBe(reassigned.createdAt)
  })

  it('moves the reviewer without touching the executor or delivery', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    const reassigned = await ledger.reassign(TaskId('t1'), { reviewer: SESSION_REVIEWER })
    expectOk(reassigned)
    const row = ledger.get(TaskId('t1'))!
    expect(row.assignedReviewer).toBe(SESSION_REVIEWER)
    expect(row.assignedTo).toBe(SESSION_B)
    expect(row.messageId).toBe('m1')
  })

  it('rejects reassigning a settled task or an unknown id', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('done'), messageId: 'm1' }), 8))
    await ledger.transition(TaskId('done'), 'working')
    await ledger.transition(TaskId('done'), 'completed', { report: 'r' })
    expect(messageOf(await ledger.reassign(TaskId('done'), { executor: SESSION_REVIEWER })))
      .toMatch(/only an unsettled task/)
    expect(messageOf(await ledger.reassign(TaskId('ghost'), { executor: SESSION_REVIEWER })))
      .toMatch(/no such task/)
  })
})

describe('handoff documents', () => {
  it('appends handoffs in arrival order and reads them back', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('a') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('b'), dependencies: [TaskId('a')] }), 8))
    const first = await ledger.appendHandoff(TaskId('b'), {
      fromTask: TaskId('a'),
      document: 'first doc',
      at: '2026-08-01T00:00:00.000Z',
    })
    expectOk(first)
    await ledger.appendHandoff(TaskId('b'), {
      fromTask: TaskId('a'),
      document: 'second doc',
      at: '2026-08-02T00:00:00.000Z',
    })
    expect(ledger.handoffsFor(TaskId('b')).map(handoff => handoff.document))
      .toEqual(['first doc', 'second doc'])
    expect(ledger.handoffsFor(TaskId('a'))).toEqual([])
    expect(messageOf(await ledger.appendHandoff(TaskId('ghost'), {
      fromTask: TaskId('a'),
      document: 'x',
      at: '2026-08-01T00:00:00.000Z',
    }))).toMatch(/no such task/)
  })

  it('concatenates handoff documents into the delivered content on dispatch', async () => {
    const { ctx, ledger, delivered, dispose } = await schedulerHarness()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1') }), 8))
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t2'), dependencies: [TaskId('t1')] }), 8))
    await ledger.transition(TaskId('t1'), 'completed')
    await ledger.settle(TaskId('t1'), 'success', undefined)
    await ledger.appendHandoff(TaskId('t2'), {
      fromTask: TaskId('t1'),
      document: 'handoff doc text',
      at: '2026-08-01T00:00:00.000Z',
    })
    await dispatchOne(ctx, ledger, TaskId('t2'))
    const taskDelivery = delivered.find(item => item.text.includes('handoff doc text'))
    expect(taskDelivery).toBeDefined()
    expect(taskDelivery!.text).toContain('【前置任务交接文档】')
    expect(taskDelivery!.text).toContain('来自 t1:')
    expect(ledger.get(TaskId('t2'))?.status).toBe('submitted')
    expect(ledger.get(TaskId('t2'))?.auto).toBe(true)
    await dispose()
  })
})

describe('lifecycle closure', () => {
  it('settle failure returns the SAME task to submitted, bumps retries, writes feedback, clears report/turn', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    await ledger.transition(TaskId('t1'), 'working')
    await ledger.transition(TaskId('t1'), 'completed', { report: 'my report', turn: 1 })
    const settled = await ledger.settle(TaskId('t1'), 'failure', 'rework it')
    expectOk(settled)
    const row = ledger.get(TaskId('t1'))!
    expect(row.id).toBe(TaskId('t1'))
    expect(row.status).toBe('submitted')
    expect(row.retries).toBe(1)
    expect(row.feedback).toBe('rework it')
    expect(row.outcome).toBe('failure')
    expect(row.report).toBeUndefined()
    expect(row.turn).toBeUndefined()
  })

  it('settle success keeps the row completed with the verdict and optional feedback', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    await ledger.transition(TaskId('t1'), 'working')
    await ledger.transition(TaskId('t1'), 'completed', { report: 'r' })
    const settled = await ledger.settle(TaskId('t1'), 'success', 'nice')
    expectOk(settled)
    const row = ledger.get(TaskId('t1'))!
    expect(row.status).toBe('completed')
    expect(row.outcome).toBe('success')
    expect(row.feedback).toBe('nice')
    expect(row.retries).toBe(0)
    expect(row.report).toBe('r')
  })

  it('settle rejects a non-completed task', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    expect(messageOf(await ledger.settle(TaskId('t1'), 'success', undefined)))
      .toMatch(/only a completed task/)
    expect(messageOf(await ledger.settle(TaskId('ghost'), 'success', undefined)))
      .toMatch(/no such task/)
  })

  it('timeout, no-response, and discarded all route to failed with their reasons', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    await ledger.transition(TaskId('t1'), 'working')
    await ledger.transition(TaskId('t1'), 'failed', { reason: 'timeout' })
    expect(ledger.get(TaskId('t1'))?.reason).toBe('timeout')

    expectOk(await ledger.record(makeNewTask({ id: TaskId('t2'), messageId: 'm2' }), 8))
    await ledger.transition(TaskId('t2'), 'working')
    await ledger.transition(TaskId('t2'), 'input-required', { question: 'q?' })
    await ledger.transition(TaskId('t2'), 'failed', { reason: 'no-response' })
    expect(ledger.get(TaskId('t2'))?.status).toBe('failed')
    expect(ledger.get(TaskId('t2'))?.reason).toBe('no-response')

    expectOk(await ledger.record(makeNewTask({ id: TaskId('t3'), messageId: 'm3' }), 8))
    await ledger.transition(TaskId('t3'), 'failed', { reason: 'discarded' })
    expect(ledger.get(TaskId('t3'))?.reason).toBe('discarded')
  })

  it('cancel marks the row canceled and attachReport appends a summary without moving the status', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 8))
    await ledger.transition(TaskId('t1'), 'working')
    const canceled = await ledger.transition(TaskId('t1'), 'canceled', { reason: 'scope dropped' })
    expectOk(canceled)
    expect(ledger.get(TaskId('t1'))?.reason).toBe('scope dropped')
    const summary = await ledger.attachReport(TaskId('t1'), 'partial work summary')
    expectOk(summary)
    const row = ledger.get(TaskId('t1'))!
    expect(row.status).toBe('canceled')
    expect(row.report).toBe('partial work summary')
  })
})

describe('queue depth and content limits', () => {
  it('rejects a task when the recipient already has maxPending unfinished tasks', async () => {
    const ledger = await openLedger()
    for (let i = 0; i < 3; i++) {
      expectOk(await ledger.record(makeNewTask({ id: TaskId(`p${i}`), messageId: `m${i}` }), 3))
    }
    const refused = await ledger.record(makeNewTask({ id: TaskId('p3') }), 3)
    expect(messageOf(refused)).toMatch(/already has 3 unfinished tasks, at the 3 limit/)
    // a different recipient is unaffected
    expectOk(await ledger.record(makeNewTask({ id: TaskId('other'), assignedTo: SESSION_A }), 3))
    expect(ledger.get(TaskId('p3'))).toBeUndefined()
  })

  it('counts only unfinished statuses toward the cap: queued rows do not block', async () => {
    const ledger = await openLedger()
    // root 投给 A，避免污染 SESSION_B 的 pending 计数
    expectOk(await ledger.record(makeNewTask({ id: TaskId('root'), assignedTo: SESSION_A }), 8))
    for (let i = 0; i < 3; i++) {
      expectOk(await ledger.record(makeNewTask({ id: TaskId(`p${i}`), messageId: `m${i}` }), 4))
    }
    // 准入时 3 个 unfinished < 4，queued 行得以创建
    const queued = expectOk(await ledger.record(makeNewTask({
      id: TaskId('q1'),
      dependencies: [TaskId('root')],
    }), 4))
    expect(queued.status).toBe('queued')
    // queued 不计入 unfinished：第 4 个 submitted 仍能通过 cap(4)
    expectOk(await ledger.record(makeNewTask({ id: TaskId('p3'), messageId: 'm3' }), 4))
    // 现在 4 个 unfinished：第 5 个被拒
    expect(messageOf(await ledger.record(makeNewTask({ id: TaskId('p4') }), 4)))
      .toMatch(/already has 4 unfinished/)
    // queued 行仍在（未被误拒）
    expect(ledger.get(TaskId('q1'))?.status).toBe('queued')
  })

  it('a drained queue accepts a new task', async () => {
    const ledger = await openLedger()
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t1'), messageId: 'm1' }), 1))
    await ledger.transition(TaskId('t1'), 'working')
    await ledger.transition(TaskId('t1'), 'completed', { report: 'r' })
    expectOk(await ledger.record(makeNewTask({ id: TaskId('t2'), messageId: 'm2' }), 1))
  })

  it('refuses empty and over-limit titles instead of truncating; exactly 20 passes', async () => {
    const ledger = await openLedger()
    expect(messageOf(await ledger.record(makeNewTask({ id: TaskId('e1'), title: '   ' }), 8)))
      .toMatch(/title is required/)
    expect(messageOf(await ledger.record(makeNewTask({ id: TaskId('e2'), title: 'x'.repeat(21) }), 8)))
      .toMatch(/over the 20 limit/)
    const atLimit = expectOk(await ledger.record(makeNewTask({ id: TaskId('e3'), title: 'x'.repeat(20) }), 8))
    expect(atLimit.title).toBe('x'.repeat(20))
  })

  it('admitContent refuses over-limit content at the exact boundary, never truncating', () => {
    expect(admitContent('x'.repeat(400), 400).ok).toBe(true)
    const over = admitContent('x'.repeat(401), 400)
    expect(over.ok).toBe(false)
    expect(admitContent('   ', 400).ok).toBe(false)
    // control bytes are stripped before the length check
    expect(admitContent('\u001b[31mplain\u001b[0m', 400).ok).toBe(true)
  })
})

describe('flows and peer cards', () => {
  it('creates and lists flows in creation order, reading one back', async () => {
    const ledger = await openLedger()
    const first = await ledger.createFlow('f1', 'First', undefined, SESSION_A, WORKSPACE)
    const second = await ledger.createFlow('f2', 'Second', 'desc', SESSION_B, WORKSPACE)
    expect(first.description).toBeUndefined()
    expect(second.description).toBe('desc')
    expect(ledger.listFlows().map(flow => flow.id)).toEqual(['f1', 'f2'])
    expect(ledger.getFlow('f1')?.name).toBe('First')
    expect(ledger.getFlow('ghost')).toBeUndefined()
  })

  it('puts and reads peer cards wholesale', async () => {
    const ledger = await openLedger()
    expect(ledger.getCard(SESSION_A)).toBeUndefined()
    await ledger.putCard(SESSION_A, {
      description: 'hello',
      capabilities: [{ id: 'code', label: 'Coding' }],
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
    expect(ledger.getCard(SESSION_A)?.description).toBe('hello')
    expect(ledger.getCard(SESSION_A)?.capabilities).toEqual([{ id: 'code', label: 'Coding' }])
    // wholesale replacement
    await ledger.putCard(SESSION_A, { description: 'bye', capabilities: [], updatedAt: '2026-08-02T00:00:00.000Z' })
    expect(ledger.getCard(SESSION_A)).toEqual({
      description: 'bye',
      capabilities: [],
      updatedAt: '2026-08-02T00:00:00.000Z',
    })
  })
})

describe('manual archive (decision 12)', () => {
  it('archives and unarchives a task, toggling the persisted marker', async () => {
    const ledger = await openLedger()
    const created = expectOk(await ledger.record(makeNewTask({ id: TaskId('ta-1') }), 8))
    expect(created.archived).toBeUndefined()
    const archived = expectOk(await ledger.archiveTask(TaskId('ta-1'), true))
    expect(archived.archived).toBe(true)
    const unarchived = expectOk(await ledger.archiveTask(TaskId('ta-1'), false))
    expect(unarchived.archived).toBe(false)
  })

  it('archiving is reversible and never touches the lifecycle status', async () => {
    const ledger = await openLedger()
    await ledger.record(makeNewTask({ id: TaskId('ta-2') }), 8)
    await ledger.transition(TaskId('ta-2'), 'working')
    const archived = expectOk(await ledger.archiveTask(TaskId('ta-2'), true))
    expect(archived.status).toBe('working')
    expect(archived.archived).toBe(true)
  })

  it('refuses to archive an unknown task', async () => {
    const ledger = await openLedger()
    expect(messageOf(await ledger.archiveTask(TaskId('ghost'), true))).toMatch(/no such task/)
  })

  it('archives and unarchives a flow, toggling the persisted marker', async () => {
    const ledger = await openLedger()
    await ledger.createFlow('fa-1', 'Flow A', undefined, SESSION_A, WORKSPACE)
    const archived = await ledger.archiveFlow('fa-1', true)
    if (!archived.ok) throw new Error(archived.message)
    expect(archived.flow.archived).toBe(true)
    const unarchived = await ledger.archiveFlow('fa-1', false)
    if (!unarchived.ok) throw new Error(unarchived.message)
    expect(unarchived.flow.archived).toBe(false)
  })

  it('refuses to archive an unknown flow', async () => {
    const ledger = await openLedger()
    const result = await ledger.archiveFlow('ghost', true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/no such flow/)
  })
})

describe('offline note rows', () => {
  it('queues, lists (oldest first), bumps attempts, and deletes pending notes', async () => {
    const ledger = await openLedger()
    await ledger.queueNote({
      id: 'n1',
      sender: SESSION_A,
      recipient: SESSION_B,
      content: 'hello',
      sentAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      attempts: 0,
    })
    await ledger.queueNote({
      id: 'n2',
      sender: SESSION_A,
      recipient: SESSION_B,
      content: 'later',
      sentAt: '2026-08-02T00:00:00.000Z',
      createdAt: '2026-08-02T00:00:00.000Z',
      attempts: 0,
    })
    expect(ledger.listPendingNotes().map(note => note.id)).toEqual(['n1', 'n2'])
    await ledger.markNoteAttempt('n1', 2)
    expect(ledger.listPendingNotes()[0]?.attempts).toBe(2)
    await ledger.deleteNote('n1')
    expect(ledger.listPendingNotes().map(note => note.id)).toEqual(['n2'])
    // unknown id: no-op
    await ledger.markNoteAttempt('ghost', 3)
    await ledger.deleteNote('ghost')
    expect(ledger.listPendingNotes().map(note => note.id)).toEqual(['n2'])
  })
})

describe('batch ledger (report 4.2)', () => {
  it('createBatch stores a header; getBatch reads it back and an unknown id yields undefined', async () => {
    const ledger = await openLedger()
    const batch = await ledger.createBatch('b1', 'Batch A', SESSION_A, WORKSPACE)
    expect(batch.id).toBe('b1')
    expect(batch.name).toBe('Batch A')
    expect(batch.createdBy).toBe(SESSION_A)
    expect(batch.workspacePath).toBe(WORKSPACE)
    expect(ledger.getBatch('b1')?.name).toBe('Batch A')
    expect(ledger.getBatch('ghost')).toBeUndefined()
  })

  it('listBatches filters by workspace and preserves creation order', async () => {
    const ledger = await openLedger()
    await ledger.createBatch('b1', 'First', SESSION_A, WORKSPACE)
    await ledger.createBatch('b2', 'Second', SESSION_A, WORKSPACE)
    await ledger.createBatch('b3', 'Other', SESSION_A, '/elsewhere')
    expect(ledger.listBatches(WORKSPACE).map(batch => batch.id)).toEqual(['b1', 'b2'])
    expect(ledger.listBatches('/elsewhere').map(batch => batch.id)).toEqual(['b3'])
  })

  it('a task recorded with a batchId persists the membership field', async () => {
    const ledger = await openLedger()
    const created = await ledger.record(makeNewTask({ id: TaskId('bt-1'), batchId: 'b1' }), 8)
    expectOk(created)
    expect(ledger.get(TaskId('bt-1'))?.batchId).toBe('b1')
  })
})
