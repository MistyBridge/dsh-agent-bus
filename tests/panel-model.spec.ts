/**
 * panel-model 客户端纯视图模型单测（验证指南 §1「panel-model 测试」行）。
 *
 * 全部输入用真实快照行构造（makeView），不 mock 核心逻辑；边界用例用
 * 恰好命中 / 恰好超限的值。覆盖：客户端 active/archive 分区、节点集与
 * 祖先链、调度判定、DAG 布局与尺寸常量、归档规则、工作区/流程过滤、
 * 状态徽标，以及其余纯函数（排序、统计、token 展示、调用链等）。
 */

import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_AGE_MS,
  activeTabTasks,
  archiveAgents,
  archiveTabTasks,
  blockedByOf,
  cacheHitPercent,
  callChain,
  callSteps,
  chainToneOf,
  DAG_GAP_X,
  DAG_GAP_Y,
  DAG_NODE_H,
  DAG_NODE_W,
  DAG_PAD,
  dagOf,
  dependencyChainOf,
  emptySnapshot,
  failureReasonOf,
  flowsOfWorkspace,
  formatNumber,
  formatTokenUsage,
  hasFailedDependency,
  hasUnreadableTokens,
  isArchived,
  isDagArchived,
  isDagFaded,
  isReadyToDispatch,
  isReadyUndelivered,
  layoutDag,
  recentActivity,
  relativeTime,
  sessionsForTab,
  sessionsOfWorkspace,
  settledTasks,
  sortActive,
  sortSettled,
  sortUnsettled,
  statsOf,
  statusLabel,
  statusTone,
  tasksOfFlow,
  tasksOfSession,
  tasksOfWorkspace,
  tokenParts,
  tokenTotal,
  tokensForSession,
  truncateCodePoints,
  unsettledTasks,
  visibleDagTasks,
  type StaffEntry,
  type TaskView,
  type TokenBuckets,
} from '../src/client/panel-model.ts'
import { ARCHIVE_AGE_MS as HOST_ARCHIVE_AGE_MS } from '../src/panel.ts'

const NOW_MS = Date.parse('2026-08-01T00:00:00.000Z')
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** 最小合法快照行；覆盖字段逐项替换，未覆盖项用默认值。 */
function view(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1',
    workspacePath: '/workspace',
    status: 'submitted',
    settled: false,
    content: 'do the thing',
    title: 'Title',
    contentPreview: 'do the thing',
    mode: 'followup',
    assignedBy: 'session-a',
    assignedTo: 'session-b',
    assignedReviewer: 'session-r',
    byTitle: 'A',
    toTitle: 'B',
    reviewerTitle: 'R',
    retries: 0,
    reason: null,
    outcome: null,
    feedback: null,
    question: null,
    reportZone: null,
    hasReportRef: false,
    turn: null,
    staff: [],
    taskTokensTotal: null,
    executorLive: true,
    dependencies: [],
    acceptanceCriteria: null,
    flowId: null,
    dependents: [],
    blockedBy: [],
    auto: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ageMs: 0,
    updatedMs: 0,
    ...overrides,
  }
}

/** 最小 staff 行。 */
function staff(sessionId: string, tokensInTask: TokenBuckets | null): StaffEntry {
  return { sessionId, title: sessionId, role: 'executor', live: true, tokensInTask }
}

const TOKENS: TokenBuckets = {
  uncachedInputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 40,
}

describe('relativeTime', () => {
  it('labels a sub-minute age 刚刚', () => {
    expect(relativeTime(0, NOW_MS)).toBe('刚刚')
  })

  it('labels 59999ms 刚刚 (just below the minute)', () => {
    expect(relativeTime(60_000 - 1, NOW_MS)).toBe('刚刚')
  })

  it('labels exactly one minute 1 分钟前', () => {
    expect(relativeTime(60_000, NOW_MS)).toBe('1 分钟前')
  })

  it('labels 59m59s 59 分钟前', () => {
    expect(relativeTime(HOUR_MS - 1, NOW_MS)).toBe('59 分钟前')
  })

  it('labels exactly one hour 1 小时前', () => {
    expect(relativeTime(HOUR_MS, NOW_MS)).toBe('1 小时前')
  })

  it('labels 23h59m 23 小时前', () => {
    expect(relativeTime(DAY_MS - 1, NOW_MS)).toBe('23 小时前')
  })

  it('labels exactly one day 1 天前', () => {
    expect(relativeTime(DAY_MS, NOW_MS)).toBe('1 天前')
  })

  it('labels 6d23h 6 天前', () => {
    expect(relativeTime(7 * DAY_MS - 1, NOW_MS)).toBe('6 天前')
  })

  it('falls back to an absolute yyyy-mm-dd date at exactly 7 days', () => {
    const updatedMs = 7 * DAY_MS
    const label = relativeTime(updatedMs, NOW_MS)
    const local = new Date(NOW_MS - updatedMs)
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
    expect(label).toBe(expected)
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('client task partitioning', () => {
  it('unsettledTasks keeps only unsettled rows', () => {
    const tasks = [view({ id: 'a', settled: false }), view({ id: 'b', settled: true })]
    expect(unsettledTasks(tasks).map(t => t.id)).toEqual(['a'])
  })

  it('settledTasks keeps only settled rows', () => {
    const tasks = [view({ id: 'a', settled: false }), view({ id: 'b', settled: true })]
    expect(settledTasks(tasks).map(t => t.id)).toEqual(['b'])
  })

  it('sortUnsettled orders oldest-updated first', () => {
    const old = view({ id: 'old', settled: false, updatedAt: '2026-07-01T00:00:00.000Z' })
    const newish = view({ id: 'new', settled: false, updatedAt: '2026-07-02T00:00:00.000Z' })
    const done = view({ id: 'done', settled: true })
    expect(sortUnsettled([newish, old, done], NOW_MS).map(t => t.id)).toEqual(['old', 'new'])
  })

  it('sortUnsettled breaks equal timestamps on createdAt ascending', () => {
    const a = view({ id: 'a', settled: false, updatedAt: '2026-07-01T00:00:00.000Z', createdAt: '2026-07-02T00:00:00.000Z' })
    const b = view({ id: 'b', settled: false, updatedAt: '2026-07-01T00:00:00.000Z', createdAt: '2026-07-01T00:00:00.000Z' })
    expect(sortUnsettled([a, b], NOW_MS).map(t => t.id)).toEqual(['b', 'a'])
  })

  it('sortSettled orders newest-updated first', () => {
    const old = view({ id: 'old', settled: true, updatedAt: '2026-07-01T00:00:00.000Z' })
    const newish = view({ id: 'new', settled: true, updatedAt: '2026-07-02T00:00:00.000Z' })
    expect(sortSettled([old, newish]).map(t => t.id)).toEqual(['new', 'old'])
  })

  it('sortActive orders in-progress oldest first, then completed newest', () => {
    const inOld = view({ id: 'in-old', settled: false, status: 'working', updatedAt: '2026-07-01T00:00:00.000Z' })
    const inNew = view({ id: 'in-new', settled: false, status: 'working', updatedAt: '2026-07-03T00:00:00.000Z' })
    const doneOld = view({ id: 'done-old', settled: true, status: 'completed', outcome: 'success', updatedAt: '2026-07-02T00:00:00.000Z' })
    const doneNew = view({ id: 'done-new', settled: true, status: 'completed', outcome: 'success', updatedAt: '2026-07-04T00:00:00.000Z' })
    expect(sortActive([doneNew, inNew, doneOld, inOld]).map(t => t.id)).toEqual(['in-old', 'in-new', 'done-new', 'done-old'])
  })

  it('tasksOfSession keeps every task for a null session', () => {
    const tasks = [view({ id: 'a' }), view({ id: 'b' })]
    expect(tasksOfSession(tasks, null)).toHaveLength(2)
  })

  it('tasksOfSession filters by initiator, executor, and reviewer membership', () => {
    const tasks = [
      view({ id: 'by', assignedBy: 'me' }),
      view({ id: 'to', assignedTo: 'me' }),
      view({ id: 'rev', assignedReviewer: 'me' }),
      view({ id: 'other', assignedBy: 'someone-else' }),
    ]
    expect(tasksOfSession(tasks, 'me').map(t => t.id).sort()).toEqual(['by', 'rev', 'to'])
  })

  it('tasksOfWorkspace keeps every task for a null path and filters otherwise', () => {
    const tasks = [view({ id: 'a', workspacePath: '/ws' }), view({ id: 'b', workspacePath: '/other' })]
    expect(tasksOfWorkspace(tasks, null)).toHaveLength(2)
    expect(tasksOfWorkspace(tasks, '/ws').map(t => t.id)).toEqual(['a'])
  })

  it('recentActivity returns the newest-updated unsettled rows up to the count', () => {
    const tasks = [
      view({ id: 'old', settled: false, updatedAt: '2026-07-01T00:00:00.000Z' }),
      view({ id: 'new', settled: false, updatedAt: '2026-07-03T00:00:00.000Z' }),
      view({ id: 'mid', settled: false, updatedAt: '2026-07-02T00:00:00.000Z' }),
      view({ id: 'done', settled: true, updatedAt: '2026-07-04T00:00:00.000Z' }),
    ]
    expect(recentActivity(tasks, 2).map(t => t.id)).toEqual(['new', 'mid'])
  })

  it('recentActivity caps at zero or negative counts with an empty list', () => {
    const tasks = [view({ id: 'a', settled: false })]
    expect(recentActivity(tasks, 0)).toEqual([])
    expect(recentActivity(tasks, -3)).toEqual([])
  })
})

describe('statsOf', () => {
  it('recounts the seven countable status buckets plus total', () => {
    const tasks = [
      view({ status: 'queued' }),
      view({ status: 'working' }),
      view({ status: 'failed' }),
      view({ status: 'rejected' }),
      view({ status: 'archived' }),
    ]
    expect(statsOf(tasks)).toEqual({
      queued: 1,
      submitted: 0,
      working: 1,
      'input-required': 0,
      completed: 0,
      failed: 1,
      canceled: 0,
      total: 5,
    })
  })

  it('counts input-required and completed rows in their own buckets', () => {
    const tasks = [
      view({ status: 'input-required' }),
      view({ status: 'completed', settled: true, outcome: 'success' }),
      view({ status: 'submitted' }),
    ]
    const stats = statsOf(tasks)
    expect(stats['input-required']).toBe(1)
    expect(stats.completed).toBe(1)
    expect(stats.submitted).toBe(1)
    expect(stats.total).toBe(3)
  })
})

describe('archiveAgents', () => {
  const sessions = [
    { id: 'session-a', title: 'Alice', workspaceId: 'w', live: true, archived: false },
    { id: 'session-b', title: 'Bob', workspaceId: 'w', live: false, archived: false },
    { id: 'session-r', title: 'Rev', workspaceId: 'w', live: true, archived: false },
  ]

  it('collects distinct settled-task participants, live first', () => {
    const tasks = [
      view({ id: 't1', settled: true, status: 'completed', outcome: 'success' }),
      view({ id: 't2', settled: true, status: 'failed' }),
    ]
    // 插入顺序 executor → reviewer → initiator；稳定排序把 live 行提前。
    expect(archiveAgents(tasks, sessions).map(a => a.sessionId)).toEqual(['session-r', 'session-a', 'session-b'])
  })

  it('reads titles from the session directory', () => {
    const tasks = [view({ id: 't1', settled: true, status: 'completed', outcome: 'success' })]
    expect(archiveAgents(tasks, sessions).find(a => a.sessionId === 'session-b')?.title).toBe('Bob')
  })

  it('ignores unsettled tasks entirely', () => {
    const tasks = [
      view({ id: 't1', settled: false, status: 'working', assignedBy: 'session-x', byTitle: 'X' }),
      view({ id: 't2', settled: true, status: 'completed', outcome: 'success' }),
    ]
    expect(archiveAgents(tasks, sessions).every(a => a.sessionId !== 'session-x')).toBe(true)
  })

  it('falls back to task names, then the id prefix, when the directory is empty', () => {
    const named = archiveAgents(
      [view({ id: 't1', settled: true, status: 'completed', outcome: 'success', assignedTo: 'session-11111111', toTitle: 'Named' })],
      [],
    )
    expect(named[0]?.title).toBe('Named')
    const bare = archiveAgents(
      [{ ...view({ id: 't2', settled: true, status: 'completed', outcome: 'success', assignedBy: 'session-22222222' }), byTitle: null } as unknown as TaskView],
      [],
    )
    expect(bare.find(a => a.sessionId === 'session-22222222')?.title).toBe('session-')
  })
})

describe('token display helpers', () => {
  it('tokenTotal sums all four buckets', () => {
    expect(tokenTotal(TOKENS)).toBe(100)
  })

  it('tokenParts projects buckets onto the three-part staff display', () => {
    expect(tokenParts(TOKENS)).toEqual({ cacheHit: 30, input: 10, output: 20 })
  })

  it('cacheHitPercent rounds cache-read share of the input', () => {
    expect(cacheHitPercent({ ...TOKENS, cacheReadTokens: 92, uncachedInputTokens: 8 })).toBe(92)
  })

  it('cacheHitPercent rounds 2/3 up to 67', () => {
    expect(cacheHitPercent({ ...TOKENS, cacheReadTokens: 2, uncachedInputTokens: 1 })).toBe(67)
  })

  it('cacheHitPercent returns null when there is no input of either kind', () => {
    expect(cacheHitPercent({ ...TOKENS, cacheReadTokens: 0, uncachedInputTokens: 0 })).toBeNull()
  })

  it('formatNumber groups with en-US thousand separators and rounds', () => {
    expect(formatNumber(1261)).toBe('1,261')
    expect(formatNumber(0.6)).toBe('1')
  })

  it('formatTokenUsage renders an unreadable delta with dashes', () => {
    expect(formatTokenUsage(null)).toBe('缓存命中 — · 输入 — · 输出 —')
  })

  it('formatTokenUsage renders a hit percent when computable', () => {
    expect(formatTokenUsage({ uncachedInputTokens: 8, outputTokens: 732, cacheReadTokens: 92, cacheWriteTokens: 0 }))
      .toBe('缓存命中 92% · 输入 8 · 输出 732')
  })

  it('formatTokenUsage renders a dash hit when there is no cache input', () => {
    expect(formatTokenUsage({ uncachedInputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }))
      .toBe('缓存命中 — · 输入 0 · 输出 1')
  })

  it('tokensForSession reads one staff row by session id', () => {
    const task = view({ staff: [staff('session-b', TOKENS)] })
    expect(tokensForSession(task, 'session-b')).toEqual(TOKENS)
    expect(tokensForSession(task, 'nobody')).toBeNull()
  })

  it('hasUnreadableTokens is true when any staff row misses a delta', () => {
    expect(hasUnreadableTokens([])).toBe(false)
    expect(hasUnreadableTokens([staff('a', TOKENS)])).toBe(false)
    expect(hasUnreadableTokens([staff('a', TOKENS), staff('b', null)])).toBe(true)
    expect(hasUnreadableTokens([staff('a', null)])).toBe(true)
  })
})

describe('truncateCodePoints (client)', () => {
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

  it('handles a zero limit: empty stays empty, anything else collapses', () => {
    expect(truncateCodePoints('', 0)).toBe('')
    expect(truncateCodePoints('abc', 0)).toBe('…')
  })
})

describe('call chain', () => {
  it('builds initiator → executor → reviewer hops', () => {
    const hops = callChain(view({}))
    expect(hops.map(h => h.role)).toEqual(['initiator', 'executor', 'reviewer'])
    expect(hops[0]).toMatchObject({ sessionId: 'session-a', role: 'initiator' })
  })

  it('omits the executor hop when the task has no assignee', () => {
    const hops = callChain(view({ assignedTo: null, toTitle: null }))
    expect(hops.map(h => h.role)).toEqual(['initiator', 'reviewer'])
  })

  it('defaults the reviewer to the initiator and its title', () => {
    const hops = callChain(view({ assignedReviewer: null, reviewerTitle: null }))
    expect(hops[2]).toMatchObject({ sessionId: 'session-a', role: 'reviewer', title: 'A' })
  })

  it('callSteps labels dispatch and default review hops', () => {
    const steps = callSteps(view({}))
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ from: { role: 'initiator' }, to: { role: 'executor' }, summary: '派发' })
    expect(steps[1]).toMatchObject({ from: { role: 'executor' }, to: { role: 'reviewer' }, summary: '提交验收' })
  })

  it('callSteps prefers feedback over question on the review hop', () => {
    expect(callSteps(view({ feedback: 'redo it', question: 'why?' }))[1]?.summary).toBe('redo it')
    expect(callSteps(view({ feedback: null, question: 'clarify' }))[1]?.summary).toBe('clarify')
  })
})

describe('archive rules', () => {
  it('isArchived honors the host archived flag', () => {
    expect(isArchived(view({ archived: true }))).toBe(true)
  })

  it('isArchived honors the dedicated archived status', () => {
    expect(isArchived(view({ status: 'archived' }))).toBe(true)
  })

  it('isArchived does NOT archive a settled row by age (manual only)', () => {
    const task = view({ settled: true, status: 'completed', outcome: 'success', updatedMs: ARCHIVE_AGE_MS })
    expect(isArchived(task)).toBe(false)
    expect(isArchived({ ...task, updatedMs: ARCHIVE_AGE_MS + 365 * 24 * 60 * 60 * 1000 })).toBe(false)
  })

  it('isArchived archives only a manually archived row', () => {
    expect(isArchived(view({ archived: true }))).toBe(true)
    expect(isArchived(view({ archived: false }))).toBe(false)
  })

  it('isArchived never archives an unsettled row however old', () => {
    expect(isArchived(view({ settled: false, status: 'working', updatedMs: ARCHIVE_AGE_MS * 2 }))).toBe(false)
  })

  it('activeTabTasks keeps every non-archived row (no automatic exclusion)', () => {
    const tasks = [
      view({ id: 'w', settled: false, status: 'working' }),
      view({ id: 'fresh', settled: true, status: 'completed', outcome: 'success', updatedMs: 1000 }),
      view({ id: 'old', settled: true, status: 'completed', outcome: 'success', updatedMs: ARCHIVE_AGE_MS }),
      view({ id: 'failed', settled: true, status: 'failed' }),
      view({ id: 'offline', settled: false, status: 'submitted', executorLive: false }),
    ]
    expect(activeTabTasks(tasks).map(t => t.id)).toEqual(['w', 'fresh', 'old', 'failed', 'offline'])
  })

  it('activeTabTasks keeps a completed row awaiting a verdict', () => {
    expect(activeTabTasks([view({ id: 'awaiting', settled: false, status: 'completed' })]).map(t => t.id)).toEqual(['awaiting'])
  })

  it('activeTabTasks keeps a manually archived row out of the active tab', () => {
    expect(activeTabTasks([view({ id: 'arch', archived: true })]).map(t => t.id)).toEqual([])
  })

  it('archiveTabTasks takes only manually archived rows', () => {
    const tasks = [
      view({ id: 'w', settled: false, status: 'working' }),
      view({ id: 'fresh', settled: true, status: 'completed', outcome: 'success', updatedMs: 1000 }),
      view({ id: 'old', settled: true, status: 'completed', outcome: 'success', updatedMs: ARCHIVE_AGE_MS }),
      view({ id: 'failed', settled: true, status: 'failed' }),
      view({ id: 'canceled', settled: true, status: 'canceled' }),
      view({ id: 'offline', settled: false, status: 'submitted', executorLive: false }),
      view({ id: 'host', settled: true, status: 'completed', outcome: 'success', archived: true }),
    ]
    expect(archiveTabTasks(tasks).map(t => t.id).sort()).toEqual(['host'])
  })

  it('partitions every row into exactly one tab', () => {
    const tasks = [
      view({ id: 'a', settled: false, status: 'working' }),
      view({ id: 'b', settled: true, status: 'completed', outcome: 'success', updatedMs: 1000 }),
      view({ id: 'c', settled: true, status: 'completed', outcome: 'success', updatedMs: ARCHIVE_AGE_MS }),
      view({ id: 'd', settled: true, status: 'failed' }),
      view({ id: 'e', archived: true }),
    ]
    const active = activeTabTasks(tasks).map(t => t.id)
    const archive = archiveTabTasks(tasks).map(t => t.id)
    expect(active).toEqual(['a', 'b', 'c', 'd'])
    expect(archive).toEqual(['e'])
  })

  it('isDagArchived archives only manually archived nodes', () => {
    expect(isDagArchived(view({ archived: true, status: 'working' }))).toBe(true)
    expect(isDagArchived(view({ status: 'failed', settled: true, updatedMs: 0 }))).toBe(false)
    expect(isDagArchived(view({ status: 'canceled', settled: true, updatedMs: 0 }))).toBe(false)
    expect(isDagArchived(view({ status: 'rejected', settled: true, updatedMs: 0 }))).toBe(false)
  })

  it('isDagArchived keeps a settled success unarchived (no 24h archive phase)', () => {
    const done = view({ status: 'completed', outcome: 'success', settled: true, updatedMs: ARCHIVE_AGE_MS - 1 })
    expect(isDagArchived(done)).toBe(false)
    expect(isDagArchived({ ...done, updatedMs: ARCHIVE_AGE_MS })).toBe(false)
  })

  it('isDagArchived keeps active work and unsettled completions unarchived', () => {
    expect(isDagArchived(view({ status: 'working' }))).toBe(false)
    expect(isDagArchived(view({ status: 'queued' }))).toBe(false)
    expect(isDagArchived(view({ status: 'completed', settled: false }))).toBe(false)
  })

  it('isDagFaded mirrors isDagArchived', () => {
    expect(isDagFaded(view({ archived: true }))).toBe(true)
    expect(isDagFaded(view({ status: 'failed' }))).toBe(false)
    expect(isDagFaded(view({ status: 'working' }))).toBe(false)
  })

  it('agrees with the host panel archive-phase constant', () => {
    expect(ARCHIVE_AGE_MS).toBe(HOST_ARCHIVE_AGE_MS)
    expect(ARCHIVE_AGE_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('session directory helpers', () => {
  const sessions = [
    { id: 'a', title: 'A', workspaceId: 'w1', live: false, archived: false },
    { id: 'b', title: 'B', workspaceId: 'w1', live: true, archived: false },
    { id: 'c', title: 'C', workspaceId: 'w2', live: true, archived: false },
    { id: 'd', title: 'D', workspaceId: 'w1', live: false, archived: true },
  ]

  it('sessionsOfWorkspace filters by workspace and lists live rows first', () => {
    expect(sessionsOfWorkspace(sessions, 'w1').map(s => s.id)).toEqual(['b', 'a', 'd'])
  })

  it('sessionsOfWorkspace keeps every session for a null workspace', () => {
    expect(sessionsOfWorkspace(sessions, null).map(s => s.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('sessionsForTab active mode lists only unarchived sessions, live first', () => {
    expect(sessionsForTab(sessions, false).map(s => s.id)).toEqual(['b', 'c', 'a'])
  })

  it('sessionsForTab archive mode appends archived sessions at the end', () => {
    expect(sessionsForTab(sessions, true).map(s => s.id)).toEqual(['b', 'c', 'a', 'd'])
  })
})

describe('emptySnapshot', () => {
  it('returns an empty document with zeroed stats', () => {
    const snapshot = emptySnapshot()
    expect(snapshot.workspaces).toEqual([])
    expect(snapshot.sessions).toEqual([])
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.flows).toEqual([])
    expect(snapshot.stats).toEqual({
      queued: 0, submitted: 0, working: 0, 'input-required': 0,
      completed: 0, failed: 0, canceled: 0, total: 0,
    })
  })
})

describe('dagOf', () => {
  it('assigns topological depth along a linear chain', () => {
    const a = view({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' })
    const b = view({ id: 'b', createdAt: '2026-07-02T00:00:00.000Z', dependencies: ['a'] })
    const c = view({ id: 'c', createdAt: '2026-07-03T00:00:00.000Z', dependencies: ['b'] })
    const { nodes, edges } = dagOf([a, b, c])
    expect(Object.fromEntries(nodes.map(n => [n.task.id, n.depth]))).toEqual({ a: 0, b: 1, c: 2 })
    expect(edges).toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
  })

  it('uses the longest path for a join node', () => {
    const a = view({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' })
    const b = view({ id: 'b', createdAt: '2026-07-02T00:00:00.000Z' })
    const c = view({ id: 'c', createdAt: '2026-07-03T00:00:00.000Z', dependencies: ['a', 'b'] })
    const d = view({ id: 'd', createdAt: '2026-07-04T00:00:00.000Z', dependencies: ['c'] })
    const { nodes, edges } = dagOf([a, b, c, d])
    expect(Object.fromEntries(nodes.map(n => [n.task.id, n.depth]))).toEqual({ a: 0, b: 0, c: 1, d: 2 })
    expect(edges).toEqual([{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }])
  })

  it('keeps isolated tasks at depth 0 with no edges', () => {
    const { nodes, edges } = dagOf([view({ id: 'x' }), view({ id: 'y' })])
    expect(nodes.every(n => n.depth === 0)).toBe(true)
    expect(edges).toEqual([])
  })

  it('skips self-references and cycle back-edges defensively', () => {
    const a = view({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z', dependencies: ['a'] })
    const b = view({ id: 'b', createdAt: '2026-07-02T00:00:00.000Z', dependencies: ['b', 'a'] })
    const c = view({ id: 'c', createdAt: '2026-07-03T00:00:00.000Z', dependencies: ['a', 'b'] })
    const { nodes, edges } = dagOf([a, b, c])
    expect(edges.every(edge => edge.from !== edge.to)).toBe(true)
    expect(edges).toEqual([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }])
    expect(Object.fromEntries(nodes.map(n => [n.task.id, n.depth]))).toEqual({ a: 0, b: 1, c: 2 })
  })

  it('drops edges to tasks outside the given set', () => {
    const b = view({ id: 'b', dependencies: ['missing'] })
    const { nodes, edges } = dagOf([b])
    expect(edges).toEqual([])
    expect(nodes[0]?.depth).toBe(0)
  })
})

describe('layoutDag', () => {
  it('exports the compact layout constants', () => {
    expect(DAG_NODE_W).toBe(176)
    expect(DAG_NODE_H).toBe(64)
    expect(DAG_GAP_X).toBe(64)
    expect(DAG_GAP_Y).toBe(22)
    expect(DAG_PAD).toBe(20)
  })

  it('lays out an empty graph as a bare padded canvas', () => {
    const { boxes, width, height } = layoutDag({ nodes: [], edges: [] })
    expect(boxes).toEqual([])
    expect(width).toBe(40)
    expect(height).toBe(40)
  })

  it('places a single depth-0 node at the padding origin', () => {
    const { boxes, width, height } = layoutDag({ nodes: [{ task: view({ id: 'x' }), depth: 0 }], edges: [] })
    expect(boxes[0]).toMatchObject({ id: 'x', depth: 0, x: 20, y: 20, w: 176, h: 64 })
    expect(width).toBe(40 + 176)
    expect(height).toBe(20 + 64 + 20)
  })

  it('advances x by depth column and y by row within a column', () => {
    const a = { task: view({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' }), depth: 0 }
    const b = { task: view({ id: 'b', createdAt: '2026-07-02T00:00:00.000Z' }), depth: 1 }
    const c = { task: view({ id: 'c', createdAt: '2026-07-01T00:00:00.000Z' }), depth: 1 }
    const { boxes, width, height } = layoutDag({ nodes: [a, b, c], edges: [] })
    const at = (id: string) => boxes.find(box => box.id === id)!
    expect(at('a')).toMatchObject({ x: 20, y: 20 })
    // 同一列按 createdAt 排序：c 早于 b，因此 c 在上、b 在下。
    expect(at('c')).toMatchObject({ x: 20 + 176 + 64, y: 20 })
    expect(at('b')).toMatchObject({ x: 20 + 176 + 64, y: 20 + 64 + 22 })
    expect(width).toBe(40 + 2 * 176 + 64)
    expect(height).toBe(20 + (64 + 22) + 64 + 20)
  })

  it('honors custom layout options', () => {
    const node = { task: view({ id: 'x' }), depth: 0 }
    const { boxes, width, height } = layoutDag({ nodes: [node], edges: [] }, { nodeW: 100, nodeH: 40, gapX: 10, gapY: 5, pad: 8 })
    expect(boxes[0]).toMatchObject({ x: 8, y: 8, w: 100, h: 40 })
    expect(width).toBe(16 + 100)
    expect(height).toBe(8 + 40 + 8)
  })
})

describe('dependencyChainOf', () => {
  it('walks the full upstream cone recursively', () => {
    const a = view({ id: 'a' })
    const b = view({ id: 'b', dependencies: ['a'] })
    const c = view({ id: 'c', dependencies: ['b'] })
    const nodes = dagOf([a, b, c]).nodes
    const { upstream } = dependencyChainOf('c', nodes)
    expect(upstream.map(t => t.id).sort()).toEqual(['a', 'b'])
  })

  it('walks the full downstream cone recursively via dependents', () => {
    const a = view({ id: 'a', dependents: ['b'] })
    const b = view({ id: 'b', dependencies: ['a'], dependents: ['c'] })
    const c = view({ id: 'c', dependencies: ['b'] })
    const nodes = dagOf([a, b, c]).nodes
    const { downstream } = dependencyChainOf('a', nodes)
    expect(downstream.map(t => t.id).sort()).toEqual(['b', 'c'])
  })

  it('omits the focus node itself', () => {
    const a = view({ id: 'a', dependents: ['b'] })
    const b = view({ id: 'b', dependencies: ['a'] })
    const nodes = dagOf([a, b]).nodes
    const { upstream, downstream } = dependencyChainOf('a', nodes)
    expect(upstream.map(t => t.id)).not.toContain('a')
    expect(downstream.map(t => t.id)).not.toContain('a')
  })

  it('returns empty cones for an unknown id', () => {
    const { upstream, downstream } = dependencyChainOf('nope', [])
    expect(upstream).toEqual([])
    expect(downstream).toEqual([])
  })

  it('handles a branch where one node feeds several dependents', () => {
    const a = view({ id: 'a', dependents: ['b', 'c'] })
    const b = view({ id: 'b', dependencies: ['a'] })
    const c = view({ id: 'c', dependencies: ['a'] })
    const nodes = dagOf([a, b, c]).nodes
    const { downstream } = dependencyChainOf('a', nodes)
    expect(downstream.map(t => t.id).sort()).toEqual(['b', 'c'])
  })
})

describe('client blockedBy / dispatch readiness', () => {
  const done = view({ id: 'done', status: 'completed', outcome: 'success' })

  it('blockedByOf returns no blockers when a task declares none', () => {
    expect(blockedByOf(view({ dependencies: [] }), [])).toEqual([])
  })

  it('blockedByOf treats a completed-success predecessor as satisfied', () => {
    expect(blockedByOf(view({ id: 'b', dependencies: ['done'] }), [done])).toEqual([])
  })

  it('blockedByOf keeps unfinished, failed, and unsettled predecessors blocking', () => {
    const working = view({ id: 'w', status: 'working' })
    const failed = view({ id: 'f', status: 'failed' })
    const awaiting = view({ id: 'a', status: 'completed', settled: false, outcome: null })
    const b = view({ id: 'b', dependencies: ['w', 'f', 'a'] })
    expect(blockedByOf(b, [working, failed, awaiting])).toEqual(['w', 'f', 'a'])
  })

  it('blockedByOf keeps a missing predecessor id blocking', () => {
    expect(blockedByOf(view({ id: 'b', dependencies: ['ghost'] }), [done])).toEqual(['ghost'])
  })

  it('isReadyToDispatch releases a queued task whose dependencies all settled', () => {
    expect(isReadyToDispatch(view({ id: 'b', status: 'queued', dependencies: ['done'] }), [done])).toBe(true)
  })

  it('isReadyToDispatch holds a queued task while any dependency is unsettled', () => {
    const b = view({ id: 'b', status: 'queued', dependencies: ['w'] })
    expect(isReadyToDispatch(b, [view({ id: 'w', status: 'working' })])).toBe(false)
  })

  it('isReadyToDispatch never dispatches a non-queued task', () => {
    expect(isReadyToDispatch(view({ status: 'submitted' }), [])).toBe(false)
    expect(isReadyToDispatch(view({ status: 'working' }), [])).toBe(false)
    expect(isReadyToDispatch(view({ status: 'completed', settled: true, outcome: 'success' }), [])).toBe(false)
  })

  it('isReadyUndelivered mirrors the dispatch rule (deprecated alias)', () => {
    expect(isReadyUndelivered(view({ status: 'queued' }), [])).toBe(true)
    const b = view({ status: 'queued', dependencies: ['w'] })
    expect(isReadyUndelivered(b, [view({ id: 'w', status: 'working' })])).toBe(false)
  })

  it('hasFailedDependency flags terminally failed or canceled predecessors', () => {
    const b = view({ id: 'b', dependencies: ['f', 'c'] })
    const tasks = [view({ id: 'f', status: 'failed' }), view({ id: 'c', status: 'canceled' })]
    expect(hasFailedDependency(b, tasks)).toBe(true)
  })

  it('hasFailedDependency ignores non-terminal and missing predecessors', () => {
    const b = view({ id: 'b', dependencies: ['w', 'ghost'] })
    expect(hasFailedDependency(b, [view({ id: 'w', status: 'working' })])).toBe(false)
    expect(hasFailedDependency(view({ dependencies: [] }), [])).toBe(false)
  })
})

describe('failureReasonOf', () => {
  it('renders the two scheduler-propagated reasons', () => {
    expect(failureReasonOf(view({ reason: 'dependency-failed' }))).toBe('依赖失败')
    expect(failureReasonOf(view({ reason: 'dependency-canceled' }))).toBe('依赖已取消')
  })

  it('keeps every other reason null so the view invents no badge', () => {
    expect(failureReasonOf(view({ reason: 'timeout' }))).toBeNull()
    expect(failureReasonOf(view({ reason: null }))).toBeNull()
    expect(failureReasonOf(view({}))).toBeNull()
  })
})

describe('flowsOfWorkspace', () => {
  const flows = [
    { id: 'f1', name: 'A', description: null, workspacePath: '/ws', taskCount: 1, unsettledCount: 0, archived: true },
    { id: 'f2', name: 'B', description: null, workspacePath: '/ws', taskCount: 1, unsettledCount: 1, archived: false },
    { id: 'f3', name: 'C', description: null, workspacePath: '/other', taskCount: 0, unsettledCount: 0, archived: false },
  ]

  it('filters by workspace path and lists active flows before archived ones', () => {
    expect(flowsOfWorkspace(flows, '/ws').map(f => f.id)).toEqual(['f2', 'f1'])
  })

  it('keeps every flow for a null workspace, active first', () => {
    expect(flowsOfWorkspace(flows, null).map(f => f.id)).toEqual(['f2', 'f3', 'f1'])
  })
})

describe('tasksOfFlow', () => {
  it('filters tasks by flow membership', () => {
    const a = view({ id: 'a', flowId: 'flow-1' })
    const b = view({ id: 'b', flowId: 'flow-1' })
    const c = view({ id: 'c' })
    expect(tasksOfFlow([a, b, c], 'flow-1').map(t => t.id)).toEqual(['a', 'b'])
  })

  it('returns no tasks for a null flow', () => {
    expect(tasksOfFlow([view({ id: 'a' })], null)).toEqual([])
  })
})

describe('visibleDagTasks', () => {
  it('keeps active tasks plus their manually-archived ancestors', () => {
    const root = view({ id: 'root', status: 'completed', outcome: 'success', settled: true, archived: true })
    const mid = view({ id: 'mid', status: 'working', dependencies: ['root'] })
    const leaf = view({ id: 'leaf', status: 'queued', dependencies: ['mid'] })
    const active = view({ id: 'active', status: 'working' })
    expect(visibleDagTasks([root, mid, leaf, active]).map(t => t.id).sort()).toEqual(['active', 'leaf', 'mid', 'root'])
  })

  it('drops isolated archived tasks from the graph', () => {
    expect(visibleDagTasks([view({ id: 'gone', archived: true })])).toEqual([])
  })

  it('keeps every active node', () => {
    const active = [view({ id: 'x', status: 'working' }), view({ id: 'y', status: 'queued' })]
    expect(visibleDagTasks(active).map(t => t.id).sort()).toEqual(['x', 'y'])
  })

  it('keeps a terminal-failed ancestor of live work visible', () => {
    const failed = view({ id: 'f', status: 'failed', settled: true })
    const working = view({ id: 'w', status: 'working', dependencies: ['f'] })
    expect(visibleDagTasks([failed, working]).map(t => t.id).sort()).toEqual(['f', 'w'])
  })
})

describe('chainToneOf', () => {
  it('tones terminal failures as fail', () => {
    expect(chainToneOf(view({ status: 'failed' }))).toBe('fail')
    expect(chainToneOf(view({ status: 'canceled' }))).toBe('fail')
  })

  it('tones settled successes as ok', () => {
    expect(chainToneOf(view({ status: 'completed', outcome: 'success' }))).toBe('ok')
  })

  it('tones everything still open as wait', () => {
    expect(chainToneOf(view({ status: 'working' }))).toBe('wait')
    expect(chainToneOf(view({ status: 'queued' }))).toBe('wait')
    expect(chainToneOf(view({ status: 'completed', settled: false }))).toBe('wait')
  })
})

describe('status badges', () => {
  it.each([
    ['queued', undefined, '待投递'],
    ['submitted', undefined, '待执行'],
    ['working', undefined, '进行中'],
    ['input-required', undefined, '等待输入'],
    ['completed', null, '待验收'],
    ['completed', undefined, '待验收'],
    ['completed', 'success', '已完成'],
    ['completed', 'failure', '已完成'],
    ['failed', undefined, '失败'],
    ['canceled', undefined, '已取消'],
    ['archived', undefined, '已归档'],
    ['auth-required', undefined, '待授权'],
    ['rejected', undefined, '已拒绝'],
  ] as const)('statusLabel(%s, %s) is %s', (status, outcome, label) => {
    expect(statusLabel(status, outcome)).toBe(label)
  })

  it.each([
    ['working', undefined, 'business'],
    ['input-required', undefined, 'warning'],
    ['completed', null, 'warning'],
    ['completed', undefined, 'warning'],
    ['completed', 'success', 'success'],
    ['completed', 'failure', 'success'],
    ['failed', undefined, 'danger'],
    ['queued', undefined, 'tertiary'],
    ['submitted', undefined, 'tertiary'],
    ['canceled', undefined, 'tertiary'],
    ['archived', undefined, 'tertiary'],
    ['auth-required', undefined, 'tertiary'],
    ['rejected', undefined, 'tertiary'],
  ] as const)('statusTone(%s, %s) is %s', (status, outcome, tone) => {
    expect(statusTone(status, outcome)).toBe(tone)
  })
})
