/**
 * 工具渲染单测：renderTaskRow 的待验收/待投递徽标、可见集规则
 * （inbox/outbox 划分、归档不可见、isActiveTask 判定）、renderTaskDetail 的
 * 交接文档与验收标准展示、canReadTask 可达性判定。
 *
 * 覆盖面（对应 docs/verification.md §1「tools-render」行）：
 * - 待验收（completed 无 outcome）与待投递（queued）徽标；
 * - 可见集规则：list_tasks 的 inbox/outbox 划分、status 过滤、
 *   终结态立即可见性、24h 归档边界（含真实 list_tasks execute 体）；
 * - renderTaskDetail 展示交接文档（handoffs）与验收标准（acceptanceCriteria）；
 * - canReadTask 可达性：发起方/执行方/同工作区/异工作区/无工作区。
 *
 * 核心逻辑全部真实实现：ledger（in-memory 域）与 tools.ts 的纯函数；
 * 仅 agent/workspace 为协作方桩（见 tests/helpers/tool-harness.ts）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { canReadTask, isActiveTask, renderTaskDetail, renderTaskRow } from '../src/tools.ts'
import { TaskId } from '../src/types.ts'
import {
  makeNewTask,
  makeTask,
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
} from './helpers/memory-ctx.ts'
import {
  createToolHarness,
  makeAgent,
  type ToolHarness,
  type ToolHarnessOptions,
} from './helpers/tool-harness.ts'

let harnesses: ToolHarness[] = []

afterEach(async () => {
  const pending = harnesses
  harnesses = []
  await Promise.all(pending.map(harness => harness.dispose()))
})

async function newHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  const harness = await createToolHarness(options)
  harnesses.push(harness)
  return harness
}

function idsOf(rows: unknown): string[] {
  return (rows as { id: string }[]).map(row => row.id)
}

/** list_tasks 返回面的最小投影（view() 的字段子集）。 */
interface RowView {
  readonly id: string
  readonly status: string
  readonly report?: string
  readonly outcome?: string
}

/** renderTaskRow 的参数面（与 tools.ts 内部 TaskView 结构一致）。 */
interface Row {
  readonly id: string
  readonly status: string
  readonly from: string
  readonly to?: string
  readonly content: string
  readonly title?: string
  readonly report?: string
  readonly outcome?: string
  readonly reason?: string
  readonly dependencies?: string[]
  readonly acceptanceCriteria?: string
  readonly retries: number
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 't1',
    status: 'submitted',
    from: 'session-a',
    content: 'do the thing',
    retries: 0,
    ...overrides,
  }
}

describe('renderTaskRow badges and lines', () => {
  it('a queued row renders the 待投递 badge', () => {
    expect(renderTaskRow(row({ status: 'queued', title: 'Wait' }))).toBe('t1 [queued 待投递] Wait')
  })

  it('a completed row awaiting its verdict renders the 待验收 badge', () => {
    expect(renderTaskRow(row({ status: 'completed', title: 'Done' }))).toBe('t1 [completed 待验收] Done')
  })

  it('a settled completed row renders the plain status, no 待验收 badge', () => {
    const text = renderTaskRow(row({ status: 'completed', outcome: 'success', title: 'Done' }))
    expect(text).toContain('t1 [completed] Done')
    expect(text).not.toContain('待验收')
  })

  it('every other status renders the plain status badge', () => {
    for (const status of ['submitted', 'working', 'input-required', 'failed', 'canceled', 'rejected']) {
      expect(renderTaskRow(row({ status })), status).toContain(`[${status}]`)
    }
  })

  it('the label prefers the title and falls back to the content head when absent or empty', () => {
    expect(renderTaskRow(row({ title: 'Title' }))).toContain('Title')
    const long = 'x'.repeat(100)
    expect(renderTaskRow(row({ title: '', content: long }))).toContain(long.slice(0, 80))
    expect(renderTaskRow(row({ content: long }))).toContain(long.slice(0, 80))
  })

  it('report, verdict, reason, and dependency lines render when present', () => {
    const text = renderTaskRow(row({
      status: 'completed',
      outcome: 'success',
      report: 'the result',
      reason: 'a reason',
      dependencies: ['dep-1', 'dep-2'],
    }))
    expect(text).toContain('\n  submitted result: the result')
    expect(text).toContain('\n  verdict: success')
    expect(text).toContain('\n  reason: a reason')
    expect(text).toContain('\n  depends on: dep-1, dep-2')
  })

  it('optional trailing lines are omitted when absent', () => {
    const text = renderTaskRow(row())
    expect(text).not.toContain('submitted result:')
    expect(text).not.toContain('verdict:')
    expect(text).not.toContain('reason:')
    expect(text).not.toContain('depends on:')
  })

  it('the listing report line is bounded to 400 characters', () => {
    const text = renderTaskRow(row({ report: 'y'.repeat(500) }))
    expect(text).toContain('y'.repeat(400))
    expect(text).not.toContain('y'.repeat(401))
  })
})

describe('isActiveTask visibility rule', () => {
  it('failed, canceled, and rejected rows leave the active set immediately', () => {
    for (const status of ['failed', 'canceled', 'rejected'] as const) {
      const task = makeTask({ status, updatedAt: '2026-08-01T00:00:00.000Z' })
      expect(isActiveTask(task, Date.parse('2026-08-01T00:00:01.000Z')), status).toBe(false)
    }
  })

  it('a completed row awaiting its verdict stays active however old', () => {
    const task = makeTask({ status: 'completed', updatedAt: '2000-01-01T00:00:00.000Z' })
    expect(isActiveTask(task, Date.parse('2026-08-01T00:00:00.000Z'))).toBe(true)
  })

  it('a settled row stays active inside the 24h archive age', () => {
    const updated = Date.parse('2026-08-01T00:00:00.000Z')
    const task = makeTask({ status: 'completed', outcome: 'success', updatedAt: new Date(updated).toISOString() })
    expect(isActiveTask(task, updated + 1000)).toBe(true)
    expect(isActiveTask(task, updated + 24 * 60 * 60 * 1000 - 1)).toBe(true)
  })

  it('a settled row leaves the active set at exactly 24h (archive boundary)', () => {
    const updated = Date.parse('2026-08-01T00:00:00.000Z')
    const task = makeTask({ status: 'completed', outcome: 'success', updatedAt: new Date(updated).toISOString() })
    expect(isActiveTask(task, updated + 24 * 60 * 60 * 1000)).toBe(false)
    expect(isActiveTask(task, updated + 24 * 60 * 60 * 1000 + 1)).toBe(false)
  })

  it('queued, submitted, working, input-required, and auth-required stay active', () => {
    for (const status of ['queued', 'submitted', 'working', 'input-required', 'auth-required'] as const) {
      const task = makeTask({ status, updatedAt: '2026-08-01T00:00:00.000Z' })
      expect(isActiveTask(task, Date.parse('2026-08-01T00:00:01.000Z')), status).toBe(true)
    }
  })
})

describe('list_tasks visibility through the real tool', () => {
  it('inbox lists only tasks addressed to the caller', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await harness.ledger.record(makeNewTask({ id: TaskId('in-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.record(makeNewTask({ id: TaskId('in-2'), assignedBy: SESSION_B, assignedTo: SESSION_A }), 8)
    await harness.ledger.record(makeNewTask({ id: TaskId('in-3'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)

    const inbox = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
    expect(idsOf(inbox)).toEqual(['in-1', 'in-3'])
  })

  it('outbox lists only tasks the caller dispatched', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await harness.ledger.record(makeNewTask({ id: TaskId('out-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.record(makeNewTask({ id: TaskId('out-2'), assignedBy: SESSION_B, assignedTo: SESSION_A }), 8)
    await harness.ledger.record(makeNewTask({ id: TaskId('out-3'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)

    const outbox = await harness.run('list_tasks', { scope: 'outbox' }, SESSION_A)
    expect(idsOf(outbox)).toEqual(['out-1', 'out-3'])
  })

  it('status filter narrows the listing', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await harness.ledger.record(makeNewTask({ id: TaskId('st-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.record(makeNewTask({ id: TaskId('st-2'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.transition(TaskId('st-1'), 'working')

    const working = await harness.run('list_tasks', { scope: 'inbox', status: 'working' }, SESSION_B)
    expect(idsOf(working)).toEqual(['st-1'])
  })

  it('a completed row awaiting the verdict stays listed with its report', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await harness.ledger.record(makeNewTask({ id: TaskId('done-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.transition(TaskId('done-1'), 'working')
    await harness.ledger.transition(TaskId('done-1'), 'completed', { report: 'the result' })

    const inbox = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B) as RowView[]
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.status).toBe('completed')
    expect(inbox[0]!.report).toBe('the result')
  })

  it('a failed row is invisible in both scopes', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await harness.ledger.record(makeNewTask({ id: TaskId('ok-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.record(makeNewTask({ id: TaskId('fl-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.transition(TaskId('fl-1'), 'working')
    await harness.ledger.transition(TaskId('fl-1'), 'failed', { reason: 'timeout' })

    const inbox = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
    expect(idsOf(inbox)).toEqual(['ok-1'])
    const outbox = await harness.run('list_tasks', { scope: 'outbox' }, SESSION_A)
    expect(idsOf(outbox)).toEqual(['ok-1'])
  })

  it('settled rows leave the listing once the 24h archive age passes; fresh settled rows stay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
      const harness = await newHarness()
      harness.agents.add(makeAgent(SESSION_A))
      harness.agents.add(makeAgent(SESSION_B))

      // 旧任务：T0 完成并验收。
      await harness.ledger.record(makeNewTask({ id: TaskId('old-1') }), 8)
      await harness.ledger.transition(TaskId('old-1'), 'working')
      await harness.ledger.transition(TaskId('old-1'), 'completed', { report: 'old result' })
      await harness.ledger.settle(TaskId('old-1'), 'success', undefined)

      // 新任务：T0+2h 完成并验收。
      vi.setSystemTime(new Date('2026-08-01T02:00:00.000Z'))
      await harness.ledger.record(makeNewTask({ id: TaskId('fresh-1') }), 8)
      await harness.ledger.transition(TaskId('fresh-1'), 'working')
      await harness.ledger.transition(TaskId('fresh-1'), 'completed', { report: 'fresh result' })
      await harness.ledger.settle(TaskId('fresh-1'), 'success', undefined)

      vi.setSystemTime(new Date('2026-08-01T03:00:00.000Z'))
      const both = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
      expect(idsOf(both)).toEqual(['old-1', 'fresh-1'])

      // 越过 24h：旧任务（25h 龄）归档不可见，新任务（23h 龄）仍在。
      vi.setSystemTime(new Date('2026-08-02T01:00:00.001Z'))
      const after = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
      expect(idsOf(after)).toEqual(['fresh-1'])

      // 恰好 24h 的边界：归档年龄是严格小于，等于即不可见。
      vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'))
      expect(isActiveTask(harness.ledger.get(TaskId('old-1'))!, Date.now())).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('get_task reachability through the real tool (decision 4)', () => {
  it('the initiator and the executor can read a live task', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.agents.add(makeAgent(SESSION_REVIEWER))
    await harness.ledger.record(makeNewTask({ id: TaskId('gt-1') }), 8)

    const initiator = await harness.run('get_task', { task_id: 'gt-1' }, SESSION_A)
    expect((initiator as { id: string }).id).toBe('gt-1')
    await harness.run('get_task', { task_id: 'gt-1' }, SESSION_B)
  })

  it('a same-workspace non-participant is refused with 该任务与你无关', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.agents.add(makeAgent(SESSION_REVIEWER))
    await harness.ledger.record(makeNewTask({ id: TaskId('gt-2') }), 8)

    await expect(
      harness.run('get_task', { task_id: 'gt-2' }, SESSION_REVIEWER),
    ).rejects.toThrow(/该任务与你无关/)
  })

  it('a named reviewer is a participant and can read', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_REVIEWER))
    await harness.ledger.record(
      makeNewTask({ id: TaskId('gt-3'), assignedReviewer: SESSION_REVIEWER }),
      8,
    )
    const result = await harness.run('get_task', { task_id: 'gt-3' }, SESSION_REVIEWER)
    expect((result as { id: string }).id).toBe('gt-3')
  })

  it('a completed task is history and publicly readable by a non-participant', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.agents.add(makeAgent(SESSION_REVIEWER))
    const recorded = await harness.ledger.record(makeNewTask({ id: TaskId('gt-4') }), 8)
    if (!recorded.ok) throw new Error(recorded.message)
    const advanced = await harness.ledger.transition(TaskId('gt-4'), 'working')
    expect(advanced.ok).toBe(true)
    const completed = await harness.ledger.transition(TaskId('gt-4'), 'completed')
    expect(completed.ok).toBe(true)
    const result = await harness.run('get_task', { task_id: 'gt-4' }, SESSION_REVIEWER)
    expect((result as { id: string }).id).toBe('gt-4')
  })

  it('an unknown task id is refused', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('get_task', { task_id: 'missing' }, SESSION_A),
    ).rejects.toThrow('no such task')
  })
})

describe('canReadTask decision rule (decision 4)', () => {
  it('participants — dispatcher, executor, and named reviewer — read a live task', () => {
    const task = makeTask({ assignedReviewer: SESSION_REVIEWER })
    expect(canReadTask(task, SESSION_A)).toBe(true)
    expect(canReadTask(task, SESSION_B)).toBe(true)
    expect(canReadTask(task, SESSION_REVIEWER)).toBe(true)
  })

  it('a same-workspace non-participant is refused on a live task', () => {
    const task = makeTask() // by A, to B, reviewer unnamed → REVIEWER is a bystander
    expect(canReadTask(task, SESSION_REVIEWER)).toBe(false)
  })

  it('workspace membership no longer grants read access', () => {
    const task = makeTask()
    expect(canReadTask(task, SESSION_REVIEWER)).toBe(false)
  })

  it('a completed task is history and publicly readable', () => {
    const task = makeTask({ status: 'completed' })
    expect(canReadTask(task, SESSION_REVIEWER)).toBe(true)
  })

  it('a terminally-failed task is history and publicly readable', () => {
    const task = makeTask({ status: 'canceled' })
    expect(canReadTask(task, SESSION_REVIEWER)).toBe(true)
  })

  it('a self-executed task stays readable by its owner', () => {
    const task = makeTask({ assignedBy: SESSION_A, assignedTo: SESSION_A })
    expect(canReadTask(task, SESSION_A)).toBe(true)
  })
})

/** renderTaskDetail 的参数面（与 tools.ts 内部 TaskDetailView 结构一致）。 */
interface Detail {
  readonly id: string
  readonly status: string
  readonly from: string
  readonly to?: string
  readonly content: string
  readonly title?: string
  readonly acceptanceCriteria?: string
  readonly handoffs?: { fromTask: string; document: string; at: string }[]
  readonly report?: string
  readonly question?: string
  readonly outcome?: string
  readonly feedback?: string
  readonly reason?: string
  readonly reviewer?: string
  readonly retries: number
  readonly createdAt: string
  readonly updatedAt: string
}

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    id: 't1',
    status: 'completed',
    from: 'session-a',
    to: 'session-b',
    content: 'do the thing',
    retries: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    ...overrides,
  }
}

describe('renderTaskDetail', () => {
  it('renders the identity header, participants, timestamps, and the full task text', () => {
    const text = renderTaskDetail(detail())
    expect(text).toContain('t1 [completed]')
    expect(text).toContain('from: session-a')
    expect(text).toContain('to: session-b')
    expect(text).toContain('retries: 1')
    expect(text).toContain('created: 2026-08-01T00:00:00.000Z')
    expect(text).toContain('updated: 2026-08-01T01:00:00.000Z')
    expect(text).toContain('task:')
    expect(text).toContain('do the thing')
  })

  it('renders the acceptance criteria section', () => {
    const text = renderTaskDetail(detail({ acceptanceCriteria: 'must pass the gate' }))
    expect(text).toContain('acceptance criteria:')
    expect(text).toContain('must pass the gate')
  })

  it('renders one handoff document block per entry', () => {
    const text = renderTaskDetail(detail({
      handoffs: [
        { fromTask: 'dep-1', document: 'handoff doc one', at: '2026-08-01T00:00:00.000Z' },
        { fromTask: 'dep-2', document: 'handoff doc two', at: '2026-08-01T00:05:00.000Z' },
      ],
    }))
    expect(text).toContain('handoff documents:')
    expect(text).toContain('  from dep-1:')
    expect(text).toContain('handoff doc one')
    expect(text).toContain('  from dep-2:')
    expect(text).toContain('handoff doc two')
  })

  it('renders no handoff section when absent or empty', () => {
    expect(renderTaskDetail(detail())).not.toContain('handoff documents:')
    expect(renderTaskDetail(detail({ handoffs: [] }))).not.toContain('handoff documents:')
  })

  it('renders the question, report, verdict, feedback, reason, and reviewer sections', () => {
    const text = renderTaskDetail(detail({
      question: 'which base?',
      report: 'the report',
      outcome: 'success',
      feedback: 'good work',
      reason: 'a reason',
      reviewer: 'session-reviewer',
    }))
    expect(text).toContain('question:')
    expect(text).toContain('which base?')
    expect(text).toContain('submitted result:')
    expect(text).toContain('the report')
    expect(text).toContain('verdict: success')
    expect(text).toContain('feedback:')
    expect(text).toContain('good work')
    expect(text).toContain('reason:')
    expect(text).toContain('a reason')
    expect(text).toContain('reviewer:')
    expect(text).toContain('session-reviewer')
  })

  it('renders title and to when present and omits them when absent', () => {
    const withBoth = renderTaskDetail(detail({ title: 'The title' }))
    expect(withBoth).toContain('title:')
    expect(withBoth).toContain('The title')

    const without = renderTaskDetail(detail({ title: undefined, to: undefined }))
    expect(without).not.toContain('title:')
    expect(without).not.toContain('to:')
  })
})
