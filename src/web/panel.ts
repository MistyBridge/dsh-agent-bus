/**
 * Panel snapshot builder for the v1.1 task panel route.
 *
 * Serves the browser floater one whole workspace-scoped snapshot per poll:
 * the workspace directory, the session directory (with live flags), every
 * task projected to the panel's read view, and status counters. All inputs
 * come through `ctx.get` so the snapshot degrades — never throws — when a
 * service the Web profile mounts is absent.
 *
 * Token figures are the panel's only non-ledger data. A session's global
 * usage is dsh's own (token-meter projection, shown by the native UI); this
 * module only computes the task-period delta (`tokensAtStart` snapshot taken
 * at dispatch, see tools.ts) and its sum. Staff rows whose current projection
 * or starting snapshot is unavailable carry `null` and the sum is partial.
 *
 * @module dsh-agent-bus/panel
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry, Workspace } from '@deepseek-ai/dsh-workspace'
import type { ReportStore } from '../external.ts'
import { blockedByOf, type TaskLedger } from '../ledger/ledger.ts'
import type { TaskOutcome, TaskRecord, TokenBuckets } from '../domain/types.ts'
import { fallbackTitle, readTitlesFile } from '../titles.ts'

export type { TokenBuckets } from '../domain/types.ts'

/** Four-bucket token usage reported by the token-meter projection. */
const TOKEN_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

/** Whether a value has the token-meter projection's bucket shape. */
export function isTokenBuckets(value: unknown): value is TokenBuckets {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return TOKEN_KEYS.every(key =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) && record[key] >= 0)
}

/** One workspace entry in the snapshot directory. */
export interface WorkspaceView {
  readonly id: string
  readonly title: string
  readonly path: string
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

/** One participant on a task card's staff directory. */
export interface StaffEntry {
  readonly sessionId: string
  readonly title: string
  readonly role: 'initiator' | 'executor' | 'reviewer'
  readonly live: boolean
  /** Task-period token delta; unavailable projection or start snapshot → null. */
  readonly tokensInTask: TokenBuckets | null
}

/** One task row projected for the panel. Report text is never included. */
export interface TaskView {
  readonly id: string
  readonly workspacePath: string
  readonly status: TaskRecord['status']
  readonly settled: boolean
  readonly content: string
  readonly title: string | null
  readonly contentPreview: string
  readonly mode: TaskRecord['mode']
  readonly assignedBy: string
  readonly assignedTo: string | null
  readonly assignedReviewer: string | null
  readonly byTitle: string
  readonly toTitle: string | null
  readonly reviewerTitle: string | null
  readonly retries: number
  readonly reason: string | null
  /**
   * The reviewer's verdict, `null` while a completed row awaits settlement.
   * Always materialized by the builder (`task.outcome ?? null`), matching the
   * client view-model's non-optional declaration.
   */
  readonly outcome: TaskOutcome | null
  readonly feedback: string | null
  readonly question: string | null
  /** Structured questions pending the initiator's answer (decision 9); null when none. */
  readonly pendingQuestions: readonly {
    readonly id: string
    readonly question: string
    readonly options: readonly string[]
  }[] | null
  readonly reportZone: 'inline' | 'hot' | 'cold' | 'missing' | null
  readonly hasReportRef: boolean
  readonly turn: number | null
  readonly staff: readonly StaffEntry[]
  readonly taskTokensTotal: TokenBuckets | null
  /** Whether the executor (assignedTo) is live; kept for display, not partition. */
  readonly executorLive: boolean
  /** Manual archive marker; absent = active. Set by the user, never by the lifecycle. */
  readonly archived: boolean
  /** DAG predecessors (task ids), in declaration order; empty when none. */
  readonly dependencies: readonly string[]
  /** The dispatcher's minimum acceptance requirement (v1.4); null when unset. */
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

/**
 * Legacy constant from the (removed) automatic-archive model. Kept so host and
 * client reference one archive-age value and tests assert they agree; it no
 * longer drives any archive decision.
 */
export const ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000

/** Status counters, mirroring the client panel-model keys. */
export interface PanelStats {
  readonly queued: number
  readonly submitted: number
  readonly working: number
  readonly 'input-required': number
  readonly completed: number
  readonly failed: number
  readonly canceled: number
  readonly total: number
}

/** One flow in the snapshot directory (v1.4): a named DAG container. */
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

/** The full document served by GET /plugins/dsh-agent-bus/state. */
export interface PanelSnapshot {
  readonly workspaces: readonly WorkspaceView[]
  /** Flow directory for the DAG view; archived flows follow the derived rule. */
  readonly flows: readonly FlowView[]
  readonly sessions: readonly SessionView[]
  readonly tasks: readonly TaskView[]
  readonly stats: PanelStats
  /**
   * Whether the running host instance predates the latest build (decision 7):
   * the loaded code's build fingerprint differs from the disk fingerprint.
   */
  readonly instanceStale: boolean
  /** Explanation for a stale instance; null when current. */
  readonly staleMessage: string | null
  /**
   * How many stranded workers this boot re-woke (decision 10 C): zero means
   * no recovery happened (fresh boot or nothing stranded).
   */
  readonly recoveredWorkers: number
  /** Timestamp (epoch ms) of the last startup recovery; null when none. */
  readonly recoveryAt: number | null
}

/** The decision-7 staleness verdict computed once at plugin startup. */
export interface StaleInfo {
  readonly stale: boolean
  readonly message: string | null
}

/** The decision-10 C startup-recovery record (workers re-woken this boot). */
export interface RecoveryInfo {
  readonly recoveredWorkers: number
  readonly recoveryAt: number | null
}

/** A current instance: no stale hint, no message, no recovery record. */
const CURRENT_INSTANCE: StaleInfo = { stale: false, message: null }

/** No recovery this boot. */
const NO_RECOVERY: RecoveryInfo = { recoveredWorkers: 0, recoveryAt: null }

/** Structural face of the projection registry (Service, optional at runtime). */
interface ProjectionRegistryLike {
  snapshot(session: Session): { values: Record<string, unknown> }
}

/** Structural face of the agent registry (already injected as `agents`). */
interface AgentRegistryLike {
  get(id: string): Agent | undefined
}

/** Mutable stats accumulator; the builder fills it in creation order. */
type MutableStats = { -readonly [K in keyof PanelStats]: number }

/** Empty stats row. */
function emptyStats(): MutableStats {
  return {
    queued: 0, submitted: 0, working: 0, 'input-required': 0,
    completed: 0, failed: 0, canceled: 0, total: 0,
  }
}

/**
 * Truncate by Unicode code point so a surrogate pair (emoji) is never split;
 * overflow is marked with a single ellipsis. Mirrors the client model.
 *
 * @param text - the text to truncate.
 * @param max - maximum code points before the ellipsis.
 * @returns the truncated text.
 */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return text === '' ? '' : '…'
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, max).join('')}…`
}

/**
 * Locate an externalized report in the two-zone store.
 *
 * @param reports - the report store.
 * @param task - the row whose report zone is asked for.
 * @returns `'inline'` when the report rides the row, `'hot'` / `'cold'` when
 *   the file exists in the matching zone, `'missing'` when the reference
 *   names a file in neither zone, and `null` when the task has no report.
 */
export async function detectReportZone(
  reports: ReportStore,
  task: TaskRecord,
): Promise<TaskView['reportZone']> {
  if (task.report !== undefined && task.reportRef === undefined) return 'inline'
  if (task.reportRef === undefined) return null
  if (await reports.existsHot(task.reportRef)) return 'hot'
  if (await reports.existsCold(task.reportRef)) return 'cold'
  return 'missing'
}

/** Whether a completed row has been settled. */
function isSettled(task: TaskRecord): boolean {
  return task.status === 'completed'
    ? task.outcome !== undefined
    : task.status === 'failed' || task.status === 'canceled'
}

/** One role of the staff directory, in display order. */
type StaffRole = 'executor' | 'reviewer' | 'initiator'

/** Staff assembly input: session id plus the role it plays. */
interface RoleSlot {
  readonly sessionId: string
  readonly role: StaffRole
}

/**
 * The staff of one task from its three role holders: executor, reviewer,
 * initiator — deduplicated by session id (the initiator reviewing its own
 * task appears once, as executor or reviewer), fixed order executor →
 * reviewer → initiator. The reviewer defaults to the initiator.
 *
 * @param initiator - the dispatching session.
 * @param executor - the worker; may be absent until dispatched.
 * @param reviewer - the settling session; `undefined` falls back to the initiator.
 * @returns the role slots in display order.
 */
export function staffRoles(
  initiator: string | undefined,
  executor: string | undefined,
  reviewer: string | undefined,
): readonly RoleSlot[] {
  const slots: RoleSlot[] = []
  const seen = new Set<string>()
  const push = (sessionId: string | undefined, role: StaffRole): void => {
    if (sessionId === undefined || seen.has(sessionId)) return
    seen.add(sessionId)
    slots.push({ sessionId, role })
  }
  push(executor, 'executor')
  push(reviewer ?? initiator, 'reviewer')
  push(initiator, 'initiator')
  return slots
}

/**
 * The staff of one ledger row (see {@link staffRoles}).
 *
 * @param task - the row.
 * @returns the role slots in display order.
 */
export function staffRolesOf(task: TaskRecord): readonly RoleSlot[] {
  return staffRoles(task.assignedBy, task.assignedTo, task.assignedReviewer)
}

/**
 * The task-period token delta for one session: current projection minus the
 * dispatch-time snapshot, clamped at zero. Either side unavailable → null.
 *
 * @param projections - the projection registry, or `undefined` when absent.
 * @param agents - the agent registry (live sessions only).
 * @param task - the row holding the `tokensAtStart` snapshot.
 * @param sessionId - the staff session.
 * @returns the delta buckets, or `null` when it cannot be computed.
 */
export function tokenDeltaOf(
  projections: ProjectionRegistryLike | undefined,
  agents: AgentRegistryLike | undefined,
  task: TaskRecord,
  sessionId: string,
): TokenBuckets | null {
  const start = task.tokensAtStart?.[sessionId]
  if (start === undefined) return null
  const agent = agents?.get(sessionId)
  const current = agent === undefined ? undefined : projections?.snapshot(agent.session).values.tokenUsage
  if (!isTokenBuckets(current)) return null
  const clamp = (a: number, b: number): number => Math.max(0, a - b)
  return {
    uncachedInputTokens: clamp(current.uncachedInputTokens, start.uncachedInputTokens),
    outputTokens: clamp(current.outputTokens, start.outputTokens),
    cacheReadTokens: clamp(current.cacheReadTokens, start.cacheReadTokens),
    cacheWriteTokens: clamp(current.cacheWriteTokens, start.cacheWriteTokens),
  }
}

/** Sum token buckets; `null` when every input is null (never partial here). */
function sumTokens(entries: readonly (TokenBuckets | null)[]): TokenBuckets | null {
  let total: TokenBuckets | null = null
  for (const entry of entries) {
    if (entry === null) continue
    total = total === null
      ? { ...entry }
      : {
        uncachedInputTokens: total.uncachedInputTokens + entry.uncachedInputTokens,
        outputTokens: total.outputTokens + entry.outputTokens,
        cacheReadTokens: total.cacheReadTokens + entry.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + entry.cacheWriteTokens,
      }
  }
  return total
}

/**
 * Build the panel's task view for one row: projection plus zone and staff.
 * Exported for unit tests with stub dependencies.
 *
 * @param task - the ledger row.
 * @param titles - session id → title.
 * @param agents - agent registry for live flags and projections.
 * @param projections - projection registry for token deltas.
 * @param reports - the two-zone report store (zone detection).
 * @param now - snapshot clock (ms since epoch).
 * @returns the projected row.
 */
export async function buildTaskView(
  task: TaskRecord,
  titles: ReadonlyMap<string, string>,
  agents: AgentRegistryLike | undefined,
  projections: ProjectionRegistryLike | undefined,
  reports: ReportStore,
  now: number,
): Promise<TaskView> {
  const titleOf = (sessionId: string | undefined): string | null =>
    sessionId === undefined ? null : titles.get(sessionId) ?? fallbackTitle(sessionId)
  const liveOf = (sessionId: string | undefined): boolean =>
    sessionId !== undefined && agents?.get(sessionId) !== undefined

  const staff: StaffEntry[] = staffRolesOf(task).map(({ sessionId, role }) => ({
    sessionId,
    title: titles.get(sessionId) ?? fallbackTitle(sessionId),
    role,
    live: liveOf(sessionId),
    tokensInTask: tokenDeltaOf(projections, agents, task, sessionId),
  }))

  return {
    id: task.id,
    workspacePath: task.workspacePath,
    status: task.status,
    settled: isSettled(task),
    dependencies: [...(task.dependencies ?? [])],
    acceptanceCriteria: task.acceptanceCriteria ?? null,
    flowId: task.flowId ?? null,
    content: task.content,
    title: task.title ?? null,
    contentPreview: truncateCodePoints(task.content, 120),
    mode: task.mode,
    assignedBy: task.assignedBy,
    assignedTo: task.assignedTo ?? null,
    assignedReviewer: task.assignedReviewer ?? null,
    byTitle: titleOf(task.assignedBy) ?? fallbackTitle(task.assignedBy),
    toTitle: titleOf(task.assignedTo),
    reviewerTitle: titleOf(task.assignedReviewer ?? task.assignedBy),
    retries: task.retries,
    reason: task.reason ?? null,
    outcome: task.outcome ?? null,
    feedback: task.feedback !== undefined ? truncateCodePoints(task.feedback, 200) : null,
    question: task.question !== undefined ? truncateCodePoints(task.question, 200) : null,
    pendingQuestions: task.pendingQuestions !== undefined && task.pendingQuestions.length > 0
      ? task.pendingQuestions.map(question => ({
        id: question.id,
        question: truncateCodePoints(question.question, 200),
        options: question.options.map(option => option.label),
      }))
      : null,
    reportZone: await detectReportZone(reports, task),
    hasReportRef: task.reportRef !== undefined,
    turn: task.turn ?? null,
    staff,
    taskTokensTotal: sumTokens(staff.map(entry => entry.tokensInTask)),
    executorLive: task.assignedTo !== undefined && agents?.get(task.assignedTo) !== undefined,
    archived: task.archived === true,
    dependents: [],
    blockedBy: [],
    auto: task.auto === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ageMs: Math.max(0, now - Date.parse(task.createdAt)),
    updatedMs: Math.max(0, now - Date.parse(task.updatedAt)),
  }
}

/**
 * The session directory: every session the workspace registry indexes — the
 * harness sidebar's own index, byte for byte. The plugin adds no session
 * logic of its own: no log probes, no mtime windows, no attach heuristics.
 * Sessions referenced by tasks but missing from the registry are added by
 * the caller as offline references.
 *
 * Archived sessions keep their registry slot (archiving never touches
 * workspace accounting), so they stay in the directory flagged archived; the
 * UI's archive tab
 * renders them in its offline module. Blank seeds (a log file of metadata
 * only) are excluded exactly like the harness sidebar hides them.
 *
 * @param ctx - plugin context; the session store is optional at runtime.
 * @param now - probe clock.
 * @returns the authoritative set of visible session ids.
 */
async function visibleSessionIds(ctx: Context): Promise<Set<string>> {
  // The workspace registry is the ONLY authority, byte for byte the harness
  // sidebar's source: `sessionIds` is already filtered by the registry's
  // header index, so whatever the sidebar shows is exactly this set. No log
  // probes, no mtime windows, no store heuristics — the plugin adds no
  // session logic of its own. Archived sessions keep their slot (archiving
  // never touches workspace accounting), so they stay in this set and the
  // archived flag comes from the archive set.
  const ids = new Set<string>()
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  for (const workspace of registry?.list() ?? []) {
    for (const sessionId of workspace.sessionIds) {
      ids.add(String(sessionId))
    }
  }
  return ids
}

/**
 * Assemble the full snapshot: workspace directory, session directory, all
 * tasks, and counters. Any missing service degrades to empty arrays / nulls.
 *
 * @param ctx - the plugin context (services read via `ctx.get`).
 * @param ledger - the task ledger.
 * @param reports - the two-zone report store.
 * @param now - snapshot clock (ms since epoch); defaults to the current time.
 * @param instance - the decision-7 staleness verdict computed at startup;
 *   defaults to a current instance (no hint).
 * @returns the snapshot document.
 */
export async function buildPanelSnapshot(
  ctx: Context,
  ledger: TaskLedger,
  reports: ReportStore,
  now: number = Date.now(),
  instance: StaleInfo = CURRENT_INSTANCE,
  recovery: RecoveryInfo = NO_RECOVERY,
): Promise<PanelSnapshot> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  const workspaces = registry?.list() ?? []
  const agents = ctx.get('agents') as AgentRegistryLike | undefined
  const projections = ctx.get('sessionProjections') as ProjectionRegistryLike | undefined
  const titles = await readTitlesFile(
    dshHomePath('storages', 'session_projcache.json'),
  )
  // Live sessions: the title MUST match what the harness sidebar shows. The
  // sidebar reads the session-title projection ('title'), so the same
  // projection value overrides the disk cache for every live session; the
  // projection may legitimately be absent (title not generated yet), in which
  // case the disk value — or the id-prefix fallback — stands.
  const sessionStore = ctx.get('sessions') as { list(): { id: string; header: { origin?: string } }[] } | undefined
  if (agents !== undefined && projections !== undefined) {
    for (const session of sessionStore?.list() ?? []) {
      if (session.header.origin === 'subagent') continue
      const agent = agents.get(session.id)
      if (agent === undefined) continue
      const title = projections.snapshot(agent.session).values.title
      if (typeof title === 'string' && title !== '') titles.set(session.id, title)
    }
  }

  // Session directory: every visible session (sidebar same-source), mapped to
  // its owning workspace through the registry account, plus any session a
  // task references that is no longer visible (an offline reference).
  const registrySessionWorkspace = new Map<string, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      registrySessionWorkspace.set(String(sessionId), String(workspace.id))
    }
  }
  const visible = await visibleSessionIds(ctx)
  const archivedIds = new Set((registry?.archivedSessionIds ?? []).map(String))
  const sessionWorkspace = new Map<string, string>()
  for (const sessionId of visible) {
    sessionWorkspace.set(sessionId, registrySessionWorkspace.get(sessionId) ?? '')
  }
  for (const task of ledger.listAll()) {
    for (const sessionId of [task.assignedBy, task.assignedTo, task.assignedReviewer]) {
      if (sessionId !== undefined) sessionWorkspace.set(String(sessionId), sessionWorkspace.get(String(sessionId)) ?? '')
    }
  }
  const sessions: SessionView[] = []
  for (const [sessionId, workspaceId] of sessionWorkspace) {
    sessions.push({
      id: sessionId,
      title: titles.get(sessionId) ?? fallbackTitle(sessionId),
      workspaceId: workspaceId === '' ? null : workspaceId,
      live: agents?.get(sessionId) !== undefined,
      archived: archivedIds.has(sessionId),
    })
  }

  const tasks: TaskView[] = []
  const stats = emptyStats()
  const allRows = ledger.listAll()
  for (const task of allRows) {
    const view = await buildTaskView(task, titles, agents, projections, reports, now)
    tasks.push(view)
    stats.total += 1
    switch (task.status) {
      case 'queued':
      case 'submitted':
      case 'working':
      case 'input-required':
      case 'completed':
      case 'failed':
      case 'canceled':
        stats[task.status] += 1
        break
      default:
        break
    }
  }
  // DAG columns need the whole table: reverse edges and unsettled blockers.
  const rowById = new Map(allRows.map(row => [String(row.id), row]))
  for (let index = 0; index < tasks.length; index++) {
    const view = tasks[index]!
    const row = rowById.get(view.id)
    tasks[index] = {
      ...view,
      dependents: allRows
        .filter(item => (item.dependencies ?? []).some(dep => String(dep) === view.id))
        .map(item => String(item.id)),
      blockedBy: row === undefined ? [] : [...blockedByOf(row, allRows).map(String)],
    }
  }

  // Flow directory: manual archive per flow. The DAG view selects a flow and
  // renders only its tasks; a flow's archive status is a user action, never
  // derived from task state.
  const flows: FlowView[] = ledger.listFlows().map(flow => {
    const tasks = allRows.filter(row => row.flowId === flow.id)
    const unsettled = tasks.filter(row => !isSettled(row))
    return {
      id: flow.id,
      name: flow.name,
      description: flow.description ?? null,
      workspacePath: flow.workspacePath,
      taskCount: tasks.length,
      unsettledCount: unsettled.length,
      archived: flow.archived === true,
    }
  })

  return {
    workspaces: workspaces.map(workspace => ({
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
    })),
    sessions,
    tasks,
    flows,
    stats,
    instanceStale: instance.stale,
    staleMessage: instance.message,
    recoveredWorkers: recovery.recoveredWorkers,
    recoveryAt: recovery.recoveryAt,
  }
}
