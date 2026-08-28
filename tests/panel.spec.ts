/**
 * panel 快照组装与纯函数导出单测（验证指南 §1「panel 测试」行）。
 *
 * 覆盖：快照组装（buildPanelSnapshot 的 tasks/flows/sessions/stats 字段
 * 结构）、会话目录与 workspace registry 同源（列表一致）、flows 归档派生
 * （流程内全部任务归档 → flow 归入归档段）、DAG 列（reverse edges /
 * unsettled blockers）、token 桶（isTokenBuckets / tokenDeltaOf）、内容
 * 截断（truncateCodePoints 恰好命中/超限边界）与 staff 组装。
 *
 * 标题解析把 DSH_HOME 指到不存在的目录，使磁盘 projection cache 恒为空
 * map，只有 live 会话的 projection 标题能注入 —— 保证断言与开发机上的
 * 真实 ~/.dsh 内容无关。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import {
  ARCHIVE_AGE_MS,
  buildPanelSnapshot,
  buildTaskView,
  detectReportZone,
  isTokenBuckets,
  staffRoles,
  staffRolesOf,
  tokenDeltaOf,
  truncateCodePoints,
} from '../src/panel.ts'
import type { ReportStore } from '../src/external.ts'
import { ARCHIVE_AGE_MS as CLIENT_ARCHIVE_AGE_MS, isDagArchived } from '../src/client/panel-model.ts'
import { TaskLedger } from '../src/ledger.ts'
import { TaskId, type TaskRecord, type TokenBuckets } from '../src/domain/types.ts'
import { fallbackTitle } from '../src/titles.ts'
import {
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
  WORKSPACE,
  createMemoryCtx,
  makeNewTask,
  makeTask,
} from './helpers/memory-ctx.ts'

const FIXED_NOW = Date.parse('2026-08-01T12:00:00.000Z')

/** buildTaskView 的 stub 依赖面（agents / projections）。 */
type AgentsLike = NonNullable<Parameters<typeof buildTaskView>[2]>
type ProjectionsLike = NonNullable<Parameters<typeof buildTaskView>[3]>

/** workspace registry 的一个最小 workspace 视图（panel 只读这四字段）。 */
interface WorkspaceStub {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly SessionId[]
}

function makeWorkspace(overrides: Partial<WorkspaceStub> = {}): WorkspaceStub {
  return {
    id: 'ws-1',
    title: 'Workspace',
    path: WORKSPACE,
    sessionIds: [SESSION_A, SESSION_B],
    ...overrides,
  }
}

/** 两区报告存储的决策面 stub：模拟「文件在 hot/cold 区是否存在」。 */
function makeReports(zones: { hot?: readonly string[]; cold?: readonly string[] } = {}): ReportStore {
  return {
    existsHot: async (ref: string) => zones.hot?.includes(ref) ?? false,
    existsCold: async (ref: string) => zones.cold?.includes(ref) ?? false,
  } as unknown as ReportStore
}

/** agents registry stub：在 live 集合内的会话返回最小 agent 句柄。 */
function makeAgents(liveIds: readonly string[]): AgentsLike {
  const live = new Set(liveIds)
  return {
    get: (id: string) => (live.has(id) ? { session: { id } } : undefined),
  } as unknown as AgentsLike
}

/** projection registry stub：按会话 id 返回投影值表。 */
function makeProjections(values: Record<string, Record<string, unknown>>): ProjectionsLike {
  return {
    snapshot: (session: { id: string }) => ({ values: values[session.id] ?? {} }),
  } as unknown as ProjectionsLike
}

/**
 * 把可选服务注入 harness ctx（与 ledger 共享同一个 Context）。
 * workspaceRegistry / agents / sessionProjections / sessions 全部经
 * ctx.get 读取，因此 stub 缺省时快照按「服务缺失」降级。
 */
function wireCtx(
  ctx: Context,
  opts: {
    workspaces?: readonly WorkspaceStub[]
    archivedSessions?: readonly string[]
    liveSessionIds?: readonly string[]
    sessionStore?: readonly { id: string; origin?: string }[]
    projectionValues?: Record<string, Record<string, unknown>>
  } = {},
): void {
  const workspaces = opts.workspaces ?? [makeWorkspace()]
  const sessions = opts.sessionStore !== undefined
    ? opts.sessionStore.map(entry => ({ id: entry.id, header: { origin: entry.origin } }))
    : workspaces.flatMap(workspace => workspace.sessionIds).map(id => ({ id: String(id), header: {} }))
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    archivedSessionIds: opts.archivedSessions ?? [],
  } as never)
  ctx.provide('agents', makeAgents(opts.liveSessionIds ?? []) as never)
  ctx.provide('sessionProjections', makeProjections(opts.projectionValues ?? {}) as never)
  ctx.provide('sessions', { list: () => sessions } as never)
}

/** 打开内存 ledger 并返回带 ctx 的基座（调用方负责 dispose）。 */
async function openLedgerWithCtx(): Promise<{
  harness: Awaited<ReturnType<typeof createMemoryCtx>>
  ledger: TaskLedger
  ctx: Context
}> {
  const harness = await createMemoryCtx()
  const ledger = await TaskLedger.open(harness.ctx)
  return { harness, ledger, ctx: harness.ctx }
}

/** 最小合法任务行；reviewer 默认独立于 initiator。 */
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return makeTask({ id: TaskId('t-1'), assignedReviewer: SESSION_REVIEWER, ...overrides })
}

describe('panel pure helpers', () => {
  describe('truncateCodePoints', () => {
    it('returns text unchanged when it fits within the limit', () => {
      expect(truncateCodePoints('abc', 4)).toBe('abc')
    })

    it('returns text unchanged at exactly the limit', () => {
      expect(truncateCodePoints('abc', 3)).toBe('abc')
    })

    it('marks overflow with a single ellipsis', () => {
      expect(truncateCodePoints('abcd', 3)).toBe('abc…')
    })

    it('never splits a surrogate pair (emoji)', () => {
      expect(truncateCodePoints('a😀b', 2)).toBe('a😀…')
      expect(truncateCodePoints('😀', 1)).toBe('😀')
    })

    it('counts CJK code points one each', () => {
      expect(truncateCodePoints('中文测试', 2)).toBe('中文…')
    })

    it('keeps an empty string empty', () => {
      expect(truncateCodePoints('', 120)).toBe('')
    })

    it('collapses any non-empty text at a zero limit', () => {
      expect(truncateCodePoints('', 0)).toBe('')
      expect(truncateCodePoints('abc', 0)).toBe('…')
    })
  })

  describe('isTokenBuckets', () => {
    const buckets: TokenBuckets = {
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    }

    it('accepts a valid four-bucket record', () => {
      expect(isTokenBuckets(buckets)).toBe(true)
      expect(isTokenBuckets({ ...buckets, cacheWriteTokens: 0 })).toBe(true)
    })

    it('rejects non-objects', () => {
      expect(isTokenBuckets(null)).toBe(false)
      expect(isTokenBuckets(undefined)).toBe(false)
      expect(isTokenBuckets('tokens')).toBe(false)
      expect(isTokenBuckets(42)).toBe(false)
    })

    it('rejects a record missing any bucket key', () => {
      const { cacheWriteTokens: _dropped, ...partial } = buckets
      void _dropped
      expect(isTokenBuckets(partial)).toBe(false)
    })

    it('rejects negative bucket values', () => {
      expect(isTokenBuckets({ ...buckets, outputTokens: -1 })).toBe(false)
    })

    it('rejects non-finite bucket values', () => {
      expect(isTokenBuckets({ ...buckets, outputTokens: Number.NaN })).toBe(false)
      expect(isTokenBuckets({ ...buckets, outputTokens: Number.POSITIVE_INFINITY })).toBe(false)
    })

    it('rejects non-number bucket values', () => {
      expect(isTokenBuckets({ ...buckets, outputTokens: '2' } as unknown as TokenBuckets)).toBe(false)
    })
  })

  describe('staffRoles', () => {
    it('orders distinct slots executor → reviewer → initiator', () => {
      expect(staffRoles(SESSION_A, SESSION_B, SESSION_REVIEWER)).toEqual([
        { sessionId: SESSION_B, role: 'executor' },
        { sessionId: SESSION_REVIEWER, role: 'reviewer' },
        { sessionId: SESSION_A, role: 'initiator' },
      ])
    })

    it('defaults the reviewer to the initiator and deduplicates it', () => {
      expect(staffRoles(SESSION_A, SESSION_B, undefined)).toEqual([
        { sessionId: SESSION_B, role: 'executor' },
        { sessionId: SESSION_A, role: 'reviewer' },
      ])
    })

    it('deduplicates an initiator that also executes', () => {
      expect(staffRoles(SESSION_A, SESSION_A, undefined)).toEqual([
        { sessionId: SESSION_A, role: 'executor' },
      ])
    })

    it('deduplicates a reviewer that also executes', () => {
      expect(staffRoles(SESSION_A, SESSION_B, SESSION_B)).toEqual([
        { sessionId: SESSION_B, role: 'executor' },
        { sessionId: SESSION_A, role: 'initiator' },
      ])
    })

    it('collapses a single session playing every role', () => {
      expect(staffRoles(SESSION_A, SESSION_A, SESSION_A)).toEqual([
        { sessionId: SESSION_A, role: 'executor' },
      ])
    })

    it('keeps only the reviewer slot when the executor is absent', () => {
      expect(staffRoles(SESSION_A, undefined, undefined)).toEqual([
        { sessionId: SESSION_A, role: 'reviewer' },
      ])
    })

    it('returns an empty staff when no session is known', () => {
      expect(staffRoles(undefined, undefined, undefined)).toEqual([])
    })
  })

  describe('staffRolesOf', () => {
    it('routes the row fields into the fixed role order', () => {
      expect(staffRolesOf(task())).toEqual([
        { sessionId: SESSION_B, role: 'executor' },
        { sessionId: SESSION_REVIEWER, role: 'reviewer' },
        { sessionId: SESSION_A, role: 'initiator' },
      ])
    })

    it('falls back to the initiator when the reviewer is absent', () => {
      expect(staffRolesOf(task({ assignedReviewer: undefined }))).toEqual([
        { sessionId: SESSION_B, role: 'executor' },
        { sessionId: SESSION_A, role: 'reviewer' },
      ])
    })
  })

  describe('tokenDeltaOf', () => {
    const start: TokenBuckets = { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }
    const current: TokenBuckets = { uncachedInputTokens: 15, outputTokens: 25, cacheReadTokens: 35, cacheWriteTokens: 45 }

    it('computes current minus start for every bucket', () => {
      const row = task({ tokensAtStart: { [SESSION_B]: start } })
      const delta = tokenDeltaOf(makeProjections({ [SESSION_B]: { tokenUsage: current } }), makeAgents([SESSION_B]), row, SESSION_B)
      expect(delta).toEqual({ uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 5 })
    })

    it('returns null when the session has no dispatch-time snapshot', () => {
      const delta = tokenDeltaOf(makeProjections({}), makeAgents([SESSION_B]), task(), SESSION_B)
      expect(delta).toBeNull()
    })

    it('returns null when the agent is not live', () => {
      const row = task({ tokensAtStart: { [SESSION_B]: start } })
      expect(tokenDeltaOf(makeProjections({ [SESSION_B]: { tokenUsage: current } }), makeAgents([]), row, SESSION_B)).toBeNull()
    })

    it('returns null when the projection registry is absent', () => {
      const row = task({ tokensAtStart: { [SESSION_B]: start } })
      expect(tokenDeltaOf(undefined, makeAgents([SESSION_B]), row, SESSION_B)).toBeNull()
    })

    it('returns null when the current projection is not a token bucket shape', () => {
      const row = task({ tokensAtStart: { [SESSION_B]: start } })
      const delta = tokenDeltaOf(makeProjections({ [SESSION_B]: { tokenUsage: 'nope' } }), makeAgents([SESSION_B]), row, SESSION_B)
      expect(delta).toBeNull()
    })

    it('clamps each bucket at zero when the projection went backwards', () => {
      const row = task({ tokensAtStart: { [SESSION_B]: start } })
      const delta = tokenDeltaOf(
        makeProjections({ [SESSION_B]: { tokenUsage: { ...current, outputTokens: 5, cacheReadTokens: 30 } } }),
        makeAgents([SESSION_B]),
        row,
        SESSION_B,
      )
      expect(delta).toEqual({ uncachedInputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 5 })
    })
  })

  describe('detectReportZone', () => {
    it('classifies an inline report with no reference as inline', async () => {
      expect(await detectReportZone(makeReports(), task({ report: 'inline body' }))).toBe('inline')
    })

    it('returns null for a task with no report at all', async () => {
      expect(await detectReportZone(makeReports(), task())).toBeNull()
    })

    it('prefers the hot zone when the reference exists there', async () => {
      expect(await detectReportZone(makeReports({ hot: ['t-1'] }), task({ reportRef: 't-1' }))).toBe('hot')
    })

    it('falls back to the cold zone', async () => {
      expect(await detectReportZone(makeReports({ cold: ['t-1'] }), task({ reportRef: 't-1' }))).toBe('cold')
    })

    it('reports missing when the reference is in neither zone', async () => {
      expect(await detectReportZone(makeReports(), task({ reportRef: 't-1' }))).toBe('missing')
    })
  })
})

describe('buildTaskView', () => {
  it('projects the core card fields onto the view', async () => {
    const view = await buildTaskView(
      task(),
      new Map([[SESSION_A, 'Alice'], [SESSION_B, 'Bob'], [SESSION_REVIEWER, 'Rev']]),
      undefined,
      undefined,
      makeReports(),
      FIXED_NOW,
    )
    expect(view.id).toBe('t-1')
    expect(view.workspacePath).toBe(WORKSPACE)
    expect(view.status).toBe('submitted')
    expect(view.settled).toBe(false)
    expect(view.content).toBe('do the thing')
    expect(view.title).toBe('Do the thing')
    expect(view.contentPreview).toBe('do the thing')
    expect(view.mode).toBe('followup')
    expect(view.byTitle).toBe('Alice')
    expect(view.toTitle).toBe('Bob')
    expect(view.reviewerTitle).toBe('Rev')
    expect(view.retries).toBe(0)
    expect(view.auto).toBe(false)
    expect(view.dependencies).toEqual([])
    expect(view.acceptanceCriteria).toBeNull()
    expect(view.flowId).toBeNull()
    expect(view.reportZone).toBeNull()
    expect(view.hasReportRef).toBe(false)
    expect(view.turn).toBeNull()
    expect(view.reason).toBeNull()
    expect(view.outcome).toBeNull()
    expect(view.feedback).toBeNull()
    expect(view.question).toBeNull()
    expect(view.taskTokensTotal).toBeNull()
    expect(view.executorLive).toBe(false)
    expect(view.archived).toBe(false)
  })

  it('marks settled only for completed-with-outcome, failed, and canceled rows', async () => {
    const completedOpen = await buildTaskView(task({ status: 'completed' }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    const completedSettled = await buildTaskView(task({ status: 'completed', outcome: 'success' }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    const failed = await buildTaskView(task({ status: 'failed', reason: 'timeout' }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    const canceled = await buildTaskView(task({ status: 'canceled' }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    expect(completedOpen.settled).toBe(false)
    expect(completedSettled.settled).toBe(true)
    expect(failed.settled).toBe(true)
    expect(canceled.settled).toBe(true)
  })

  it('marks archived only for a manually archived row, never by age', async () => {
    const active = await buildTaskView(
      task({ status: 'completed', outcome: 'success', updatedAt: '2020-01-01T00:00:00.000Z' }),
      new Map(), undefined, undefined, makeReports(), FIXED_NOW,
    )
    const archived = await buildTaskView(
      task({ status: 'completed', outcome: 'success', archived: true, updatedAt: '2020-01-01T00:00:00.000Z' }),
      new Map(), undefined, undefined, makeReports(), FIXED_NOW,
    )
    expect(active.archived).toBe(false)
    expect(archived.archived).toBe(true)
  })

  it('never archives unsettled rows, and archives a fresh terminal only after the age', async () => {
    const oldOpen = await buildTaskView(
      task({ status: 'working', updatedAt: '2020-01-01T00:00:00.000Z' }),
      new Map(), undefined, undefined, makeReports(), FIXED_NOW,
    )
    const freshFailed = await buildTaskView(
      task({ status: 'failed', reason: 'timeout', updatedAt: '2026-08-01T11:00:00.000Z' }),
      new Map(), undefined, undefined, makeReports(), FIXED_NOW,
    )
    expect(oldOpen.archived).toBe(false)
    expect(freshFailed.archived).toBe(false)
  })

  it('truncates the content preview at 120 code points', async () => {
    const over = await buildTaskView(task({ content: '字'.repeat(121) }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    const exact = await buildTaskView(task({ content: '字'.repeat(120) }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    expect(over.contentPreview).toBe('字'.repeat(120) + '…')
    expect(exact.contentPreview).toBe('字'.repeat(120))
  })

  it('truncates feedback and question at 200 code points', async () => {
    const view = await buildTaskView(
      task({ status: 'completed', outcome: 'failure', feedback: 'f'.repeat(201), question: 'q'.repeat(250) }),
      new Map(), undefined, undefined, makeReports(), FIXED_NOW,
    )
    expect(view.feedback).toBe('f'.repeat(200) + '…')
    expect(view.question).toBe('q'.repeat(200) + '…')
  })

  it('assembles staff in role order with titles and live flags', async () => {
    const view = await buildTaskView(
      task(),
      new Map([[SESSION_B, 'Bob']]),
      makeAgents([SESSION_B]),
      undefined,
      makeReports(),
      FIXED_NOW,
    )
    expect(view.staff.map(entry => [entry.sessionId, entry.role])).toEqual([
      [SESSION_B, 'executor'],
      [SESSION_REVIEWER, 'reviewer'],
      [SESSION_A, 'initiator'],
    ])
    expect(view.staff.find(entry => entry.sessionId === SESSION_B)?.title).toBe('Bob')
    expect(view.staff.find(entry => entry.sessionId === SESSION_A)?.title).toBe(fallbackTitle(SESSION_A))
    expect(view.staff.find(entry => entry.sessionId === SESSION_B)?.live).toBe(true)
    expect(view.staff.find(entry => entry.sessionId === SESSION_A)?.live).toBe(false)
    expect(view.executorLive).toBe(true)
  })

  it('deduplicates an initiator who reviews their own task', async () => {
    const view = await buildTaskView(task({ assignedReviewer: SESSION_A }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    expect(view.staff.map(entry => entry.role)).toEqual(['executor', 'reviewer'])
  })

  it('computes per-staff token deltas and sums the total', async () => {
    const start: TokenBuckets = { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }
    const current: TokenBuckets = { uncachedInputTokens: 15, outputTokens: 25, cacheReadTokens: 35, cacheWriteTokens: 45 }
    const view = await buildTaskView(
      task({ tokensAtStart: { [SESSION_B]: start } }),
      new Map(),
      makeAgents([SESSION_B]),
      makeProjections({ [SESSION_B]: { tokenUsage: current } }),
      makeReports(),
      FIXED_NOW,
    )
    const bob = view.staff.find(entry => entry.sessionId === SESSION_B)!
    expect(bob.tokensInTask).toEqual({ uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 5 })
    expect(view.staff.find(entry => entry.sessionId === SESSION_A)?.tokensInTask).toBeNull()
    expect(view.taskTokensTotal).toEqual({ uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 5 })
  })

  it('keeps the total null when every staff delta is unavailable', async () => {
    const view = await buildTaskView(task(), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    expect(view.staff.every(entry => entry.tokensInTask === null)).toBe(true)
    expect(view.taskTokensTotal).toBeNull()
  })

  it('clamps age fields at zero when the clock precedes the row', async () => {
    const view = await buildTaskView(task(), new Map(), undefined, undefined, makeReports(), 0)
    expect(view.ageMs).toBe(0)
    expect(view.updatedMs).toBe(0)
  })

  it('passes the report zone and reference flag through', async () => {
    const hot = await buildTaskView(task({ reportRef: 't-1' }), new Map(), undefined, undefined, makeReports({ hot: ['t-1'] }), FIXED_NOW)
    const inline = await buildTaskView(task({ report: 'inline' }), new Map(), undefined, undefined, makeReports(), FIXED_NOW)
    expect(hot.reportZone).toBe('hot')
    expect(hot.hasReportRef).toBe(true)
    expect(inline.reportZone).toBe('inline')
    expect(inline.hasReportRef).toBe(false)
  })
})

describe('buildPanelSnapshot', () => {
  const savedDshHome = process.env.DSH_HOME

  beforeAll(() => {
    // 让磁盘 projection cache 解析到不存在的目录：标题只来自 live 投影。
    process.env.DSH_HOME = join(process.cwd(), 'tests', '.dsh-test-home')
  })

  afterAll(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
  })

  it('assembles the document structure and recounts status stats', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx, { liveSessionIds: [SESSION_A, SESSION_B] })
      await ledger.record(makeNewTask({ id: TaskId('root'), title: 'Root' }), 8)
      await ledger.record(makeNewTask({ id: TaskId('blocked'), title: 'Blocked', dependencies: [TaskId('root')] }), 8)
      await ledger.record(makeNewTask({ id: TaskId('work'), title: 'Work' }), 8)
      await ledger.transition(TaskId('work'), 'working')
      await ledger.record(makeNewTask({ id: TaskId('ask'), title: 'Ask' }), 8)
      await ledger.transition(TaskId('ask'), 'working')
      await ledger.transition(TaskId('ask'), 'input-required')
      await ledger.record(makeNewTask({ id: TaskId('done'), title: 'Done' }), 8)
      await ledger.transition(TaskId('done'), 'working')
      await ledger.transition(TaskId('done'), 'completed')
      await ledger.settle(TaskId('done'), 'success', undefined)
      await ledger.record(makeNewTask({ id: TaskId('fail'), title: 'Fail' }), 8)
      await ledger.transition(TaskId('fail'), 'failed')
      await ledger.record(makeNewTask({ id: TaskId('cancel'), title: 'Cancel' }), 8)
      await ledger.transition(TaskId('cancel'), 'canceled')

      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      expect(snapshot.workspaces).toEqual([{ id: 'ws-1', title: 'Workspace', path: WORKSPACE }])
      expect(snapshot.stats).toEqual({
        queued: 1, submitted: 1, working: 1, 'input-required': 1,
        completed: 1, failed: 1, canceled: 1, total: 7,
      })
      expect(snapshot.tasks).toHaveLength(7)
      const statuses = new Map(snapshot.tasks.map(t => [t.id, t.status]))
      expect(statuses.get('root')).toBe('submitted')
      expect(statuses.get('blocked')).toBe('queued')
      expect(statuses.get('work')).toBe('working')
      expect(statuses.get('ask')).toBe('input-required')
      expect(statuses.get('done')).toBe('completed')
      expect(statuses.get('fail')).toBe('failed')
      expect(statuses.get('cancel')).toBe('canceled')
      // 会话目录与 workspace registry 同源：registry 里的会话一个不落。
      expect(snapshot.sessions.map(s => s.id).sort()).toEqual([SESSION_A, SESSION_B].sort())
      expect(snapshot.sessions.every(s => s.live)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('keeps the session directory byte-for-byte aligned with the registry account', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx, {
        workspaces: [
          makeWorkspace({ id: 'ws-1', sessionIds: [SESSION_A, SESSION_B] }),
          makeWorkspace({ id: 'ws-2', title: 'Other', path: '/other', sessionIds: [SESSION_REVIEWER] }),
        ],
        archivedSessions: [SESSION_B],
        liveSessionIds: [SESSION_A],
      })
      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      expect(snapshot.sessions).toHaveLength(3)
      expect(snapshot.sessions.find(s => s.id === SESSION_A)).toMatchObject({ workspaceId: 'ws-1', live: true, archived: false })
      expect(snapshot.sessions.find(s => s.id === SESSION_B)).toMatchObject({ workspaceId: 'ws-1', live: false, archived: true })
      expect(snapshot.sessions.find(s => s.id === SESSION_REVIEWER)).toMatchObject({ workspaceId: 'ws-2', live: false, archived: false })
    } finally {
      await harness.dispose()
    }
  })

  it('adds sessions referenced by tasks but absent from the registry as offline references', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx, { workspaces: [makeWorkspace({ sessionIds: [SESSION_A] })] })
      await ledger.record(makeNewTask({ id: TaskId('offline'), title: 'Offline' }), 8)
      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      const offline = snapshot.sessions.find(s => s.id === SESSION_B)
      expect(offline).toMatchObject({ workspaceId: null, live: false, archived: false })
      expect(snapshot.sessions.map(s => s.id).sort()).toEqual([SESSION_A, SESSION_B].sort())
    } finally {
      await harness.dispose()
    }
  })

  it('takes live-session titles from the session-title projection, skipping subagent sessions', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx, {
        liveSessionIds: [SESSION_A, SESSION_B],
        sessionStore: [{ id: SESSION_A }, { id: SESSION_B, origin: 'subagent' }],
        projectionValues: {
          [SESSION_A]: { title: 'Projected title' },
          [SESSION_B]: { title: 'Must not win' },
        },
      })
      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      expect(snapshot.sessions.find(s => s.id === SESSION_A)?.title).toBe('Projected title')
      expect(snapshot.sessions.find(s => s.id === SESSION_B)?.title).toBe(fallbackTitle(SESSION_B))
    } finally {
      await harness.dispose()
    }
  })

  it('fills DAG columns: reverse edges and unsettled blockers', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx)
      await ledger.record(makeNewTask({ id: TaskId('a'), title: 'A' }), 8)
      await ledger.record(makeNewTask({ id: TaskId('b'), title: 'B', dependencies: [TaskId('a')] }), 8)
      const before = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      const a = before.tasks.find(t => t.id === 'a')!
      const b = before.tasks.find(t => t.id === 'b')!
      expect(b.dependencies).toEqual(['a'])
      expect(b.blockedBy).toEqual(['a'])
      expect(a.dependents).toEqual(['b'])
      expect(a.blockedBy).toEqual([])

      await ledger.transition(TaskId('a'), 'working')
      await ledger.transition(TaskId('a'), 'completed')
      await ledger.settle(TaskId('a'), 'success', undefined)
      const after = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      expect(after.tasks.find(t => t.id === 'b')?.blockedBy).toEqual([])
      expect(after.tasks.find(t => t.id === 'b')?.status).toBe('queued')
      expect(after.tasks.find(t => t.id === 'a')?.dependents).toEqual(['b'])
    } finally {
      await harness.dispose()
    }
  })

  it('derives flow archived from the manual archive flag, not task state', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx)
      await ledger.createFlow('flow-active', 'Active flow', undefined, SESSION_A, WORKSPACE)
      await ledger.createFlow('flow-archived', 'Archived flow', 'a note', SESSION_A, WORKSPACE)
      await ledger.createFlow('flow-empty', 'Empty flow', undefined, SESSION_A, WORKSPACE)
      await ledger.record(makeNewTask({ id: TaskId('f1'), title: 'F1', flowId: 'flow-active' }), 8)
      await ledger.record(makeNewTask({ id: TaskId('f2'), title: 'F2', flowId: 'flow-archived' }), 8)
      await ledger.transition(TaskId('f2'), 'failed')
      const archivedRes = await ledger.archiveFlow('flow-archived', true)
      if (!archivedRes.ok) throw new Error(archivedRes.message)
      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      const byId = new Map(snapshot.flows.map(flow => [flow.id, flow]))
      expect(byId.get('flow-active')).toMatchObject({
        name: 'Active flow', description: null, workspacePath: WORKSPACE,
        taskCount: 1, unsettledCount: 1, archived: false,
      })
      expect(byId.get('flow-archived')).toMatchObject({ description: 'a note', taskCount: 1, unsettledCount: 0, archived: true })
      expect(byId.get('flow-empty')).toMatchObject({ taskCount: 0, unsettledCount: 0, archived: false })
    } finally {
      await harness.dispose()
    }
  })

  it('archives a settled flow only when manually archived (no 24h archive phase)', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx)
      await ledger.createFlow('flow-settled', 'Settled flow', undefined, SESSION_A, WORKSPACE)
      await ledger.record(makeNewTask({ id: TaskId('g1'), title: 'G1', flowId: 'flow-settled' }), 8)
      await ledger.transition(TaskId('g1'), 'working')
      await ledger.transition(TaskId('g1'), 'completed')
      const settled = await ledger.settle(TaskId('g1'), 'success', undefined)
      if (!settled.ok) throw new Error(settled.message)
      const updatedAt = Date.parse(settled.task.updatedAt)
      const under = await buildPanelSnapshot(ctx, ledger, makeReports(), updatedAt + ARCHIVE_AGE_MS - 1)
      expect(under.flows.find(flow => flow.id === 'flow-settled')).toMatchObject({ archived: false, unsettledCount: 0 })
      // 越过 24h 仍不自动归档。
      const aged = await buildPanelSnapshot(ctx, ledger, makeReports(), updatedAt + ARCHIVE_AGE_MS + 1000)
      expect(aged.flows.find(flow => flow.id === 'flow-settled')).toMatchObject({ archived: false, unsettledCount: 0 })
      // 手动归档后进入归档段。
      const archivedRes = await ledger.archiveFlow('flow-settled', true)
      if (!archivedRes.ok) throw new Error(archivedRes.message)
      const archived = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      expect(archived.flows.find(flow => flow.id === 'flow-settled')).toMatchObject({ archived: true, unsettledCount: 0 })
    } finally {
      await harness.dispose()
    }
  })

  it('keeps host and client archive rules consistent (manual archive only)', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      wireCtx(ctx)
      await ledger.createFlow('flow-x', 'Flow X', undefined, SESSION_A, WORKSPACE)
      await ledger.record(makeNewTask({ id: TaskId('x1'), title: 'X1', flowId: 'flow-x' }), 8)
      await ledger.transition(TaskId('x1'), 'working')
      await ledger.transition(TaskId('x1'), 'completed')
      const settled = await ledger.settle(TaskId('x1'), 'success', undefined)
      if (!settled.ok) throw new Error(settled.message)
      const updatedAt = Date.parse(settled.task.updatedAt)

      // 已结算但未手动归档 → 保持活跃;宿主与客户端一致。
      const fresh = await buildPanelSnapshot(ctx, ledger, makeReports(), updatedAt)
      const freshFlow = fresh.flows.find(flow => flow.id === 'flow-x')!
      const freshTask = fresh.tasks.find(t => t.id === 'x1')!
      expect(freshFlow.archived).toBe(false)
      expect(freshTask.archived).toBe(false)
      expect(isDagArchived(freshTask)).toBe(false)

      // 手动归档任务 → 宿主面板与客户端 DAG 都视为已归档。
      await ledger.archiveTask(TaskId('x1'), true)
      const archived = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      const archivedTask = archived.tasks.find(t => t.id === 'x1')!
      expect(archivedTask.archived).toBe(true)
      expect(isDagArchived(archivedTask)).toBe(true)
      expect(ARCHIVE_AGE_MS).toBe(CLIENT_ARCHIVE_AGE_MS)
    } finally {
      await harness.dispose()
    }
  })

  it('projects report zones and staff token deltas onto snapshot rows', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      const start: TokenBuckets = { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }
      wireCtx(ctx, {
        liveSessionIds: [SESSION_B],
        projectionValues: {
          [SESSION_B]: { tokenUsage: { uncachedInputTokens: 15, outputTokens: 25, cacheReadTokens: 35, cacheWriteTokens: 45 } },
        },
      })
      await ledger.record(makeNewTask({
        id: TaskId('tok'), title: 'Tok',
        tokensAtStart: { [SESSION_B]: start },
      }), 8)
      await ledger.record(makeNewTask({ id: TaskId('hot'), title: 'Hot' }), 8)
      await ledger.transition(TaskId('hot'), 'working', { reportRef: 'hot' })

      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports({ hot: ['hot'] }), Date.now())
      const tok = snapshot.tasks.find(t => t.id === 'tok')!
      const bob = tok.staff.find(entry => entry.sessionId === SESSION_B)!
      expect(bob.tokensInTask).toEqual({ uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 5 })
      expect(bob.live).toBe(true)
      expect(tok.taskTokensTotal).toEqual({ uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 5 })
      const hot = snapshot.tasks.find(t => t.id === 'hot')!
      expect(hot.reportZone).toBe('hot')
      expect(hot.hasReportRef).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('degrades to empty directories when optional services are absent', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      await ledger.record(makeNewTask({ id: TaskId('solo'), title: 'Solo' }), 8)
      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      expect(snapshot.workspaces).toEqual([])
      expect(snapshot.flows).toEqual([])
      // 无 registry 时任务引用的会话仍作为离线引用出现。
      expect(snapshot.sessions.map(s => s.id).sort()).toEqual([SESSION_A, SESSION_B].sort())
      expect(snapshot.sessions.every(s => s.workspaceId === null)).toBe(true)
      expect(snapshot.tasks).toHaveLength(1)
      expect(snapshot.stats).toMatchObject({ total: 1, submitted: 1 })
    } finally {
      await harness.dispose()
    }
  })

  it('defaults the staleness fields to a current instance (no hint)', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now())
      expect(snapshot.instanceStale).toBe(false)
      expect(snapshot.staleMessage).toBeNull()
      expect(snapshot.recoveredWorkers).toBe(0)
      expect(snapshot.recoveryAt).toBeNull()
    } finally {
      await harness.dispose()
    }
  })

  it('carries the decision-7 staleness verdict when one is provided', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      const stale = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now(), {
        stale: true,
        message: '代码已更新,需重启生效(运行构建 a → 磁盘构建 b)',
      })
      expect(stale.instanceStale).toBe(true)
      expect(stale.staleMessage).toContain('需重启生效')
      const current = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now(), {
        stale: false,
        message: null,
      })
      expect(current.instanceStale).toBe(false)
      expect(current.staleMessage).toBeNull()
    } finally {
      await harness.dispose()
    }
  })

  it('carries the decision-10 recovery record when one is provided', async () => {
    const { harness, ledger, ctx } = await openLedgerWithCtx()
    try {
      const snapshot = await buildPanelSnapshot(ctx, ledger, makeReports(), Date.now(), undefined, {
        recoveredWorkers: 6,
        recoveryAt: 1787486000000,
      })
      expect(snapshot.recoveredWorkers).toBe(6)
      expect(snapshot.recoveryAt).toBe(1787486000000)
    } finally {
      await harness.dispose()
    }
  })
})
