/**
 * Shared tool-surface helpers, the tools' config/deps contract, and the common
 * surface both the domain modules and callers import.
 *
 * @module dsh-agent-bus/tools/common
 */

import { TaskId } from '../domain/types.ts'
import { authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath } from '../members/authorize.ts'
import { admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession } from '../delivery.ts'
import { blockedByOf } from '../ledger/ledger.ts'
import { isTokenBuckets, staffRoles } from '../web/panel.ts'
import { fallbackTitle, readTitlesFile } from '../titles.ts'
import { normalizeQuestionAnswers } from '../bridges/question-bridge.ts'
import { DispatchRateLimiter } from '../rate-limit.ts'
import { dispatchOne } from '../scheduler.ts'
import { wakeSession } from '../members/wake.ts'
import { onboardMember, parseCreateMemberInput } from '../members/create-member.ts'
import { setMemberRole } from '../members/member-config.ts'
import { parseReconfigureMemberInput, reconfigureMember } from '../members/reconfigure-member.ts'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { APPROVAL_POLICIES } from '@deepseek-ai/dsh-user-approval'
import { SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { randomUUID } from 'node:crypto'
import type { DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord } from '../domain/types.ts'
import type { Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason } from '../members/authorize.ts'
import type { ContentDecision, DeliverySource, NoticeSegment } from '../delivery.ts'
import type { TaskLedger, NewTask, LedgerResult, FlowResult } from '../ledger/ledger.ts'
import type { QuestionRegistry, PendingAsk, QuestionBridgeConfig } from '../bridges/question-bridge.ts'
import type { CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult } from '../members/create-member.ts'
import type { ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult } from '../members/reconfigure-member.ts'
import type { ReportStore } from '../external.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

export { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID }
export type { DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry }

export interface ToolsConfig {
  readonly maxContentLength: number
  readonly maxPendingPerAgent: number
  readonly maxSendsPerMinute: number
  /** Reports longer than this are externalized to the report store (default `400`). */
  readonly maxInlineReport: number
  /** Lightweight messages one sender may send per minute (default `20`). */
  readonly maxMessagesPerMinute: number
}

/** Services the tool bodies need beyond `ctx`. */
export interface ToolsDeps {
  readonly ledger: TaskLedger
  readonly workspaces: WorkspaceRegistry
  readonly limiter: DispatchRateLimiter
  /** Separate sliding window for send_note, so chatter cannot exhaust task quota. */
  readonly messageLimiter: DispatchRateLimiter
  readonly reports: ReportStore
  /** Pending question asks shared with the question bridge (decision 9). */
  readonly questions: QuestionRegistry
  /**
   * Record one executor-activity signal for the stranded-recovery heartbeat
   * cooldown (decision 2): the owning plugin keeps the `sessionId → last
   * activity` map; tools that prove the worker is on the task call this.
   */
  readonly noteActivity: (sessionId: SessionId) => void
}

/** Model-facing projection of one ledger row for listings. */
interface TaskView {
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

function view(task: TaskRecord): TaskView {
  // Undefined optional fields are omitted: the harness rejects tool output
  // that is not lossless JSON, and JSON.stringify drops undefined keys.
  return {
    id: task.id,
    status: task.status,
    from: task.assignedBy,
    ...(task.assignedTo !== undefined ? { to: task.assignedTo } : {}),
    content: task.content,
    ...(task.title !== undefined ? { title: task.title } : {}),
    ...(task.report !== undefined ? { report: task.report } : {}),
    ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
    ...(task.reason !== undefined ? { reason: task.reason } : {}),
    ...(task.dependencies !== undefined ? { dependencies: task.dependencies.map(String) } : {}),
    ...(task.acceptanceCriteria !== undefined ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
    retries: task.retries,
  }
}

/**
 * Render one task row for the model.
 *
 * A completed task's report is the evidence a dispatcher settles on, so it is
 * printed rather than summarized; the verdict appears once recorded. The
 * truncation caps are listing hygiene only — get_task reads the full record.
 *
 * @param t - the projected row.
 * @returns the text lines for one row.
 */

/**
 * Whether one row is visible to the agent tools — the active set only.
 *
 * Archiving is a user action, never automatic: a task stays in the active set
 * until the user archives it (`archive_task`), and unarchiving restores it.
 * Nothing in the lifecycle machine moves a row out on its own.
 *
 * @param row - the ledger row.
 * @param now - kept for call-site compatibility; archive is manual, so the
 *   clock no longer drives visibility.
 * @returns `true` when the row belongs to the active set.
 */
export function isActiveTask(row: TaskRecord, _now: number): boolean {
  return row.archived !== true
}

/**
 * Whether one row has reached a terminal settled verdict. Mirrors the panel's
 * `isSettled`: a completed row is settled once a verdict is recorded; failed
 * and canceled rows count as settled regardless of a verdict.
 *
 * @param row - the ledger row.
 * @returns `true` when the row is settled.
 */
function isSettledTask(row: TaskRecord): boolean {
  return row.status === 'completed'
    ? row.outcome !== undefined
    : row.status === 'failed' || row.status === 'canceled'
}

export function renderTaskRow(t: TaskView): string {
  // Status badges mirror the panel: 「待投递」 for a queued (undelivered) task
  // and 「待验收」 for a completed row awaiting its verdict.
  const badge = t.status === 'queued'
    ? 'queued 待投递'
    : t.status === 'completed' && t.outcome === undefined
      ? 'completed 待验收'
      : t.status
  const label = t.title !== undefined && t.title !== '' ? t.title : t.content.slice(0, 80)
  const head = `${t.id} [${badge}] ${label}`
  const report = t.report !== undefined
    ? `\n  submitted result: ${t.report.slice(0, 400)}`
    : ''
  const verdict = t.outcome !== undefined ? `\n  verdict: ${t.outcome}` : ''
  const reason = t.reason !== undefined ? `\n  reason: ${t.reason}` : ''
  const deps = t.dependencies !== undefined && t.dependencies.length > 0
    ? `\n  depends on: ${t.dependencies.join(', ')}`
    : ''
  return head + report + verdict + reason + deps
}

/** Model-facing projection of one full task record. */
interface TaskDetailView {
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

function detailView(task: TaskRecord): TaskDetailView {
  return {
    id: task.id,
    status: task.status,
    from: task.assignedBy,
    ...(task.assignedTo !== undefined ? { to: task.assignedTo } : {}),
    content: task.content,
    ...(task.title !== undefined ? { title: task.title } : {}),
    ...(task.acceptanceCriteria !== undefined ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
    ...(task.handoffs !== undefined
      ? { handoffs: task.handoffs.map(handoff => ({
        fromTask: String(handoff.fromTask),
        document: handoff.document,
        at: handoff.at,
      })) }
      : {}),
    ...(task.report !== undefined ? { report: task.report } : {}),
    ...(task.question !== undefined ? { question: task.question } : {}),
    ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
    ...(task.feedback !== undefined ? { feedback: task.feedback } : {}),
    ...(task.reason !== undefined ? { reason: task.reason } : {}),
    ...(task.assignedReviewer !== undefined ? { reviewer: task.assignedReviewer } : {}),
    retries: task.retries,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * Decide whether one session may read a task.
 *
 * Decision 4: a LIVE task (queued / submitted / working / input-required /
 * auth-required) is readable by its participants — dispatcher, executor,
 * reviewer — alone; workspace membership no longer grants read access.
 * Completed and terminally-failed tasks are history and public. Task ids can
 * reach non-participants through relayed messages and future visibility
 * surfaces, so the gate stays even where ids are undiscoverable today.
 *
 * @param task - the row being read.
 * @param callerId - the session requesting the read.
 * @returns `true` when the read is authorized.
 */
export function canReadTask(task: TaskRecord, callerId: SessionId): boolean {
  return authorizeTaskRead(task, callerId) === undefined
}

/**
 * Render one full task record.
 *
 * get_task exists so a listing's truncation caps never cost information: the
 * content and report are printed complete here.
 *
 * @param t - the projected full record.
 * @returns the text of the record.
 */
export function renderTaskDetail(t: TaskDetailView): string {
  const lines = [
    `${t.id} [${t.status}]`,
    `from: ${t.from}`,
    ...(t.to !== undefined ? [`to: ${t.to}`] : []),
    `retries: ${t.retries}`,
    `created: ${t.createdAt}`,
    `updated: ${t.updatedAt}`,
    'task:',
    t.content,
    ...(t.title !== undefined ? ['title:', t.title] : []),
  ]
  if (t.acceptanceCriteria !== undefined) lines.push('acceptance criteria:', t.acceptanceCriteria)
  if (t.handoffs !== undefined && t.handoffs.length > 0) {
    lines.push('handoff documents:')
    for (const handoff of t.handoffs) {
      lines.push(`  from ${handoff.fromTask}:`, handoff.document)
    }
  }
  if (t.question !== undefined) lines.push('question:', t.question)
  if (t.report !== undefined) lines.push('submitted result:', t.report)
  if (t.outcome !== undefined) lines.push(`verdict: ${t.outcome}`)
  if (t.feedback !== undefined) lines.push(`feedback: ${t.feedback}`)
  if (t.reason !== undefined) lines.push(`reason: ${t.reason}`)
  if (t.reviewer !== undefined) lines.push(`reviewer: ${t.reviewer}`)
  return lines.join('\n')
}

/** Require a calling agent, since every operation is session-scoped. */
function requireCaller(agent: { id: SessionId } | undefined, tool: string): SessionId {
  if (agent === undefined) {
    throw new Error(`${tool} requires a calling agent (exec.agent was undefined)`)
  }
  return agent.id
}

/**
 * Resolve a peer target that may be either a session id or a peer title.
 *
 * `send_note` / `create_task` / `reassign_task` accept a target the caller
 * read from `list_peers`, which prints both the peer's title and its session
 * id. Resolution runs before authorization so the authorize* functions always
 * receive a concrete session id: an exact id match within the caller's
 * workspace wins first; otherwise the value is matched by title among the
 * live peers of the caller's workspace (the same title source `list_peers`
 * renders). A title that names more than one peer is refused as ambiguous —
 * the id is the unambiguous handle. An unmatched value is returned unchanged
 * so the authorize* gate still produces its workspace-membership refusal.
 *
 * @param ctx - plugin context carrying the live agent and title registries.
 * @param workspaces - the workspace registry service.
 * @param callerId - the session claiming to act.
 * @param value - the raw target value from the tool arguments.
 * @returns the resolved session id.
 */
async function resolvePeerTarget(
  ctx: Context,
  workspaces: WorkspaceRegistry,
  callerId: SessionId,
  value: string,
): Promise<SessionId> {
  const caller = ctx.agents.get(callerId)
  if (caller === undefined) {
    throw new Error('the calling session is not a live agent')
  }
  const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
  if (callerWorkspace === undefined) {
    throw new Error('the calling session is not inside a registered workspace, so it has no reachable peers')
  }

  const inCallerWorkspace = workspaces.list().some(workspace =>
    workspace.path === callerWorkspace
    && workspace.sessionIds.some(id => String(id) === value))
  if (inCallerWorkspace) return value as SessionId

  const matches: SessionId[] = []
  for (const agent of ctx.agents.list()) {
    if (String(agent.id) === String(callerId)) continue
    if (agent.session.header.origin === 'subagent') continue
    if (await resolveWorkspacePath(workspaces, agent) !== callerWorkspace) continue
    const title = ctx.sessionTitle.get(agent.session)?.title
    if (title !== undefined && title !== '' && title === value) matches.push(agent.id)
  }
  if (matches.length === 0) return value as SessionId
  if (matches.length > 1) {
    throw new Error(
      `target "${value}" is ambiguous: it matches ${matches.length} peers in your workspace; use the id from list_peers`,
    )
  }
  return matches[0]!
}

/**
 * Wake one session with a task notice.
 *
 * This is the loop-closing step of the lifecycle: report notifies the
 * reviewer, a failed settle wakes the worker for rework, a successful settle
 * returns the result to the initiator. Notices are one-directional by
 * construction — every step they invite is another tool call, never another
 * notice — so the loops cannot cycle. An offline session is skipped silently;
 * the ledger remains the durable record either way.
 *
 * @param ctx - context carrying the live Agent registry.
 * @param sessionId - the session to wake.
 * @param taskId - the task the notice concerns.
 * @param text - the notice body.
 */
/**
 * Snapshot the dispatch-time token totals of a task's participants.
 *
 * The panel computes task-period consumption as `current projection − this
 * snapshot`, so the snapshot is taken once, at dispatch, and never refreshed.
 * A participant that is offline, or a profile without the projection
 * registry, simply leaves its key out of the record — the panel then shows
 * that staff row's delta as unavailable.
 *
 * @param ctx - plugin context; services are read via `ctx.get` and may be absent.
 * @param initiator - the dispatching session.
 * @param executor - the target session.
 * @param reviewer - the named reviewer, or `undefined` for the initiator default.
 * @returns the token snapshot keyed by participant session id, or `undefined`
 *   when no participant's usage could be read.
 */
function snapshotTokensAtDispatch(
  ctx: Context,
  initiator: SessionId,
  executor: SessionId,
  reviewer: SessionId | undefined,
): Record<string, TokenBuckets> | undefined {
  const projections = ctx.get('sessionProjections') as
    | { snapshot(session: Session): { values: Record<string, unknown> } }
    | undefined
  const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
  if (projections === undefined || agents === undefined) return undefined
  const out: Record<string, TokenBuckets> = {}
  for (const { sessionId } of staffRoles(initiator, executor, reviewer)) {
    const agent = agents.get(sessionId)
    if (agent === undefined) continue
    const value = projections.snapshot(agent.session).values.tokenUsage
    if (isTokenBuckets(value)) out[sessionId] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Resolve the display title for one listed peer.
 *
 * A live peer's title is the session-title projection (the same source the
 * harness sidebar folds), matching what the model saw in the session directory;
 * a dormant peer has no live session, so its title comes from the durable
 * titles cache (`session_projcache.json`). Either falls back to the id-prefix
 * so every listed peer stays identifiable.
 *
 * @param ctx - plugin context carrying the session-title service.
 * @param titles - durable session id → title cache.
 * @param agent - the live agent, or `undefined` when the peer is dormant.
 * @param sessionId - the peer's session id.
 * @returns the title, always a non-empty string.
 */
function peerTitleOf(
  ctx: Context,
  titles: ReadonlyMap<string, string>,
  agent: Agent | undefined,
  sessionId: SessionId,
): string {
  if (agent !== undefined) {
    const liveTitle = ctx.sessionTitle.get(agent.session)?.title
    if (liveTitle !== undefined && liveTitle !== '') return liveTitle
  }
  return titles.get(String(sessionId)) ?? fallbackTitle(String(sessionId))
}

/** Collect every subagent session id: live origins plus persisted headers. */
async function subagentSessionIds(ctx: Context): Promise<Set<string>> {
  const out = new Set<string>()
  for (const agent of ctx.agents.list()) {
    if (agent.session.header.origin === 'subagent') out.add(String(agent.id))
  }
  const persistence = ctx.get('sessionPersistence') as
    | { list(): Promise<Array<{ id: SessionId; origin?: string }>> }
    | undefined
  if (persistence !== undefined) {
    try {
      for (const header of await persistence.list()) {
        if (header.origin === 'subagent') out.add(String(header.id))
      }
    } catch {
      // A persistence fault must not hide peers from a caller; degrade to the
      // live-origin set already collected.
    }
  }
  return out
}

/**
 * Register the fifteen agent-bus tools, each behind the output-schema gate
 * (`checkedTool`): an execute return that drifts from its declared
 * `output.schema` fails inside the tool with a structured, readable error
 * instead of the harness's bare rejection.
 *
 * @param ctx - context carrying the tool registry and live Agent registry.
 * @param config - resolved tunables.
 * @param deps - the opened ledger and the workspace registry.
 */

export { view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds }
export type { TaskView, TaskDetailView }

function assertFlowName(name: string): void {
  if (name.length === 0 || name.length > 20) {
    throw new Error('流程名不超过 20 字,并简明概括任务组核心内容')
  }
}

function randomTaskId(): string {
  return randomUUID()
}

export { assertFlowName, randomTaskId }
