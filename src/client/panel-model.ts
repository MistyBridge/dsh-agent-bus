/**
 * Pure view-model helpers for the v1.1 read-only task panel.
 *
 * Snapshot shapes match docs/v1.1-task-panel-spec.md §3.6–3.7 / §4.4.
 * No I/O, no React — every export is unit-tested from tests/panel-model.test.ts.
 *
 * @module dsh-agent-bus/client/panel-model
 */

/** Task vocabulary, mirrored so the client never imports the host module. */
export type TaskStatus =
  | 'queued'
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'archived'

/** Delivery mode requested for a task. */
export type DeliveryMode = 'followup' | 'steer'

/** Dispatcher verdict on a completed task. */
export type TaskOutcome = 'success' | 'failure'

/** Four-bucket token usage, same shape as the host TokenBuckets. */
export interface TokenBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** One participant on a task card's staff directory. */
export interface StaffEntry {
  readonly sessionId: string
  readonly title: string
  readonly role: 'initiator' | 'executor' | 'reviewer'
  readonly live: boolean
  readonly tokensInTask: TokenBuckets | null
}

/** One task row as projected by GET /plugins/dsh-agent-bus/state. */
export interface TaskView {
  readonly id: string
  readonly workspacePath: string
  readonly status: TaskStatus
  readonly settled: boolean
  readonly content: string
  /** Short display title (v1.6); null falls back to the content preview. */
  readonly title: string | null
  readonly contentPreview: string
  readonly mode: DeliveryMode
  readonly assignedBy: string
  readonly assignedTo: string | null
  readonly assignedReviewer: string | null
  readonly byTitle: string
  readonly toTitle: string | null
  readonly reviewerTitle: string | null
  readonly retries: number
  readonly reason: string | null
  readonly outcome: TaskOutcome | null
  readonly feedback: string | null
  readonly question: string | null
  readonly reportZone: 'inline' | 'hot' | 'cold' | 'missing' | null
  readonly hasReportRef: boolean
  readonly turn: number | null
  readonly staff: readonly StaffEntry[]
  readonly taskTokensTotal: TokenBuckets | null
  /** Whether the executor (assignedTo) is live; kept for display, not partition. */
  readonly executorLive: boolean
  /** Manual archive marker; absent = active. Set by the user, never by the lifecycle. */
  readonly archived?: boolean
  /** DAG predecessors (task ids), in declaration order; empty when none. */
  readonly dependencies: readonly string[]
  /** Dispatcher's minimum acceptance requirement; null when unset. */
  readonly acceptanceCriteria: string | null
  /** Owning flow id (v1.4); null when the task belongs to no flow. */
  readonly flowId: string | null
  /** Tasks that depend on this one (reverse edges for the DAG view). */
  readonly dependents: readonly string[]
  /** Unsettled dependencies; empty means the task is ready to dispatch. */
  readonly blockedBy: readonly string[]
  /** Whether the scheduler (not a tool call) delivered this task. */
  readonly auto: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly ageMs: number
  readonly updatedMs: number
}

/** Status counters, isomorphic with the host snapshot `stats` object. */
export interface StatsView {
  readonly queued: number
  readonly submitted: number
  readonly working: number
  readonly 'input-required': number
  readonly completed: number
  readonly failed: number
  readonly canceled: number
  readonly total: number
}

/** One workspace in the snapshot directory. */
export interface WorkspaceView {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** One flow in the snapshot directory: a named DAG container (v1.4). */
export interface FlowView {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly workspacePath: string
  readonly taskCount: number
  /** Tasks that have not settled (still awaiting a verdict or in progress). */
  readonly unsettledCount: number
  /** Manual archive marker; absent = active. Set by the user, never derived. */
  readonly archived: boolean
}

/** One session in the snapshot directory. */
export interface SessionView {
  readonly id: string
  readonly title: string
  readonly workspaceId: string | null
  readonly live: boolean
  /** Whether the session was archived in the workspace registry. */
  readonly archived: boolean
}

/** Full panel snapshot returned by the state route. */
export interface PanelSnapshot {
  readonly workspaces: readonly WorkspaceView[]
  readonly sessions: readonly SessionView[]
  readonly tasks: readonly TaskView[]
  readonly flows: readonly FlowView[]
  readonly stats: StatsView
  /**
   * Whether the running host instance predates the latest build (decision 7).
   * Optional: hosts built before this field are treated as current.
   */
  readonly instanceStale?: boolean
  /** Explanation for a stale instance; absent when current. */
  readonly staleMessage?: string | null
  /**
   * How many stranded workers this boot re-woke (decision 10 C). Optional:
   * hosts built before this field report nothing.
   */
  readonly recoveredWorkers?: number
  /** Timestamp (epoch ms) of the last startup recovery; absent when none. */
  readonly recoveryAt?: number | null
}

/** Color tone for a status dot / badge. */
export type Tone = 'tertiary' | 'business' | 'warning' | 'success' | 'danger'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

const EMPTY_STATS: StatsView = {
  queued: 0,
  submitted: 0,
  working: 0,
  'input-required': 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  total: 0,
}

/**
 * Format a snapshot-relative age as a Chinese relative-time string.
 *
 * @param updatedMs - milliseconds since `updatedAt` (snapshot `updatedMs`).
 * @param nowMs - clock used only for the absolute `yyyy-mm-dd` fallback.
 */
export function relativeTime(updatedMs: number, nowMs: number): string {
  if (updatedMs < MINUTE_MS) return '刚刚'
  if (updatedMs < HOUR_MS) return `${Math.floor(updatedMs / MINUTE_MS)} 分钟前`
  if (updatedMs < DAY_MS) return `${Math.floor(updatedMs / HOUR_MS)} 小时前`
  if (updatedMs < WEEK_MS) return `${Math.floor(updatedMs / DAY_MS)} 天前`
  const date = new Date(nowMs - updatedMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Tasks that have not reached a terminal settled state. */
export function unsettledTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => !task.settled)
}

/** Terminal settled tasks — the archive list. */
export function settledTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => task.settled)
}

/** One historical participant drawn from settled workspace tasks. */
export interface ArchiveAgent {
  readonly sessionId: string
  readonly title: string
  readonly live: boolean
}

/**
 * Restrict tasks to those a session participates in.
 *
 * @param sessionId - `null` keeps every task.
 */
export function tasksOfSession(
  tasks: readonly TaskView[],
  sessionId: string | null,
): TaskView[] {
  if (sessionId === null) return [...tasks]
  return tasks.filter(task =>
    task.assignedBy === sessionId
    || task.assignedTo === sessionId
    || task.assignedReviewer === sessionId)
}

/**
 * Restrict tasks to one workspace path.
 *
 * @param workspacePath - `null` keeps every task.
 */
export function tasksOfWorkspace(
  tasks: readonly TaskView[],
  workspacePath: string | null,
): TaskView[] {
  if (workspacePath === null) return [...tasks]
  return tasks.filter(task => task.workspacePath === workspacePath)
}

/**
 * Unsettled tasks, oldest-updated first (the ones stuck longest sit on top).
 * Ties break on `createdAt` ascending. `nowMs` is accepted for the §4.4
 * signature; ordering is by the ISO stamps, not the clock.
 */
export function sortUnsettled(tasks: readonly TaskView[], _nowMs: number): TaskView[] {
  return unsettledTasks(tasks).sort((left, right) => {
    const updated = left.updatedAt.localeCompare(right.updatedAt)
    if (updated !== 0) return updated
    return left.createdAt.localeCompare(right.createdAt)
  })
}

/** Settled tasks, newest-updated first so the archive reads as history. */
export function sortSettled(tasks: readonly TaskView[]): TaskView[] {
  return settledTasks(tasks).sort((left, right) => {
    const updated = right.updatedAt.localeCompare(left.updatedAt)
    if (updated !== 0) return updated
    return right.createdAt.localeCompare(left.createdAt)
  })
}

/**
 * Manually archived tasks, most-recently-updated first. Unlike {@link sortSettled}
 * this does not drop non-settled rows: under manual archive any status may be
 * archived, and the archive tab shows them all.
 */
export function sortArchived(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks].sort((left, right) => {
    const updated = right.updatedAt.localeCompare(left.updatedAt)
    if (updated !== 0) return updated
    return right.createdAt.localeCompare(left.createdAt)
  })
}

/**
 * Distinct agents that participated in settled tasks, live first.
 * Titles prefer the session directory, then the task's resolved names.
 */
export function archiveAgents(
  tasks: readonly TaskView[],
  sessions: readonly SessionView[],
): ArchiveAgent[] {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const seen = new Map<string, ArchiveAgent>()
  const consider = (sessionId: string | null, fallbackTitle: string | null): void => {
    if (sessionId === null || sessionId === '' || seen.has(sessionId)) return
    const session = byId.get(sessionId)
    seen.set(sessionId, {
      sessionId,
      title: session?.title ?? fallbackTitle ?? sessionId.slice(0, 8),
      live: session?.live ?? false,
    })
  }
  for (const task of settledTasks(tasks)) {
    consider(task.assignedTo, task.toTitle)
    consider(task.assignedReviewer, task.reviewerTitle)
    consider(task.assignedBy, task.byTitle)
  }
  return [...seen.values()].sort((left, right) => Number(right.live) - Number(left.live))
}

/** Recount status buckets from a task list (same keys as the host `stats`). */
export function statsOf(tasks: readonly TaskView[]): StatsView {
  const next: { -readonly [K in keyof StatsView]: number } = { ...EMPTY_STATS }
  for (const task of tasks) {
    next.total += 1
    switch (task.status) {
      case 'queued':
      case 'submitted':
      case 'working':
      case 'input-required':
      case 'completed':
      case 'failed':
      case 'canceled':
        next[task.status] += 1
        break
      default:
        break
    }
  }
  return next
}

/**
 * Most recently updated unsettled tasks, newest first — preview hover list.
 *
 * @param count - maximum rows to return.
 */
export function recentActivity(tasks: readonly TaskView[], count: number): TaskView[] {
  return unsettledTasks(tasks)
    .sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt)
      if (updated !== 0) return updated
      return right.createdAt.localeCompare(left.createdAt)
    })
    .slice(0, Math.max(0, count))
}

/**
 * Truncate by Unicode code point so a surrogate pair (emoji) is never split.
 * Overflow is marked with a single `…`.
 */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return text === '' ? '' : '…'
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, max).join('')}…`
}

/** Sum the four token buckets. */
export function tokenTotal(tokens: TokenBuckets): number {
  return tokens.uncachedInputTokens
    + tokens.outputTokens
    + tokens.cacheReadTokens
    + tokens.cacheWriteTokens
}

/** Three-part display: cache hit / input / output. */
export interface TokenParts {
  readonly cacheHit: number
  readonly input: number
  readonly output: number
}

/** Project four host buckets onto the three-part staff display. */
export function tokenParts(tokens: TokenBuckets): TokenParts {
  return {
    cacheHit: tokens.cacheReadTokens,
    input: tokens.uncachedInputTokens,
    output: tokens.outputTokens,
  }
}

/**
 * Cache-hit rate: cache-read / (cache-read + uncached input).
 * Missing when there is no input of either kind.
 */
export function cacheHitPercent(tokens: TokenBuckets): number | null {
  const denom = tokens.cacheReadTokens + tokens.uncachedInputTokens
  if (denom <= 0) return null
  return Math.round((tokens.cacheReadTokens / denom) * 100)
}

/** `缓存命中 92% · 输入 1,261 · 输出 732` */
/** One hop in the task's invocation chain. */
export interface CallHop {
  readonly sessionId: string
  readonly title: string
  readonly role: 'initiator' | 'executor' | 'reviewer'
}

/**
 * Invocation order for one task: initiator → executor → reviewer.
 * Executor is omitted when the task has no assignee yet.
 */
export function callChain(task: TaskView): CallHop[] {
  const hops: CallHop[] = [
    { sessionId: task.assignedBy, title: task.byTitle, role: 'initiator' },
  ]
  if (task.assignedTo !== null && task.assignedTo !== '') {
    hops.push({
      sessionId: task.assignedTo,
      title: task.toTitle ?? task.assignedTo.slice(0, 8),
      role: 'executor',
    })
  }
  const reviewerId = task.assignedReviewer ?? task.assignedBy
  hops.push({
    sessionId: reviewerId,
    title: task.reviewerTitle ?? task.byTitle,
    role: 'reviewer',
  })
  return hops
}

/** One directed call in the task: A → B plus the summary for that hop. */
export interface CallStep {
  readonly from: CallHop
  readonly to: CallHop
  readonly summary: string
}

/**
 * Expand the hop list into consecutive calls.
 * Dispatch uses the task instruction; review uses feedback / question.
 */
export function callSteps(task: TaskView): CallStep[] {
  const hops = callChain(task)
  const steps: CallStep[] = []
  for (let index = 0; index < hops.length - 1; index += 1) {
    const from = hops[index]
    const to = hops[index + 1]
    if (from === undefined || to === undefined) continue
    const reviewHop = from.role === 'executor' && to.role === 'reviewer'
    const summary = reviewHop
      ? (task.feedback !== null && task.feedback !== ''
        ? task.feedback
        : task.question !== null && task.question !== ''
          ? task.question
          : '提交验收')
      : '派发'
    steps.push({ from, to, summary })
  }
  return steps
}

/** Task-period tokens for one participant, or null when unread. */
export function tokensForSession(task: TaskView, sessionId: string): TokenBuckets | null {
  return task.staff.find(entry => entry.sessionId === sessionId)?.tokensInTask ?? null
}

export function formatTokenUsage(tokens: TokenBuckets | null): string {
  if (tokens === null) return '缓存命中 — · 输入 — · 输出 —'
  const percent = cacheHitPercent(tokens)
  const hit = percent === null ? '—' : `${percent}%`
  return `缓存命中 ${hit} · 输入 ${formatNumber(tokens.uncachedInputTokens)} · 输出 ${formatNumber(tokens.outputTokens)}`
}

/** Thousand-separated integer (en-US grouping, ASCII digits). */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Chinese status badge copy.
 *
 * `completed` without an outcome is 「待验收」; a recorded outcome is 「已完成」.
 */
export function statusLabel(status: TaskStatus, outcome?: TaskOutcome | null): string {
  switch (status) {
    case 'queued': return '待投递'
    case 'submitted': return '待执行'
    case 'working': return '进行中'
    case 'input-required': return '等待输入'
    case 'completed': return outcome === null || outcome === undefined ? '待验收' : '已完成'
    case 'failed': return '失败'
    case 'canceled': return '已取消'
    case 'archived': return '已归档'
    case 'auth-required': return '待授权'
    case 'rejected': return '已拒绝'
  }
}

/**
 * Status color tone. `completed` is warning while awaiting a verdict and
 * success once an outcome is recorded; the optional `outcome` exists because
 * the two completed presentations do not share a color.
 */
export function statusTone(status: TaskStatus, outcome?: TaskOutcome | null): Tone {
  switch (status) {
    case 'working': return 'business'
    case 'input-required': return 'warning'
    case 'completed': return outcome === 'success' || outcome === 'failure' ? 'success' : 'warning'
    case 'failed': return 'danger'
    case 'queued':
    case 'submitted':
    case 'canceled':
    case 'archived':
    case 'auth-required':
    case 'rejected':
      return 'tertiary'
  }
}

/** Sessions of one workspace, live rows first, original order otherwise preserved. */
export function sessionsOfWorkspace(
  sessions: readonly SessionView[],
  workspaceId: string | null,
): SessionView[] {
  const scoped = workspaceId === null
    ? [...sessions]
    : sessions.filter(session => session.workspaceId === workspaceId)
  return scoped.sort((left, right) => Number(right.live) - Number(left.live))
}

/**
 * Legacy constant from the (removed) automatic-archive model. Kept so the host
 * and client reference a single archive-age value and tests assert they agree,
 * but it no longer drives any archive decision — archiving is a user action.
 */
export const ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000

/** Manual archive marker (default false): archiving is a user action, never automatic. */
export function isArchived(task: TaskView): boolean {
  return task.archived === true || task.status === 'archived'
}

/**
 * Active tab: everything not manually archived. Archiving is a user action
 * (archive_task / archive_flow), never derived from status, clock, or executor
 * liveness, so no task disappears from the active listing on its own.
 */
export function activeTabTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => !isArchived(task))
}

/**
 * Archive tab: tasks the user manually archived. Nothing moves here
 * automatically — only an explicit archive action does.
 */
export function archiveTabTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => isArchived(task))
}

/** Active-tab order: in-progress first (oldest update), then 已完成 (newest). */
export function sortActive(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks].sort((left, right) => {
    const leftDone = left.settled ? 1 : 0
    const rightDone = right.settled ? 1 : 0
    if (leftDone !== rightDone) return leftDone - rightDone
    if (!left.settled) {
      const updated = left.updatedAt.localeCompare(right.updatedAt)
      return updated !== 0 ? updated : left.createdAt.localeCompare(right.createdAt)
    }
    const updated = right.updatedAt.localeCompare(left.updatedAt)
    return updated !== 0 ? updated : right.createdAt.localeCompare(left.createdAt)
  })
}

/**
 * Sidebar sessions for one tab. Every tab lists all unarchived sessions of
 * the workspace — live rows first — since a task may reference any of them;
 * the archive tab additionally lists archived sessions at the end, which the
 * UI renders as its offline module. Archived sessions own no active work, so
 * they never appear on the active tab.
 */
export function sessionsForTab(
  sessions: readonly SessionView[],
  archiveMode: boolean,
): SessionView[] {
  const unarchived = sessions.filter(session => !session.archived)
  if (!archiveMode) return unarchived.sort((left, right) => Number(right.live) - Number(left.live))
  const archived = sessions.filter(session => session.archived)
  return [
    ...unarchived.sort((left, right) => Number(right.live) - Number(left.live)),
    ...archived.sort((left, right) => Number(right.live) - Number(left.live)),
  ]
}

/** True when any staff row is missing a task-period token delta. */
export function hasUnreadableTokens(staff: readonly StaffEntry[]): boolean {
  return staff.some(entry => entry.tokensInTask === null)
}

const EMPTY_SNAPSHOT: PanelSnapshot = {
  workspaces: [],
  sessions: [],
  tasks: [],
  flows: [],
  stats: EMPTY_STATS,
  instanceStale: false,
  staleMessage: null,
  recoveredWorkers: 0,
  recoveryAt: null,
}

/** Empty snapshot used before the first successful poll (and on hard failure). */
export function emptySnapshot(): PanelSnapshot {
  return EMPTY_SNAPSHOT
}

/** One node in the workspace DAG: the task plus its topological depth. */
export interface DagNode {
  readonly task: TaskView
  readonly depth: number
}

/** A directed edge: `from` is the predecessor, `to` is the dependent. */
export interface DagEdge {
  readonly from: string
  readonly to: string
}

/** Laid-out box for one DAG node (compact layered placement). */
export interface DagBox {
  readonly id: string
  readonly task: TaskView
  readonly depth: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export const DAG_NODE_W = 176
export const DAG_NODE_H = 64
export const DAG_GAP_X = 64
export const DAG_GAP_Y = 22
export const DAG_PAD = 20

function predecessorsOf(task: TaskView): readonly string[] {
  return task.dependencies ?? []
}

function successorsOf(task: TaskView): readonly string[] {
  return task.dependents ?? []
}

function reaches(from: string, target: string, adj: ReadonlyMap<string, readonly string[]>): boolean {
  const stack = [from]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    const next = adj.get(current)
    if (next === undefined) continue
    for (const id of next) stack.push(id)
  }
  return false
}

/**
 * Build the workspace DAG: nodes keep topological depth (longest path from
 * a root); edges run predecessor → dependent. Cycles are skipped defensively
 * (the ledger already rejects them on write). Isolated tasks sit at depth 0.
 */
export function dagOf(tasks: readonly TaskView[]): { nodes: DagNode[]; edges: DagEdge[] } {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const adj = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  const edges: DagEdge[] = []

  const ordered = [...tasks].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt)
    return created !== 0 ? created : left.id.localeCompare(right.id)
  })

  for (const task of ordered) {
    for (const dep of predecessorsOf(task)) {
      if (dep === task.id || !byId.has(dep)) continue
      if (reaches(task.id, dep, adj)) continue
      const tos = adj.get(dep)
      if (tos === undefined) adj.set(dep, [task.id])
      else tos.push(task.id)
      const froms = incoming.get(task.id)
      if (froms === undefined) incoming.set(task.id, [dep])
      else froms.push(dep)
      edges.push({ from: dep, to: task.id })
    }
  }

  const depth = new Map<string, number>()
  const walk = (id: string, stack: Set<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0
    stack.add(id)
    const preds = incoming.get(id) ?? []
    let next = 0
    if (preds.length > 0) {
      next = 1
      for (const pred of preds) {
        const candidate = walk(pred, stack) + 1
        if (candidate > next) next = candidate
      }
    }
    stack.delete(id)
    depth.set(id, next)
    return next
  }

  const nodes = tasks.map(task => ({ task, depth: walk(task.id, new Set()) }))
  return { nodes, edges }
}

/**
 * Compact layered layout: one column per depth, rows packed by createdAt.
 */
export function layoutDag(
  graph: { readonly nodes: readonly DagNode[]; readonly edges: readonly DagEdge[] },
  opts?: {
    readonly nodeW?: number
    readonly nodeH?: number
    readonly gapX?: number
    readonly gapY?: number
    readonly pad?: number
  },
): { boxes: DagBox[]; width: number; height: number } {
  const nodeW = opts?.nodeW ?? DAG_NODE_W
  const nodeH = opts?.nodeH ?? DAG_NODE_H
  const gapX = opts?.gapX ?? DAG_GAP_X
  const gapY = opts?.gapY ?? DAG_GAP_Y
  const pad = opts?.pad ?? DAG_PAD

  const columns = new Map<number, DagNode[]>()
  let maxDepth = 0
  for (const node of graph.nodes) {
    if (node.depth > maxDepth) maxDepth = node.depth
    const column = columns.get(node.depth)
    if (column === undefined) columns.set(node.depth, [node])
    else column.push(node)
  }
  for (const column of columns.values()) {
    column.sort((left, right) => {
      const created = left.task.createdAt.localeCompare(right.task.createdAt)
      return created !== 0 ? created : left.task.id.localeCompare(right.task.id)
    })
  }

  const boxes: DagBox[] = []
  let height = pad * 2
  for (const [depth, column] of columns) {
    column.forEach((node, index) => {
      const y = pad + index * (nodeH + gapY)
      boxes.push({
        id: node.task.id,
        task: node.task,
        depth,
        x: pad + depth * (nodeW + gapX),
        y,
        w: nodeW,
        h: nodeH,
      })
      const bottom = y + nodeH + pad
      if (bottom > height) height = bottom
    })
  }

  const width = graph.nodes.length === 0
    ? pad * 2
    : pad * 2 + (maxDepth + 1) * nodeW + maxDepth * gapX
  return { boxes, width, height }
}

/**
 * Walk the dependency cone of one task. Upstream follows `dependencies`,
 * downstream follows `dependents`. The focus node itself is omitted.
 */
export function dependencyChainOf(
  taskId: string,
  nodes: readonly DagNode[],
): { upstream: TaskView[]; downstream: TaskView[] } {
  const byId = new Map(nodes.map(node => [node.task.id, node.task]))
  const walk = (start: string, nextOf: (task: TaskView) => readonly string[]): TaskView[] => {
    const out: TaskView[] = []
    const seen = new Set<string>([start])
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      const task = byId.get(current)
      if (task === undefined) continue
      for (const id of nextOf(task)) {
        if (seen.has(id)) continue
        seen.add(id)
        const next = byId.get(id)
        if (next === undefined) continue
        out.push(next)
        stack.push(id)
      }
    }
    return out
  }
  return {
    upstream: walk(taskId, predecessorsOf),
    downstream: walk(taskId, successorsOf),
  }
}

/**
 * Client-side blockedBy: a predecessor is satisfied only when it settled
 * with `outcome === 'success'`. Missing ids stay blocking.
 */
export function blockedByOf(task: TaskView, tasks: readonly TaskView[]): readonly string[] {
  const byId = new Map(tasks.map(item => [item.id, item]))
  return predecessorsOf(task).filter(id => {
    const dep = byId.get(id)
    if (dep === undefined) return true
    return !(dep.status === 'completed' && dep.outcome === 'success')
  })
}

/**
 * Readable copy for a failure that the scheduler propagated down the DAG.
 * Other reasons stay `null` so the view does not invent a dependency badge.
 */
export function failureReasonOf(task: TaskView): string | null {
  if (task.reason === 'dependency-failed') return '依赖失败'
  if (task.reason === 'dependency-canceled') return '依赖已取消'
  return null
}

/** True when any declared predecessor is terminally failed or canceled. */
export function hasFailedDependency(task: TaskView, tasks: readonly TaskView[]): boolean {
  const byId = new Map(tasks.map(item => [item.id, item]))
  return predecessorsOf(task).some(id => {
    const dep = byId.get(id)
    return dep !== undefined && (dep.status === 'failed' || dep.status === 'canceled')
  })
}

/**
 * @deprecated v1.4 uses the explicit `queued` status. Kept for older tests.
 */
export function isReadyUndelivered(task: TaskView, tasks: readonly TaskView[]): boolean {
  return task.status === 'queued' && blockedByOf(task, tasks).length === 0
}

/** Flows of one workspace: active first, then archived. */
export function flowsOfWorkspace(
  flows: readonly FlowView[],
  workspacePath: string | null,
): FlowView[] {
  const scoped = workspacePath === null
    ? [...flows]
    : flows.filter(flow => flow.workspacePath === workspacePath)
  return scoped.sort((left, right) => Number(left.archived) - Number(right.archived))
}

/** Tasks that belong to one flow. Flow-less rows never appear in a DAG. */
export function tasksOfFlow(tasks: readonly TaskView[], flowId: string | null): TaskView[] {
  if (flowId === null) return []
  return tasks.filter(task => task.flowId === flowId)
}

/**
 * The DAG's archive rule: a node is archived when its task is manually
 * archived (`archive_task` / `archive_flow`). Nothing moves a node out of the
 * active DAG automatically — no status, clock, or executor-liveness rule.
 */
export function isDagArchived(task: TaskView): boolean {
  return isArchived(task)
}

/**
 * v1.4 §6.1: active tasks plus every recursive predecessor, so an archived
 * ancestor chain stays visible beside live work. Terminal-failed tasks are
 * not anchors but still appear when an active task depends on them.
 * Isolated archived tasks drop off the graph.
 */
export function visibleDagTasks(tasks: readonly TaskView[]): TaskView[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const keep = new Set<string>()
  const walk = (id: string): void => {
    if (keep.has(id)) return
    const task = byId.get(id)
    if (task === undefined) return
    keep.add(id)
    for (const dep of predecessorsOf(task)) walk(dep)
  }
  for (const task of tasks) {
    if (!isDagArchived(task)) walk(task.id)
  }
  return tasks.filter(task => keep.has(task.id))
}

/** Archived node on a live chain: faded, not interactive. */
export function isDagFaded(task: TaskView): boolean {
  return isDagArchived(task)
}

/** Queued with every predecessor settled — the client scheduler may POST /dispatch. */
export function isReadyToDispatch(task: TaskView, tasks: readonly TaskView[]): boolean {
  return task.status === 'queued' && blockedByOf(task, tasks).length === 0
}

/** Color of a node on a highlighted dependency chain. */
export type ChainTone = 'ok' | 'wait' | 'fail'

/** Upstream tone: settled success / still open / terminal failure. */
export function chainToneOf(task: TaskView): ChainTone {
  if (task.status === 'failed' || task.status === 'canceled') return 'fail'
  if (task.status === 'completed' && task.outcome === 'success') return 'ok'
  return 'wait'
}
