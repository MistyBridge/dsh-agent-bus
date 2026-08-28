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
import type { Context } from '@deepseek-ai/cordis'
import { MEMBER_ROLE_SECTION } from '../src/members/member-config.ts'
import { canReadTask, isActiveTask, renderTaskDetail, renderTaskRow } from '../src/tools/index.ts'
import { TaskId } from '../src/domain/types.ts'
import {
  makeNewTask,
  makeTask,
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
  WORKSPACE,
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
  it('no status leaves the active set automatically (manual archive only)', () => {
    for (const status of [
      'queued', 'submitted', 'working', 'input-required', 'auth-required',
      'completed', 'failed', 'canceled', 'rejected',
    ] as const) {
      const task = makeTask({
        status,
        ...(status === 'completed' ? { outcome: 'success' } : {}),
        updatedAt: '2026-08-01T00:00:00.000Z',
      })
      expect(isActiveTask(task, Date.parse('2026-08-01T00:00:01.000Z')), status).toBe(true)
    }
  })

  it('a completed row awaiting its verdict stays active however old', () => {
    const task = makeTask({ status: 'completed', updatedAt: '2000-01-01T00:00:00.000Z' })
    expect(isActiveTask(task, Date.parse('2026-08-01T00:00:00.000Z'))).toBe(true)
  })

  it('a settled row stays active however old — there is no automatic archive age', () => {
    const task = makeTask({ status: 'completed', outcome: 'success', updatedAt: '2000-01-01T00:00:00.000Z' })
    const now = Date.parse('2026-08-01T00:00:00.000Z')
    expect(isActiveTask(task, now)).toBe(true)
    expect(isActiveTask(task, now + 24 * 60 * 60 * 1000)).toBe(true)
    expect(isActiveTask(task, now + 365 * 24 * 60 * 60 * 1000)).toBe(true)
  })

  it('a manually archived row leaves the active set, and unarchiving restores it', () => {
    const archived = makeTask({
      status: 'completed', outcome: 'success', archived: true,
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
    expect(isActiveTask(archived, Date.parse('2026-08-01T00:00:01.000Z'))).toBe(false)
    const restored = makeTask({ ...archived, archived: false })
    expect(isActiveTask(restored, Date.parse('2026-08-01T00:00:01.000Z'))).toBe(true)
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

  it('a failed row stays visible in both scopes (no automatic archive)', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await harness.ledger.record(makeNewTask({ id: TaskId('ok-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.record(makeNewTask({ id: TaskId('fl-1'), assignedBy: SESSION_A, assignedTo: SESSION_B }), 8)
    await harness.ledger.transition(TaskId('fl-1'), 'working')
    await harness.ledger.transition(TaskId('fl-1'), 'failed', { reason: 'timeout' })

    const inbox = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
    expect(idsOf(inbox)).toEqual(['ok-1', 'fl-1'])
    const outbox = await harness.run('list_tasks', { scope: 'outbox' }, SESSION_A)
    expect(idsOf(outbox)).toEqual(['ok-1', 'fl-1'])
  })

  it('a settled row stays listed until it is manually archived, and unarchiving restores it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
      const harness = await newHarness()
      harness.agents.add(makeAgent(SESSION_A))
      harness.agents.add(makeAgent(SESSION_B))

      await harness.ledger.record(makeNewTask({ id: TaskId('old-1') }), 8)
      await harness.ledger.transition(TaskId('old-1'), 'working')
      await harness.ledger.transition(TaskId('old-1'), 'completed', { report: 'old result' })
      await harness.ledger.settle(TaskId('old-1'), 'success', undefined)

      // 越过 24h:仍在(无自动归档)。
      vi.setSystemTime(new Date('2026-08-02T02:00:00.000Z'))
      const after = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
      expect(idsOf(after)).toEqual(['old-1'])

      // archive_task 手动归档后不可见。
      await harness.run('archive_task', { task_id: 'old-1', archived: true }, SESSION_A)
      const archived = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
      expect(idsOf(archived)).toEqual([])

      // 取消归档恢复。
      await harness.run('archive_task', { task_id: 'old-1', archived: false }, SESSION_A)
      const restored = await harness.run('list_tasks', { scope: 'inbox' }, SESSION_B)
      expect(idsOf(restored)).toEqual(['old-1'])
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

describe('list_peers visible-set semantics (live + dormant)', () => {
  it('lists a dormant same-workspace session as a wakeable peer', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    // SESSION_B and SESSION_REVIEWER are in the workspace account but not live.
    const result = await harness.run('list_peers', {}, SESSION_A) as {
      workspace?: { path: string; id?: string }; peers: { id: string; title: string; status: string; pendingTasks: number }[];
    }
    const peers = result.peers
    expect(peers.map(p => p.id).sort()).toEqual([String(SESSION_B), String(SESSION_REVIEWER)].sort())
    const dormant = peers.find(p => p.id === String(SESSION_B))!
    expect(dormant.status).toBe('dormant')
    expect(dormant.title.length).toBeGreaterThan(0)
    expect(dormant.pendingTasks).toBe(0)
  })

  it('marks a live peer running/idle and keeps its title', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.setTitle(SESSION_B, 'Quant Strategy')
    const result = await harness.run('list_peers', {}, SESSION_A) as {
      peers: { id: string; title: string; status: string; pendingTasks: number }[];
    }
    const live = result.peers.find(p => p.id === String(SESSION_B))!
    expect(live.status).toBe('running')
    expect(live.title).toBe('Quant Strategy')
  })

  it('hides an archived same-workspace session', async () => {
    const harness = await newHarness({ archived: [SESSION_B] })
    harness.agents.add(makeAgent(SESSION_A))
    const result = await harness.run('list_peers', {}, SESSION_A) as { peers: { id: string; status: string }[] }
    const peers = result.peers
    expect(peers.map(p => p.id)).not.toContain(String(SESSION_B))
    expect(peers).toHaveLength(1)
    expect(peers[0]!.id).toBe(String(SESSION_REVIEWER))
    expect(peers[0]!.status).toBe('dormant')
  })

  it('hides a subagent-origin session and excludes the caller', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_REVIEWER, { origin: 'subagent' }))
    const result = await harness.run('list_peers', {}, SESSION_A) as { peers: { id: string; status: string }[] }
    expect(result.peers.map(p => p.id).sort()).toEqual([String(SESSION_B)])
    expect(result.peers[0]!.status).toBe('dormant')
  })

  it('exposes the caller current workspace (read-only) with the peers empty', async () => {
    const harness = await newHarness({ workspaces: [{ path: WORKSPACE, sessionIds: [SESSION_A] }] })
    harness.agents.add(makeAgent(SESSION_A))
    const result = await harness.run('list_peers', {}, SESSION_A) as {
      workspace?: { path: string; id?: string }; peers: unknown[];
    }
    expect(result.peers).toEqual([])
    expect(result.workspace?.path).toBe(WORKSPACE)
  })

  it('empty account keeps the create_member / confirm-workspace guidance', async () => {
    const harness = await newHarness({ workspaces: [{ path: WORKSPACE, sessionIds: [SESSION_A] }] })
    harness.agents.add(makeAgent(SESSION_A))
    const result = await harness.run('list_peers', {}, SESSION_A)
    expect(result).toEqual({ workspace: { path: WORKSPACE }, peers: [] })
    const render = harness.tools.get('list_peers')!.output.render as
      (args: unknown, value: unknown) => { type: string; text: string }[]
    const text = render({}, result)[0]!.text
    expect(text).toContain('no reachable peers')
    expect(text).toContain('create_member')
    expect(text).toContain('confirm your workspace')
  })

  it('renders the peer id as the target value and notes id over title', async () => {
    const harness = await newHarness({ workspaces: [{ path: WORKSPACE, sessionIds: [SESSION_A, SESSION_B] }] })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.setTitle(SESSION_B, 'Quant Strategy')
    const result = await harness.run('list_peers', {}, SESSION_A)
    expect(result).toHaveProperty('peers')
    expect((result as { peers: unknown[] }).peers).toHaveLength(1)
    const render = harness.tools.get('list_peers')!.output.render as
      (args: unknown, value: unknown) => { type: string; text: string }[]
    const text = render({}, result)[0]!.text
    expect(text).toContain('Quant Strategy')
    expect(text).toContain(`(${String(SESSION_B)})`)
    expect(text).toContain('use the id, not the title, for create_task/send_note')
  })
})

describe('archive_member workspace-scoped member visibility (manual archive, one-way)', () => {
  it('archiving a same-workspace peer removes it from list_peers (and the archive is one-way)', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    let peers = await harness.run('list_peers', {}, SESSION_A) as { peers: { id: string; status: string }[] }
    expect(peers.peers.map(p => p.id).sort()).toEqual([String(SESSION_B), String(SESSION_REVIEWER)].sort())

    const res = await harness.run('archive_member', { member_id: String(SESSION_B) }, SESSION_A) as
      { memberId: string; archived: boolean }
    expect(res).toEqual({ memberId: String(SESSION_B), archived: true })
    peers = await harness.run('list_peers', {}, SESSION_A) as { peers: { id: string; status: string }[] }
    expect(peers.peers.map(p => p.id)).not.toContain(String(SESSION_B))
    expect(peers.peers.map(p => p.id).sort()).toEqual([String(SESSION_REVIEWER)])
    // Archive set is append-only: the archived id now reflects the workspace registry.
    expect(harness.workspaces.archivedSessionIds.map(String)).toContain(String(SESSION_B))
  })

  it('refuses to archive a session that is not in the caller workspace', async () => {
    const harness = await newHarness({
      workspaces: [
        { path: WORKSPACE, sessionIds: [SESSION_A, SESSION_B] },
        // A separate workspace owning an unrelated session.
        { path: 'D:\\other-workspace', sessionIds: ['other-session' as unknown as SessionId] },
      ],
    })
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('archive_member', { member_id: 'other-session' }, SESSION_A),
    ).rejects.toThrow(/not a session of your workspace/)
  })
})

describe('wake_member activates a live peer; refuses a non-peer or archived', () => {
  it('returns running/idle for an already-live same-workspace member', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.setTitle(SESSION_B, 'Quant Strategy')
    const res = await harness.run('wake_member', { member_id: String(SESSION_B) }, SESSION_A) as
      { memberId: string; title: string; status: string }
    expect(res.memberId).toBe(String(SESSION_B))
    expect(res.title).toBe('Quant Strategy')
    expect(res.status).toBe('running')
  })

  it('refuses a session that is not in the caller workspace (non-peer)', async () => {
    const harness = await newHarness({
      workspaces: [
        { path: WORKSPACE, sessionIds: [SESSION_A, SESSION_B] },
        { path: 'D:\\other-workspace', sessionIds: ['other-session' as unknown as SessionId] },
      ],
    })
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('wake_member', { member_id: 'other-session' }, SESSION_A),
    ).rejects.toThrow(/not a session of your workspace/)
  })

  it('refuses an archived member', async () => {
    const harness = await newHarness({ archived: [SESSION_B] })
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('wake_member', { member_id: String(SESSION_B) }, SESSION_A),
    ).rejects.toThrow(/archived/)
  })
})

describe('reconfigure_member works on a live peer and refuses invalid targets', () => {
  /** 记录 role section 注册的 agent-ctx。 */
  function recordingCtx(record: Array<Record<string, unknown>>): Context {
    return {
      get: (name: string): unknown =>
        name === 'systemPrompt'
          ? { section: (value: Record<string, unknown>) => { record.push(value); return () => {} } }
          : undefined,
    } as unknown as Context
  }

  it('replaces a live member role and reports the steps', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    const sectionCalls: Array<Record<string, unknown>> = []
    harness.agents.add(makeAgent(SESSION_B, { ctx: recordingCtx(sectionCalls) }))
    const res = await harness.run(
      'reconfigure_member',
      { member_id: String(SESSION_B), role: 'analyst' },
      SESSION_A,
    ) as { memberId: string; steps: string[] }
    expect(res.memberId).toBe(String(SESSION_B))
    expect(res.steps).toEqual(['role'])
    expect(sectionCalls).toEqual([{ name: MEMBER_ROLE_SECTION, order: expect.any(Number), text: 'analyst' }])
  })

  it('refuses a session that is not a peer of the caller workspace', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('reconfigure_member', { member_id: 'other-session', role: 'x' }, SESSION_A),
    ).rejects.toThrow(/not a session of your workspace/)
  })

  it('refuses an archived member', async () => {
    const harness = await newHarness({ archived: [SESSION_B] })
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('reconfigure_member', { member_id: String(SESSION_B), role: 'x' }, SESSION_A),
    ).rejects.toThrow(/archived/)
  })

  it('refuses reconfiguring the calling session itself', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('reconfigure_member', { member_id: String(SESSION_A), role: 'x' }, SESSION_A),
    ).rejects.toThrow(/cannot reconfigure the calling session itself/)
  })

  it('refuses a dormant member that cannot be woken (no model route)', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('reconfigure_member', { member_id: String(SESSION_B), role: 'x' }, SESSION_A),
    ).rejects.toThrow(/could not be resolved/)
  })

  it('refuses a plan that changes nothing', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await expect(
      harness.run('reconfigure_member', { member_id: String(SESSION_B) }, SESSION_A),
    ).rejects.toThrow(/nothing to change/)
  })

  it('refuses a role on a deployment with no systemPrompt service', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    // A member whose agent ctx does not expose systemPrompt — the live wiring
    // resolves setRole via agent.ctx, so a role change must refuse cleanly.
    harness.agents.add(makeAgent(SESSION_B, { ctx: { get: () => undefined } as unknown as Context }))
    await expect(
      harness.run('reconfigure_member', { member_id: String(SESSION_B), role: 'x' }, SESSION_A),
    ).rejects.toThrow(/systemPrompt/)
  })
})

describe('create_batch / list_batches / list_batch (report 4.2)', () => {
  it('fans out one deliverable per peer, delivers each, and records the batch', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.agents.add(makeAgent(SESSION_REVIEWER))
    const res = await harness.run('create_batch', {
      name: 'Fan-out',
      deliverables: [
        { target: String(SESSION_B), content: 'do A', title: 'A' },
        { target: String(SESSION_REVIEWER), content: 'do B', title: 'B' },
      ],
    }, SESSION_A) as {
      batchId: string; name: string; created: number
      tasks: { taskId: string; status: string; to: string; title: string }[]
    }
    expect(res.name).toBe('Fan-out')
    expect(res.created).toBe(2)
    expect(res.tasks).toHaveLength(2)
    expect(res.tasks.map(task => task.to).sort())
      .toEqual([String(SESSION_B), String(SESSION_REVIEWER)].sort())
    // The batch header is durable and every task carries its batch id.
    expect(harness.ledger.getBatch(res.batchId)?.name).toBe('Fan-out')
    for (const task of res.tasks) {
      expect(harness.ledger.get(TaskId(task.taskId))?.batchId).toBe(res.batchId)
    }
    // Both peers received their deliverable (a steer delivery).
    expect(harness.agents.get(SESSION_B)!.steers).toHaveLength(1)
    expect(harness.agents.get(SESSION_REVIEWER)!.steers).toHaveLength(1)
  })

  it('groups multiple deliverables to one peer and derives a label from the first title', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const res = await harness.run('create_batch', {
      deliverables: [
        { target: String(SESSION_B), content: 'one', title: 'Alpha' },
        { target: String(SESSION_B), content: 'two', title: 'Beta' },
      ],
    }, SESSION_A) as { batchId: string; name: string; created: number; tasks: { taskId: string; to: string }[] }
    expect(res.name).toBe('Alpha')
    expect(res.created).toBe(2)
    expect(res.tasks.filter(task => task.to === String(SESSION_B))).toHaveLength(2)
    expect(harness.agents.get(SESSION_B)!.steers).toHaveLength(2)
  })

  it('an invalid target refuses the whole batch before any task is created', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await expect(
      harness.run('create_batch', {
        deliverables: [{ target: 'unknown-session', content: 'x', title: 'T' }],
      }, SESSION_A),
    ).rejects.toThrow()
    expect(harness.ledger.listBatches(WORKSPACE)).toHaveLength(0)
    expect(harness.ledger.listAll()).toHaveLength(0)
  })

  it('requires at least one deliverable and refuses self-execution without a reviewer', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await expect(
      harness.run('create_batch', { deliverables: [] }, SESSION_A),
    ).rejects.toThrow(/at least one deliverable/)
    await expect(
      harness.run('create_batch', {
        deliverables: [{ target: String(SESSION_A), content: 'self', title: 'Self' }],
      }, SESSION_A),
    ).rejects.toThrow(/self-execution requires reviewer/)
  })

  it('pre-flights the per-recipient pending ceiling before creating anything', async () => {
    const harness = await newHarness({ config: { maxPendingPerAgent: 1 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const rec = await harness.ledger.record(makeNewTask({ id: TaskId('busy-1'), assignedTo: SESSION_B }), 1)
    if (!rec.ok) throw new Error(rec.message)
    await expect(
      harness.run('create_batch', {
        deliverables: [{ target: String(SESSION_B), content: 'extra', title: 'Extra' }],
      }, SESSION_A),
    ).rejects.toThrow(/already has 1 unfinished tasks/)
    expect(harness.ledger.listBatches(WORKSPACE)).toHaveLength(0)
  })

  it('list_batches lists batches in the workspace with settle counts', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const created = await harness.run('create_batch', {
      name: 'Batch A',
      deliverables: [{ target: String(SESSION_B), content: 'do A', title: 'A' }],
    }, SESSION_A) as { batchId: string }
    const listed = await harness.run('list_batches', {}, SESSION_A) as {
      id: string; name: string; taskCount: number; unsettledCount: number
    }[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(created.batchId)
    expect(listed[0]!.name).toBe('Batch A')
    expect(listed[0]!.taskCount).toBe(1)
    expect(listed[0]!.unsettledCount).toBe(1)
  })

  it('list_batch reads a batch as a whole for its initiator', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const created = await harness.run('create_batch', {
      name: 'Batch A',
      deliverables: [{ target: String(SESSION_B), content: 'do A', title: 'A' }],
    }, SESSION_A) as { batchId: string; tasks: { taskId: string }[] }
    const detail = await harness.run('list_batch', { batch_id: created.batchId }, SESSION_A) as {
      id: string; name: string; createdBy: string; tasks: { id: string; status: string; content: string }[]
    }
    expect(detail.name).toBe('Batch A')
    expect(detail.createdBy).toBe(String(SESSION_A))
    expect(detail.tasks.map(task => task.id)).toEqual([created.tasks[0]!.taskId])
    expect(detail.tasks[0]!.content).toBe('do A')
  })

  it('list_batch refuses an unknown id and a batch in another workspace', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    await expect(
      harness.run('list_batch', { batch_id: 'ghost' }, SESSION_A),
    ).rejects.toThrow(/no such batch/)
    await harness.ledger.createBatch('other-batch', 'Other', SESSION_REVIEWER, '/elsewhere')
    await expect(
      harness.run('list_batch', { batch_id: 'other-batch' }, SESSION_A),
    ).rejects.toThrow(/different workspace/)
  })
})
