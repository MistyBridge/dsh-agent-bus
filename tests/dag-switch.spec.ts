/**
 * DAG 持久开关(dag-switch,module-map §4)单测。
 *
 * 覆盖三块:
 * - 解析器(parseSetDagStateInput):dag 必填、只接受 'running'|'paused'。
 * - 编排(setDagState 走 mock HostPort):写持久开关;mode==='running' 时调
 *   resume 补投;写失败时抛错。
 * - 行为(真实 in-memory ledger + 工具基座):paused 时 dispatchOne 短路返回
 *   dag-paused(任务保持 queued、零副作用);dispatchReadyTasks 暂停时返 0;
 *   set_dag_state 工具 paused 后新建任务不投递,恢复 running 自动补投。
 *
 * @module tests/dag-switch
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TaskId } from '../src/domain/types.ts'
import { TaskLedger, type DagResult } from '../src/ledger/ledger.ts'
import { dispatchOne, dispatchReadyTasks } from '../src/scheduler.ts'
import {
  parseSetDagStateInput,
  setDagState,
  type SetDagStateHost,
  type SetDagStatePlan,
} from '../src/tools/dag-switch.ts'
import {
  createMemoryCtx,
  makeNewTask,
  SESSION_A,
  SESSION_B,
  WORKSPACE,
} from './helpers/memory-ctx.ts'
import { createToolHarness, makeAgent } from './helpers/tool-harness.ts'

describe('parseSetDagStateInput', () => {
  it('refuses non-object input', () => {
    for (const raw of ['x', 42, null, [1]]) {
      const result = parseSetDagStateInput(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('JSON object')
    }
  })

  it('refuses a missing or invalid dag value, naming the field', () => {
    for (const raw of [{}, { dag: 'off' }, { dag: 1 }]) {
      const result = parseSetDagStateInput(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('"dag"')
    }
  })

  it('accepts running and paused', () => {
    for (const dag of ['running', 'paused'] as const) {
      const result = parseSetDagStateInput({ dag })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.plan).toEqual({ dag })
    }
  })
})

describe('setDagState (orchestrator)', () => {
  function makeHost(overrides: Partial<SetDagStateHost> = {}) {
    const setDagState = vi.fn(async (mode: 'running' | 'paused'): Promise<DagResult> =>
      ({ ok: true, dag: mode }))
    const resume = vi.fn(async () => 3)
    const host: SetDagStateHost = { ledger: { setDagState } as never, resume, ...overrides }
    return { host, setDagState, resume }
  }

  it('sets paused without running the resume sweep', async () => {
    const m = makeHost()
    const result = await setDagState(m.host, { dag: 'paused' })
    expect(m.setDagState).toHaveBeenCalledWith('paused')
    expect(m.resume).not.toHaveBeenCalled()
    expect(result).toEqual({ dag: 'paused', resumed: 0 })
  })

  it('sets running and runs the resume sweep, returning the caught-up count', async () => {
    const m = makeHost()
    const result = await setDagState(m.host, { dag: 'running' })
    expect(m.resume).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ dag: 'running', resumed: 3 })
  })

  it('propagates a ledger write failure', async () => {
    const m = makeHost()
    m.setDagState.mockResolvedValueOnce({ ok: false, message: 'write failed' })
    await expect(setDagState(m.host, { dag: 'paused' } as SetDagStatePlan))
      .rejects.toThrow(/write failed/)
  })
})

describe('dispatchOne / dispatchReadyTasks respect the DAG switch', () => {
  it('returns dag-paused for a queued task while the switch is paused, staying queued', async () => {
    const h = await createMemoryCtx()
    const ledger = await TaskLedger.open(h.ctx)
    try {
      // A task with an unsettled dependency is queued (blocked); pausing makes
      // dispatchOne refuse before any wake or message build. The dependency
      // must exist (validateDependencies rejects unknown references).
      await ledger.record(makeNewTask({ id: TaskId('dep1') }), 20)
      await ledger.record(
        makeNewTask({ id: TaskId('t1'), dependencies: [TaskId('dep1')] }),
        20,
      )
      expect(ledger.get(TaskId('t1'))?.status).toBe('queued')
      await ledger.setDagState('paused')
      const outcome = await dispatchOne({} as Context, ledger, TaskId('t1'))
      expect(outcome).toEqual({ dispatched: false, reason: 'dag-paused' })
      expect(ledger.get(TaskId('t1'))?.status).toBe('queued')
    } finally {
      await h.dispose()
    }
  })

  it('dispatchReadyTasks reports zero while paused', async () => {
    const h = await createMemoryCtx()
    const ledger = await TaskLedger.open(h.ctx)
    try {
      await ledger.record(makeNewTask({ id: TaskId('dep1') }), 20)
      await ledger.record(
        makeNewTask({ id: TaskId('t1'), dependencies: [TaskId('dep1')] }),
        20,
      )
      await ledger.setDagState('paused')
      const dispatched = await dispatchReadyTasks({} as Context, ledger)
      expect(dispatched).toBe(0)
    } finally {
      await h.dispose()
    }
  })
})

describe('set_dag_state tool (real harness)', () => {
  it('suppresses new deliveries while paused and catches them up on resume', async () => {
    const harness = await createToolHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    try {
      // running: a task dispatches immediately.
      const first = await harness.run('create_task', {
        target: String(SESSION_B),
        content: 'first',
        title: 'First',
      }, SESSION_A) as { taskId: string; status: string }
      expect(first.status).toBe('submitted')

      // paused: a new task stays queued (dispatchOne short-circuits).
      await harness.run('set_dag_state', { dag: 'paused' }, SESSION_A)
      const paused = await harness.run('create_task', {
        target: String(SESSION_B),
        content: 'second',
        title: 'Second',
      }, SESSION_A) as { taskId: string; status: string }
      expect(paused.status).toBe('queued')
      expect(harness.ledger.get(paused.taskId as TaskId)?.status).toBe('queued')

      // resumed: the catch-up sweep dispatches the ready-but-queued task.
      const resumed = await harness.run('set_dag_state', { dag: 'running' }, SESSION_A) as
        { dag: string; resumed: number }
      expect(resumed.dag).toBe('running')
      expect(resumed.resumed).toBeGreaterThanOrEqual(0)
      // The paused task was caught up and is now submitted (or delivered).
      const after = harness.ledger.get(paused.taskId as TaskId)?.status
      expect(after === 'submitted' || after === 'working').toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})
