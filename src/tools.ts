/**
 * The model-facing tool surface: the agent-bus tools over the ledger and the
 * delivery path, named after the A2A operation set where one exists.
 *
 * The surface stays deliberately small. The reference implementation this
 * draws on grew to 73 tools and had to fold them behind a router to keep the
 * prompt-cache prefix stable; the lesson taken here is not to build a router
 * but to never need one. Orchestration concerns — dependency graphs, goals,
 * file locks, shared knowledge — are a different capability and stay out.
 *
 * There is no receive-side tool. `followup()` turns a delivered task into an
 * ordinary turn on the recipient, so a worker reads its task as user input
 * with no claim step to perform.
 *
 * @module dsh-agent-bus/tools
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { APPROVAL_POLICIES } from '@deepseek-ai/dsh-user-approval'
import { SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { checkedTool } from './checked-tool.ts'
import {
  onboardMember,
  parseCreateMemberInput,
  type CreateMemberHost,
  type PermissionPresetHost,
  type PresetMountHost,
} from './members/create-member.ts'
import { setMemberRole } from './members/member-config.ts'
import {
  parseReconfigureMemberInput,
  reconfigureMember,
  type ReconfigureMemberHost,
} from './members/reconfigure-member.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath } from './members/authorize.ts'
import {
  admitContent,
  buildMessageMessage,
  buildTaskMessage,
  deliverTask,
  notifySession,
} from './delivery.ts'
import { TOOL_DOCS, TOOL_NAMES, type ToolName } from './tool-docs.ts'
import type { ReportStore } from './external.ts'
import { blockedByOf, type TaskLedger } from './ledger/ledger.ts'
import { isTokenBuckets, staffRoles } from './panel.ts'
import { fallbackTitle, readTitlesFile } from './titles.ts'
import { normalizeQuestionAnswers, type QuestionRegistry } from './question-bridge.ts'
import { DispatchRateLimiter } from './rate-limit.ts'
import { dispatchOne } from './scheduler.ts'
import { wakeSession } from './members/wake.ts'
import { TaskId, type DeliveryMode, type TaskRecord, type TokenBuckets } from './domain/types.ts'

/** Resolved plugin configuration the tools read. */
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
export function registerAgentBusTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

  // Preset names for the create_member permissions hint, read from the live
  // service. The test/standalone stub composes no permissionPresets service
  // (or its ctx.get is absent), so a static example list still names the two
  // presets the reference bundle ships.
  const permissionPresets = typeof ctx.get === 'function'
    ? ctx.get('permissionPresets') as PermissionPresetHost | undefined
    : undefined
  const permissionPresetNamesHint = permissionPresets !== undefined && permissionPresets.names.length > 0
    ? permissionPresets.names.join(', ')
    : 'workspace-write, danger-full-access'

  ctx.tools.register(checkedTool({
    name: 'list_peers',
    description:
      'List the other agent sessions in your workspace — live and dormant — which are the valid '
      + 'targets for create_task and send_note. Reachability is workspace membership: a session '
      + 'counts as a peer when its working directory is the same registered workspace as yours. '
      + 'Archived sessions never appear. A dormant peer is a real same-workspace member that is not '
      + 'currently live but can be woken for delivery. Status is running (busy now), idle (loaded, '
      + 'between turns), or dormant (not live, wakeable). A peer that wrote a card shows its '
      + 'self-description and machine-readable capabilities. This snapshot is not a delivery '
      + 'promise; create_task performs the authoritative check and may still refuse.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              id: { type: 'string' },
            },
          },
          peers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string' },
                status: { type: 'string', required: true, enum: ['running', 'idle', 'dormant'] },
                pendingTasks: { type: 'number', required: true },
                description: { type: 'string' },
                capabilities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, result) => {
        const workspace = result.workspace !== undefined
          ? `\ncurrent workspace: ${result.workspace.path}${result.workspace.id !== undefined ? ` (id ${result.workspace.id})` : ''}`
          : '\ncurrent workspace: (none — you are not inside a registered workspace)'
        const body = result.peers.length === 0
          ? 'no reachable peers — use create_member to create a peer session, or confirm your workspace.'
          : result.peers.map(p => {
            const name = p.title !== undefined && p.title !== '' ? p.title : p.id
            const caps = Array.isArray(p.capabilities) && p.capabilities.length > 0
              ? ` caps=${p.capabilities.map(c => c.id).join(',')}`
              : ''
            const desc = p.description !== undefined && p.description !== ''
              ? ` — ${p.description.slice(0, 60)}`
              : ''
            return `${name} [${p.status}] pending=${String(p.pendingTasks)}${caps}${desc} (${p.id})`
          }).join('\n')
            + '\n(target: use the id, not the title, for create_task/send_note — the id is unambiguous)'
        return [{ type: 'text', text: workspace + '\n' + body }]
      },
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:发现 peer', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:发现 peer', rawInput: result }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_peers')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_peers: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return { peers: [] }
      // Peers are the caller's workspace account, NOT just live agents: a
      // dormant (persisted but not currently live) same-workspace session is
      // still a valid, wakeable target and must appear. The registry account
      // is the sidebar's source, so whatever the sidebar shows is the peer set.
      const workspace = workspaces.list().find(entry => entry.path === workspacePath)
      if (workspace === undefined) return { peers: [] }
      const archived = new Set<string>(workspaces.archivedSessionIds as readonly string[])
      const live = new Map<string, Agent>()
      for (const agent of ctx.agents.list()) live.set(String(agent.id), agent)
      const subagents = await subagentSessionIds(ctx)
      const titles = await readTitlesFile(dshHomePath('storages', 'session_projcache.json'))
      const peers: {
        id: SessionId; title?: string; status: 'running' | 'idle' | 'dormant'; pendingTasks: number;
        description?: string; capabilities?: { id: string; label: string }[];
      }[] = []
      for (const sessionId of workspace.sessionIds) {
        if (String(sessionId) === String(callerId)) continue
        if (archived.has(String(sessionId))) continue
        // Subagents answer to their parent through the harness lineage, not
        // to workspace peers.
        if (subagents.has(String(sessionId))) continue
        const agent = live.get(String(sessionId))
        const pending = ledger.listFor(sessionId).filter(
          row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
        )
        const card = ledger.getCard(sessionId)
        peers.push({
          id: sessionId,
          title: peerTitleOf(ctx, titles, agent, sessionId),
          status: agent === undefined ? 'dormant' : agent.status === 'running' ? 'running' : 'idle',
          pendingTasks: pending.length,
          ...(card !== undefined ? { description: card.description } : {}),
          ...(card !== undefined && card.capabilities.length > 0
            ? { capabilities: card.capabilities.map(c => ({ id: c.id, label: c.label })) }
            : {}),
        })
      }
      // The caller's current workspace, read-only: `path` is always derivable
      // from resolveWorkspacePath; `id` comes from the registry entry when one
      // exists (the test/standalone registry stub may omit it).
      const workspaceId = (workspace as { id?: string }).id
      return {
        workspace: {
          path: workspacePath,
          ...(workspaceId !== undefined ? { id: workspaceId } : {}),
        },
        peers,
      }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'wake_member',
    description:
      'Wake one dormant member session (a non-archived peer in your workspace) so it becomes a '
      + 'live agent you can send_note / create_task to immediately. A dormant peer is a real '
      + 'same-workspace member that is persisted but not currently loaded; waking resumes it with '
      + 'its recorded composition and model route. The member stays live for the process lifetime '
      + 'after a wake. Use this to activate a peer before dispatching work to it — list_peers shows '
      + 'which peers are dormant.',
    parameters: {
      member_id: { type: 'string', required: true, description: 'The member session id (peer id from list_peers) to wake.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberId: { type: 'string', required: true },
          title: { type: 'string' },
          status: { type: 'string', required: true, enum: ['running', 'idle'] },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `成员 ${result.memberId} 已激活 (${result.status}${result.title !== undefined ? ` — ${result.title}` : ''})`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:唤醒成员', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:唤醒成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'wake_member')
      // Authorize the target as a same-workspace peer (live or dormant,
      // non-archived, non-subagent) before waking — the same gate create_task /
      // reassign use, so only a real reachable member can be activated.
      const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, String(args.member_id) as SessionId)
      if (!decision.ok) throw new Error(decision.message)
      const target = await wakeSession(ctx, String(args.member_id) as SessionId)
      if (target === undefined) {
        throw new Error(`wake_member: session "${String(args.member_id)}" could not be woken (no model route or resume failed)`)
      }
      const title = ctx.sessionTitle.get(target.session)?.title
      return {
        memberId: String(args.member_id),
        ...(title !== undefined && title !== '' ? { title } : {}),
        status: target.status === 'running' ? 'running' : 'idle',
      }
    },
  }))

  ctx.tools.register(checkedTool({
    // Named send_note, NOT send_message: the harness bundle reserves
    // send_message globally for subagent conversation (dsh-tool-subagent-
    // control), so the peer channel must not collide with it.
    name: 'send_note',
    description:
      'SMALL scope: send a lightweight note to a live peer in your workspace — a message, a '
      + 'question, a confirmation, a coordination ping; anything that is NOT work the peer must '
      + 'deliver a verifiable result for. The note lands in the peer\'s inbox like an ordinary '
      + 'message; there is NO task record, no acceptance, and nothing to report or settle. The '
      + 'peer simply replies in prose (with send_note back to you, if it replies at all). Use '
      + 'create_task instead when the peer must produce a result you will verify — a note channel '
      + 'needs no lifecycle, and a task channel whose work was really a chat is how tasks get '
      + 'stuck forever in working.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id or peer title of the recipient, from list_peers.' },
      content: { type: 'string', required: true, description: 'The note text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          queued: { type: 'boolean', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.delivered
          ? `note delivered (${String(result.messageId).slice(0, 8)}…)`
          : result.queued === true
            ? `recipient offline — note queued, delivered when they are live (${String(result.messageId).slice(0, 8)}…)`
            : 'note not delivered',
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:发送消息', kind: 'other', rawInput: { target: args.target } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:发送消息', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'send_note')
      if (!deps.messageLimiter.admit(callerId, Date.now())) {
        throw new Error(
          `message rate exceeded: at most ${config.maxMessagesPerMinute} messages per minute`,
        )
      }
      const targetId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.target))
      // Notes are durable (v1.5): the recipient may be offline — the note is
      // queued and delivered when the recipient is live again. The looser
      // authorization still confines recipients to the caller's workspace.
      const decision = await authorizeNoteRecipient(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)
      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const messageId = randomUUID()
      // Wake-on-delivery: a dormant recipient is resumed so the note lands
      // immediately; only a session that cannot be woken falls back to the
      // durable queue.
      const recipient = await wakeSession(ctx, targetId)
      if (recipient !== undefined) {
        const message = buildMessageMessage(callerId, messageId, admitted.content)
        deliverTask(recipient, message, 'followup')
        return { delivered: true, queued: false, messageId }
      }
      // Unwakeable offline recipient: hold durably, bounded per sender.
      const queued = ledger.listPendingNotes()
        .filter(note => note.sender === callerId)
      if (queued.length >= 50) {
        throw new Error('your offline note queue is full (50); wait for deliveries or drop old notes')
      }
      await ledger.queueNote({
        id: messageId,
        sender: callerId,
        recipient: targetId,
        content: admitted.content,
        sentAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        attempts: 0,
      })
      return { delivered: false, queued: true, messageId }
    },
  }))

/**
 * Enforce the flow-name contract (decision 8): 1–20 characters, a concise
 * name that tells at a glance what the task group is about. Shared by
 * create_flow and rename_flow so the two never drift.
 */
function assertFlowName(name: string): void {
  if (name.length === 0 || name.length > 20) {
    throw new Error('流程名不超过 20 字,并简明概括任务组核心内容')
  }
}

  ctx.tools.register(checkedTool({
    name: 'create_flow',
    description:
      'LARGE scope: create a flow — the roadmap container for a multi-step effort. FIRST write out '
      + 'the full plan (what must happen, in what order, by whom, what "done" means for each step), '
      + 'THEN create the flow, then split the plan into tasks created with flow_id and dependencies '
      + 'so the DAG auto-schedules: each task delivers only after its predecessors settle, and a '
      + 'failure propagates down the chain automatically. Every dependency of a task must live in '
      + 'the same flow (add the task to the flow first with edit_task flow_id), so one flow is '
      + 'always one DAG and cross-flow references are impossible. The DAG view renders per flow; a '
      + 'flow whose tasks are all archived moves to the archived section automatically. The flow name '
      + 'must be ≤20 characters and concisely name the task group\'s core.',
    parameters: {
      name: { type: 'string', required: true, description: 'Flow display name, ≤20 characters (concise name for the task group\'s core content).' },
      description: { type: 'string', description: 'Optional note about the flow.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          suggestion: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `flow ${result.flowId} created: ${result.name}`
          + (result.suggestion !== undefined ? `\n${result.suggestion}` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建流程', kind: 'other', rawInput: { name: args.name } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建流程', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_flow')
      const name = String(args.name ?? '').trim()
      assertFlowName(name)
      const description = args.description !== undefined
        ? admitContent(String(args.description), 400)
        : undefined
      if (description !== undefined && !description.ok) throw new Error(description.message)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('create_flow: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) {
        throw new Error('create_flow: the calling session is not inside a registered workspace')
      }
      const flowId = randomUUID()
      const flow = await ledger.createFlow(
        flowId, name, description?.ok === true ? description.content : undefined,
        callerId, workspacePath,
      )
      // Decision 8: a meaningless name (no letter in any script — pure digits
      // or symbols) is allowed, but the model gets a naming suggestion.
      const suggestion = /\p{L}/u.test(name)
        ? undefined
        : '建议格式:目标 + 阶段,如『电商站上线:Phase 1 基建』'
      return {
        flowId: flow.id,
        name: flow.name,
        ...(suggestion !== undefined ? { suggestion } : {}),
      }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'create_batch',
    description:
      'BATCH scope: create a lightweight batch of related deliverables in one call — the middle '
      + 'ground between create_task (one deliverable) and create_flow (a full DAG). Each '
      + 'deliverable becomes a normal task (report → settle, per-item), all sharing one batch id '
      + 'so the whole set can be viewed with list_batch and each item settled individually with '
      + 'settle_task. A batch has NO dependency graph: every task delivers immediately, so there '
      + 'is no scheduling or DAG overhead. Pass one deliverables entry per peer (fan out to several '
      + 'peers) or several entries to one peer (group related work). Each entry needs target + '
      + 'content; title defaults to the content head, and an optional per-entry reviewer enables a '
      + 'different session to settle it. name is an optional batch label (≤20 chars); omit it to '
      + 'derive one from the first deliverable.',
      parameters: {
        name: {
          type: 'string',
          description: 'Optional batch label, ≤20 characters; omitted derives one from the first deliverable.',
        },
        deliverables: {
          type: 'array',
          required: true,
          description: 'One or more related deliverables to create as tasks in a lightweight batch (no DAG).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              target: { type: 'string', required: true, description: 'Session id or peer title of the executor, from list_peers.' },
              content: { type: 'string', required: true, description: 'The deliverable instruction.' },
              title: { type: 'string', description: 'Short display title (1–20 chars); defaults to the content head when omitted.' },
              acceptance_criteria: { type: 'string', description: 'The minimum acceptance requirement the reviewer settles against.' },
              reviewer: { type: 'string', description: 'Session id of the reviewer who settles this deliverable; defaults to you.' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            batchId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            created: { type: 'number', required: true },
            tasks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  taskId: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  to: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, result) => [{
          type: 'text',
          text: `batch ${result.batchId} created: ${result.name} (${String(result.created)} task(s))\n`
            + result.tasks.map(task =>
              `  ${task.taskId.slice(0, 8)}… → ${String(task.status)} (${task.to.slice(0, 8)}…) ${task.title}`,
            ).join('\n'),
        }],
      },
      presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建批次', kind: 'other', rawInput: { name: args.name } }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建批次', rawInput: result }),
      async execute(args, exec) {
        const callerId = requireCaller(exec.agent, 'create_batch')
        if (!limiter.admit(callerId, Date.now())) {
          throw new Error(
            `dispatch rate exceeded: at most ${config.maxSendsPerMinute} sends per minute`,
          )
        }
        const caller = ctx.agents.get(callerId)
        if (caller === undefined) throw new Error('create_batch: the calling session is not a live agent')
        const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
        if (callerWorkspace === undefined) {
          throw new Error('create_batch: the calling session is not inside a registered workspace')
        }
        const deliverables = args.deliverables as Array<Record<string, unknown>> | undefined
        if (deliverables === undefined || deliverables.length === 0) {
          throw new Error('create_batch needs at least one deliverable')
        }

        // Pre-flight every deliverable up front so a later item's refusal does
        // not leave a half-created batch: resolve the target, authorize it,
        // admit the content, derive the title, and resolve an optional reviewer.
        const items: {
          targetId: SessionId
          workspacePath: string
          content: string
          title: string
          criteria: string | undefined
          reviewer: SessionId | undefined
        }[] = []
        for (let i = 0; i < deliverables.length; i++) {
          const deliverable = deliverables[i]!
          const targetValue = deliverable.target === undefined ? '' : String(deliverable.target)
          if (targetValue === '') {
            throw new Error(`deliverable ${i + 1} is missing a target`)
          }
          const targetId = await resolvePeerTarget(ctx, workspaces, callerId, targetValue)
          const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, targetId)
          if (!decision.ok) throw new Error(`deliverable ${i + 1} (target ${targetValue}): ${decision.message}`)
          const content = admitContent(deliverable.content === undefined ? '' : String(deliverable.content), config.maxContentLength)
          if (!content.ok) throw new Error(`deliverable ${i + 1}: ${content.message}`)
          const rawTitle = (deliverable.title !== undefined && String(deliverable.title).trim() !== '')
            ? String(deliverable.title).trim()
            : content.content.slice(0, 20).trim()
          if (rawTitle.length === 0 || rawTitle.length > 20) {
            throw new Error(`deliverable ${i + 1} title must be 1-20 characters`)
          }
          let criteria: string | undefined
          if (deliverable.acceptance_criteria !== undefined) {
            const admitted = admitContent(String(deliverable.acceptance_criteria), 2000)
            if (!admitted.ok) throw new Error(`deliverable ${i + 1}: ${admitted.message}`)
            criteria = admitted.content
          }
          let reviewer: SessionId | undefined
          if (deliverable.reviewer !== undefined) {
            const reviewerId = await resolvePeerTarget(ctx, workspaces, callerId, String(deliverable.reviewer))
            const reviewerDecision = await authorizePeerOrDormant(ctx, workspaces, callerId, reviewerId)
            if (!reviewerDecision.ok) throw new Error(`deliverable ${i + 1} reviewer: ${reviewerDecision.message}`)
            reviewer = reviewerId
          }
          // Self-execution keeps accountability: when a deliverable targets the
          // caller, the reviewer must be a different session (same rule as
          // create_task).
          if (targetId === callerId && (reviewer === undefined || reviewer === callerId)) {
            throw new Error(
              `deliverable ${i + 1}: self-execution requires reviewer; name a different session`,
            )
          }
          items.push({
            targetId, workspacePath: decision.workspacePath, content: content.content,
            title: rawTitle, criteria, reviewer,
          })
        }

        // Pre-flight the per-recipient queue ceiling: the ledger refuses a row
        // when its recipient holds maxPendingPerAgent unfinished tasks, so a
        // batch that would push a recipient over the line must fail up front
        // rather than partially create.
        const batchAll = ledger.listAll()
        const newByTarget = new Map<string, number>()
        for (const item of items) {
          newByTarget.set(String(item.targetId), (newByTarget.get(String(item.targetId)) ?? 0) + 1)
        }
        for (const [targetId, newCount] of newByTarget) {
          const existing = batchAll.filter(row =>
            row.assignedTo === targetId
            && (row.status === 'submitted' || row.status === 'working' || row.status === 'input-required'),
          ).length
          if (existing + newCount > config.maxPendingPerAgent) {
            throw new Error(
              `session "${targetId}" already has ${existing} unfinished tasks; adding ${newCount} would exceed the ${config.maxPendingPerAgent} limit`,
            )
          }
        }

        // Batch label: explicit name, else derived from the first deliverable.
        const explicitName = args.name !== undefined ? String(args.name).trim() : ''
        const batchName = explicitName !== ''
          ? explicitName
          : items[0]!.title.slice(0, 20)
        if (batchName.length === 0 || batchName.length > 20) {
          throw new Error(`batch name is ${batchName.length} characters, over the 20 limit`)
        }

        const batchId = randomUUID()
        await ledger.createBatch(batchId, batchName, callerId, callerWorkspace)
        const tasks: Array<{ taskId: string; status: string; to: string; title: string }> = []
        for (const item of items) {
          const taskId = TaskId(randomTaskId())
          const message = buildTaskMessage(callerId, taskId, item.content)
          const tokensAtStart = snapshotTokensAtDispatch(ctx, callerId, item.targetId, item.reviewer)
          const recorded = await ledger.record({
            id: taskId,
            assignedBy: callerId,
            assignedTo: item.targetId,
            ...(item.reviewer !== undefined ? { assignedReviewer: item.reviewer } : {}),
            workspacePath: item.workspacePath,
            content: item.content,
            mode: 'steer',
            retries: 0,
            ...(tokensAtStart !== undefined ? { tokensAtStart } : {}),
            ...(item.criteria !== undefined ? { acceptanceCriteria: item.criteria } : {}),
            batchId,
            title: item.title,
          }, config.maxPendingPerAgent)
          if (!recorded.ok) throw new Error(`deliverable "${item.title}": ${recorded.message}`)
          // A batch has no dependencies, so every task delivers immediately
          // (wake-on-delivery); an unwakeable target falls back to queued,
          // which the backstop sweep later delivers.
          const target = await wakeSession(ctx, item.targetId)
          if (target !== undefined) {
            await ledger.recordDelivery(taskId, message.id)
            deliverTask(target, message, 'steer')
          } else {
            await ledger.transition(taskId, 'queued')
          }
          const fresh = ledger.get(taskId)
          tasks.push({
            taskId: String(taskId),
            status: fresh?.status ?? recorded.task.status,
            to: String(item.targetId),
            title: item.title,
          })
        }
        return { batchId, name: batchName, created: tasks.length, tasks }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'rename_flow',
    description:
      'Rename a flow, optionally replacing its description. The new name must be '
      + 'unique within the workspace — renaming onto an existing flow\'s name is refused with the '
      + 'existing names listed. Pass description to replace it, an empty string to clear it, or '
      + 'omit it to keep the current note. Any session in the flow\'s workspace may rename it. '
      + 'The new name must be ≤20 characters and concisely name the task group\'s core.',
    parameters: {
      flow_id: { type: 'string', required: true, description: 'The flow id to rename.' },
      name: { type: 'string', required: true, description: 'New flow display name, ≤20 characters (concise name for the task group\'s core content).' },
      description: { type: 'string', description: 'Replacement note; empty clears it, omit keeps it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          description: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `flow ${result.flowId} renamed to ${result.name}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:重命名流程', kind: 'other', rawInput: { flow_id: args.flow_id, name: args.name } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:重命名流程', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'rename_flow')
      const name = String(args.name ?? '').trim()
      assertFlowName(name)
      const flow = ledger.getFlow(args.flow_id)
      if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('rename_flow: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace !== flow.workspacePath) {
        throw new Error(`仅工作区成员可改名:flow "${flow.id}" is in a different workspace`)
      }
      const description = args.description !== undefined
        ? admitContent(String(args.description), 400)
        : undefined
      if (description !== undefined && !description.ok) throw new Error(description.message)
      const renamed = await ledger.renameFlow(
        flow.id,
        name,
        description?.ok === true ? description.content : undefined,
      )
      if (!renamed.ok) throw new Error(renamed.message)
      return {
        flowId: renamed.flow.id,
        name: renamed.flow.name,
        ...(renamed.flow.description !== undefined ? { description: renamed.flow.description } : {}),
      }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'reassign_task',
    description:
      'As the initiator, reassign an unsettled task without recreating it: move the executor '
      + '(new_executor) and/or the reviewer (new_reviewer). The task id, history, dependencies, '
      + 'flow membership, and acceptance criteria all stay — only who works and who reviews '
      + 'changes. A new executor receives the task re-delivered (a working old executor\'s report '
      + 'is rejected automatically); a queued task simply gets the new owner and still waits for '
      + 'its dependencies. Use this when a worker dropped out or responsibilities shift — cancel '
      + 'and recreate is the fallback only for settled tasks.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The unsettled task to reassign.' },
      new_executor: {
        type: 'string',
        description: 'Session id or peer title of the new executor, from list_peers; omit to keep the current one.',
      },
      new_reviewer: {
        type: 'string',
        description: 'Session id or peer title of the new reviewer, from list_peers; omit to keep the current one.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          executor: { type: 'string' },
          reviewer: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} reassigned → ${String(result.status)}`
          + (result.executor !== undefined ? `, executor: ${result.executor.slice(0, 8)}` : '')
          + (result.reviewer !== undefined ? `, reviewer: ${result.reviewer.slice(0, 8)}` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:转派任务', kind: 'other', rawInput: { task_id: args.task_id, ...(args.new_executor !== undefined ? { new_executor: args.new_executor } : {}), ...(args.new_reviewer !== undefined ? { new_reviewer: args.new_reviewer } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:转派任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'reassign_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedBy !== callerId) {
        throw new Error(`only the session that created task "${taskId}" may reassign it`)
      }
      if (args.new_executor === undefined && args.new_reviewer === undefined) {
        throw new Error('reassign_task needs new_executor and/or new_reviewer')
      }
      let newExecutor: SessionId | undefined
      if (args.new_executor !== undefined) {
        const executorId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.new_executor))
        const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, executorId)
        if (!decision.ok) throw new Error(decision.message)
        newExecutor = executorId
        // Self-execution keeps an independent reviewer, same rule as create_task.
        const effectiveReviewer = args.new_reviewer !== undefined
          ? await resolvePeerTarget(ctx, workspaces, callerId, String(args.new_reviewer))
          : task.assignedReviewer
        if (newExecutor === callerId
          && (effectiveReviewer === undefined || effectiveReviewer === callerId)) {
          throw new Error(
            'self-execution requires reviewer: when the executor is yourself, name a different session as reviewer',
          )
        }
      }
      let newReviewer: SessionId | undefined
      if (args.new_reviewer !== undefined) {
        const reviewerId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.new_reviewer))
        const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, reviewerId)
        if (!decision.ok) throw new Error(decision.message)
        newReviewer = reviewerId
      }
      const oldExecutor = task.assignedTo
      const wasWorking = task.status === 'working' || task.status === 'input-required'
      const wasQueued = task.status === 'queued'
      // Work-state detection: with the one-task-per-turn delivery model, a
      // working task IS the task the executor is currently on. Reassigning
      // while it runs must interrupt that turn so the old worker cannot
      // keep grinding on work that was taken from it.
      const executorOnThisTask = task.status === 'working' && oldExecutor !== undefined
        && ctx.agents.get(oldExecutor) !== undefined
      const reassigned = await ledger.reassign(taskId, {
        ...(newExecutor !== undefined ? { executor: newExecutor } : {}),
        ...(newReviewer !== undefined ? { reviewer: newReviewer } : {}),
      })
      if (!reassigned.ok) throw new Error(reassigned.message)

      // Re-deliver to the new executor: the old delivery was voided by the
      // reassign. A queued task is not delivered — the scheduler owns it. A
      // dormant new executor is woken; an unwakeable one falls back to queued
      // and the sweep retries.
      if (newExecutor !== undefined && !wasQueued) {
        const message = buildTaskMessage(callerId, taskId,
          `${reassigned.task.content}\n\n[任务已由 ${oldExecutor ?? '原执行方'} 转派给你执行,请按原要求完成并调用 report_task。]`,
          'reassign_task')
        const worker = await wakeSession(ctx, newExecutor)
        if (worker !== undefined) {
          await ledger.recordDelivery(taskId, message.id)
          deliverTask(worker, message, 'steer')
        } else {
          await ledger.transition(taskId, 'queued')
        }
      }
      // The old executor's in-flight turn is interrupted and told the task
      // moved (if it was mid-flight) — the reclaimed work is voided so it
      // cannot keep executing a task that no longer belongs to it.
      if (oldExecutor !== undefined && newExecutor !== undefined && oldExecutor !== newExecutor && executorOnThisTask) {
        const oldWorker = ctx.agents.get(oldExecutor)
        if (oldWorker !== undefined) {
          try {
            oldWorker.cancel({ kind: 'user' }, { keepInbox: true })
          } catch {
            // The interrupt is advisory; a worker that already settled its
            // turn needs no interruption.
          }
        }
        notifySession(ctx, oldExecutor, taskId,
          `任务 ${taskId} 已转派给 ${newExecutor.slice(0, 8)},你不再负责该任务,当前工作已作废。`,
          'reassign_task')
      }
      return {
        taskId: String(taskId),
        status: reassigned.task.status,
        ...(reassigned.task.assignedTo !== undefined ? { executor: String(reassigned.task.assignedTo) } : {}),
        ...(reassigned.task.assignedReviewer !== undefined ? { reviewer: String(reassigned.task.assignedReviewer) } : {}),
      }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'submit_handoff',
    description:
      'As the executor of a settled task, deliver the handoff document to ONE task that depends on '
      + 'it (a task listing this one in its dependencies). The document is attached to the '
      + 'downstream task and is concatenated into its delivered content when it dispatches — this '
      + 'is how a chain passes structured context (computed values, decisions, caveats) instead of '
      + 'free-text archaeology. Call it once per downstream task.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task you executed and completed (its id).' },
      to_task_id: { type: 'string', required: true, description: 'The downstream task that depends on task_id.' },
      document: { type: 'string', required: true, description: 'The handoff content the downstream task needs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          handoffCount: { type: 'number', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `handoff attached to ${result.taskId} (${String(result.handoffCount)} total)`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:提交交接文档', kind: 'other', rawInput: { task_id: args.task_id, to_task_id: args.to_task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:提交交接文档', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'submit_handoff')
      const taskId = TaskId(args.task_id)
      const toTaskId = TaskId(args.to_task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const downstream = ledger.get(toTaskId)
      if (downstream === undefined) throw new Error(`no such task "${toTaskId}"`)
      if (!(downstream.dependencies ?? []).includes(taskId)) {
        throw new Error(`task "${toTaskId}" does not depend on "${taskId}"; handoffs go to downstream tasks only`)
      }
      const admitted = admitContent(args.document, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const attached = await ledger.appendHandoff(toTaskId, {
        fromTask: taskId,
        document: admitted.content,
        at: new Date().toISOString(),
      })
      if (!attached.ok) throw new Error(attached.message)
      return {
        taskId: String(toTaskId),
        handoffCount: (attached.task.handoffs ?? []).length,
      }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'list_flows',
    description:
      'List the flows in your workspace: each flow\'s name, task counts, and whether it is archived '
      + '(every task in it has settled and left the active set). Use create_task with flow_id to add '
      + 'tasks to a flow, and edit_task with flow_id to move a task between flows.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            description: { type: 'string' },
            taskCount: { type: 'number', required: true },
            unsettledCount: { type: 'number', required: true },
            archived: { type: 'boolean', required: true },
          },
        },
      },
      render: (_args, flows) => [{
        type: 'text',
        text: flows.length === 0
          ? '(no flows)'
          : flows.map(f =>
            `${f.name} [${f.archived ? '已归档' : '活跃'}] tasks=${String(f.taskCount)} unsettled=${String(f.unsettledCount)}${f.description !== undefined ? ` — ${f.description.slice(0, 60)}` : ''} (${f.id.slice(0, 8)})`,
          ).join('\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:流程列表', kind: 'other' }),
    presentResult: (_args, flows) => ({ card: 'generic', title: 'agent-bus:流程列表', rawInput: flows }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_flows')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_flows: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return []
      const all = ledger.listAll()
      const flows = ledger.listFlows()
        .filter(flow => flow.workspacePath === workspacePath)
        .map(flow => {
          const tasks = all.filter(row => row.flowId === flow.id)
          const unsettled = tasks.filter(row => !isSettledTask(row))
          return {
            id: flow.id,
            name: flow.name,
            ...(flow.description !== undefined ? { description: flow.description } : {}),
            taskCount: tasks.length,
            unsettledCount: unsettled.length,
            // Archive is a user action, never derived from task state.
            archived: flow.archived === true,
          }
        })
      return flows
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'list_batches',
    description:
      'List the lightweight batches in your workspace: each batch\'s name, task count, and how many '
      + 'of its tasks are still unsettled, in creation order. Batches come from create_batch — they '
      + 'group related deliverables sharing a batch id but build no DAG. Use list_batch with a '
      + 'batch_id to expand one batch into its full task rows.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            createdAt: { type: 'string', required: true },
            taskCount: { type: 'number', required: true },
            unsettledCount: { type: 'number', required: true },
          },
        },
      },
      render: (_args, batches) => [{
        type: 'text',
        text: batches.length === 0
          ? '(no batches)'
          : batches.map(batch =>
            `${batch.name} tasks=${String(batch.taskCount)} unsettled=${String(batch.unsettledCount)} (${batch.id.slice(0, 8)})`,
          ).join('\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:批次列表', kind: 'other' }),
    presentResult: (_args, batches) => ({ card: 'generic', title: 'agent-bus:批次列表', rawInput: batches }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_batches')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_batches: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return []
      const all = ledger.listAll()
      return ledger.listBatches(workspacePath).map(batch => {
        const tasks = all.filter(row => row.batchId === batch.id)
        const unsettled = tasks.filter(row => !isSettledTask(row))
        return {
          id: batch.id,
          name: batch.name,
          createdAt: batch.createdAt,
          taskCount: tasks.length,
          unsettledCount: unsettled.length,
        }
      })
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'list_batch',
    description:
      'Read one lightweight batch as a whole: the batch header (id, name, creator, creation time) '
      + 'plus every task row in it, in creation order. Each task still settles individually with '
      + 'settle_task; this just lets you see the whole grouped set at once. A live task is shown only '
      + 'to its participants (same read rule as get_task); completed and failed tasks are public. '
      + 'Only a session inside the batch\'s workspace may read it.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'The batch id (from create_batch or list_batches).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
          createdBy: { type: 'string', required: true },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                to: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string', required: true },
                report: { type: 'string' },
                outcome: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, batch) => [{
        type: 'text',
        text: `batch ${batch.id} — ${batch.name} (by ${batch.createdBy.slice(0, 8)}…, created ${batch.createdAt})\n`
          + (batch.tasks.length === 0
            ? '(no tasks)'
            : batch.tasks.map(task =>
              `  ${task.id.slice(0, 8)}… [${task.status}]${task.title !== undefined ? ` ${task.title}` : ''}${task.report !== undefined ? ` — ${task.report.slice(0, 60)}` : ''}`,
            ).join('\n')),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:读取批次', kind: 'other', rawInput: { batch_id: args.batch_id } }),
    presentResult: (_args, batch) => ({ card: 'generic', title: 'agent-bus:读取批次', rawInput: batch }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'list_batch')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_batch: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) {
        throw new Error('list_batch: the calling session is not inside a registered workspace')
      }
      const batch = ledger.getBatch(args.batch_id)
      if (batch === undefined) throw new Error(`no such batch "${args.batch_id}"`)
      if (batch.workspacePath !== workspacePath) {
        throw new Error(`batch "${args.batch_id}" is in a different workspace`)
      }
      const tasks = ledger.listAll()
        .filter(row => row.batchId === batch.id && canReadTask(row, callerId))
        .map(row => ({
          id: String(row.id),
          status: row.status,
          ...(row.assignedTo !== undefined ? { to: String(row.assignedTo) } : {}),
          ...(row.title !== undefined ? { title: row.title } : {}),
          content: row.content,
          ...(row.report !== undefined ? { report: row.report } : {}),
          ...(row.outcome !== undefined ? { outcome: row.outcome } : {}),
        }))
      return {
        id: batch.id,
        name: batch.name,
        createdAt: batch.createdAt,
        createdBy: String(batch.createdBy),
        tasks,
      }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'create_task',
    description:
      'MEDIUM scope: create one task node for a live peer in your workspace — a single deliverable '
      + 'the peer must produce and you will review. The task is recorded in the ledger; a task whose '
      + 'dependencies are already settled is delivered to the peer\'s queue in one step, and a task '
      + 'with unsettled dependencies is created as 待投递(queued) and delivered automatically by the '
      + 'scheduler once every dependency settles — no pacing needed. The peer works delivered tasks '
      + 'one at a time, each as its own turn. You become the task\'s initiator. By default you also '
      + 'review its result; pass reviewer to name a different session as the one that settles it. '
      + 'acceptance_criteria is the minimum requirement the reviewer settles against. A rejected '
      + 'result sends the SAME task back to the worker for rework — the task id never changes across '
      + 'attempts. To answer a peer\'s request_input, pass task_id — your message becomes the answer '
      + 'and the task resumes. Delivery defaults to steer, which puts the task ahead of any queued '
      + 'notes (priority channel); pass mode=followup to queue FIFO behind everything already pending. '
      + 'For a multi-step effort, use create_flow instead and build the DAG.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id or peer title of the executor, from list_peers.' },
      content: { type: 'string', required: true, description: 'The task instruction or answer.' },
      title: { type: 'string', required: true, description: 'Short display title (1–20 chars); lists and DAG nodes display it.' },
      mode: {
        type: 'string',
        enum: ['followup', 'steer'],
        description: 'steer (default) delivers with priority ahead of queued notes; followup queues FIFO behind them.',
      },
      reviewer: {
        type: 'string',
        description: 'Session id of the reviewer who settles this task; defaults to you.',
      },
      task_id: {
        type: 'string',
        description: 'Answering a request_input: the input-required task id. The message answers its question.',
      },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'DAG predecessors: task ids that must settle before this one is delivered. '
          + 'While any predecessor is unsettled the task stays 待投递(queued) — the scheduler delivers '
          + 'it automatically once every dependency settles. Edit with edit_task before it dispatches.',
      },
      acceptance_criteria: {
        type: 'string',
        description: 'The minimum acceptance requirement the reviewer settles against; the worker can '
          + 'read it to know what "done" means.',
      },
      flow_id: {
        type: 'string',
        description: 'Flow to join (from create_flow). When set, every dependency must belong to the '
          + 'same flow — add a target task to the flow first if it is not there.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          queuePosition: { type: 'number', required: true },
          blockedBy: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} → ${String(result.status)}, `
          + `${String(result.queuePosition)} unfinished task(s) in that queue`
          + (result.blockedBy.length > 0
            ? `, awaiting dependencies: ${result.blockedBy.join(', ')}`
            : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建任务', kind: 'other', rawInput: { target: args.target, ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}), ...(args.task_id !== undefined ? { task_id: args.task_id } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_task')
      if (!limiter.admit(callerId, Date.now())) {
        throw new Error(
          `dispatch rate exceeded: at most ${config.maxSendsPerMinute} sends per minute`,
        )
      }
      const targetId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.target))
      const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)

      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const criteria = args.acceptance_criteria !== undefined
        ? admitContent(args.acceptance_criteria, 2000)
        : undefined
      if (criteria !== undefined && !criteria.ok) throw new Error(criteria.message)
      const title = admitContent(String(args.title ?? ''), 80)
      if (!title.ok) throw new Error(title.message)

      // Priority delivery: the default 'steer' channel (next-step) is claimed
      // before any queued next-turn messages at every boundary, so a
      // dispatched task never waits behind a pile of send_note turns. An
      // explicit 'followup' opts into FIFO queueing behind everything already
      // pending.
      const mode: DeliveryMode = args.mode === 'followup' ? 'followup' : 'steer'

      // Answer path: the initiator replies to a worker's request_input. The
      // answer is a new delivery; the task transitions back to working HERE
      // rather than waiting for an inbox-claimed event — a steer-spliced
      // answer may enter the worker's current turn without a claim boundary,
      // which would otherwise leave the row stuck in input-required forever.
      if (args.task_id !== undefined) {
        const taskId = TaskId(args.task_id)
        const task = ledger.get(taskId)
        if (task === undefined) throw new Error(`no such task "${taskId}"`)
        if (task.status !== 'input-required') {
          throw new Error(`task "${taskId}" is ${task.status}, not awaiting input`)
        }
        if (task.assignedBy !== callerId) {
          throw new Error(`only the dispatching session may answer task "${taskId}"`)
        }
        const message = buildTaskMessage(callerId, taskId, admitted.content)
        const resumed = await ledger.transition(taskId, 'working')
        if (!resumed.ok) throw new Error(resumed.message)
        await ledger.recordDelivery(taskId, message.id)
        deliverTask(decision.target, message, mode)
        const pending = ledger.listFor(targetId).filter(
          row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
        )
        return { taskId: String(taskId), status: resumed.task.status, queuePosition: pending.length, blockedBy: [] as string[] }
      }

      // Create path: a fresh task node. Reviewer defaults to the initiator.
      const taskId = TaskId(randomTaskId())
      let reviewer: SessionId | undefined
      if (args.reviewer !== undefined) {
        const reviewerId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.reviewer))
        const reviewerDecision = await authorizePeerOrDormant(ctx, workspaces, callerId, reviewerId)
        if (!reviewerDecision.ok) throw new Error(reviewerDecision.message)
        reviewer = reviewerId
      }
      // Self-execution keeps accountability: when the caller is also the
      // executor, the reviewer MUST be a different session — nobody approves
      // their own work.
      if (targetId === callerId) {
        if (reviewer === undefined || reviewer === callerId) {
          throw new Error(
            'self-execution requires reviewer: when target is yourself, name a different session as reviewer',
          )
        }
      }
      const dependencies = (args.dependencies as string[] | undefined)?.map(id => TaskId(id))
      // Flow membership: the flow must exist in the caller's workspace. The
      // same-flow dependency rule is enforced by the ledger at write time.
      let flowId: string | undefined
      if (args.flow_id !== undefined) {
        const flow = ledger.getFlow(args.flow_id)
        if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
        if (flow.workspacePath !== decision.workspacePath) {
          throw new Error(`flow "${args.flow_id}" belongs to another workspace`)
        }
        flowId = flow.id
      }
      const message = buildTaskMessage(callerId, taskId, admitted.content)
      const tokensAtStart = snapshotTokensAtDispatch(ctx, callerId, targetId, reviewer)
      const recorded = await ledger.record({
        id: taskId,
        assignedBy: callerId,
        assignedTo: targetId,
        ...(reviewer !== undefined ? { assignedReviewer: reviewer } : {}),
        workspacePath: decision.workspacePath,
        content: admitted.content,
        mode,
        retries: 0,
        ...(tokensAtStart !== undefined ? { tokensAtStart } : {}),
        ...(dependencies !== undefined ? { dependencies } : {}),
        ...(criteria?.ok === true ? { acceptanceCriteria: criteria.content } : {}),
        ...(flowId !== undefined ? { flowId } : {}),
        title: title.content,
      }, config.maxPendingPerAgent)
      if (!recorded.ok) throw new Error(recorded.message)

      // A task with dependencies is created queued(待投递) without delivery
      // until every predecessor settles; the scheduler delivers it then. A
      // task whose dependencies are already settled delivers immediately,
      // recording the message id before the inbox can claim it. A dormant
      // target is WOKEN (v1.5): the harness resumes the persisted session,
      // so the dispatch never fails on a closed tab; if the session cannot
      // be woken the task falls back to queued and the sweep retries.
      const blocked: string[] = dependencies === undefined
        ? []
        : [...blockedByOf(recorded.task, ledger.listAll()).map(String)]
      if (blocked.length === 0) {
        const target = await wakeSession(ctx, targetId)
        if (target !== undefined) {
          await ledger.recordDelivery(taskId, message.id)
          deliverTask(target, message, mode)
        } else {
          await ledger.transition(taskId, 'queued')
        }
      }
      const pending = ledger.listFor(targetId).filter(
        row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
      )
      return { taskId: String(taskId), status: recorded.task.status, queuePosition: pending.length, blockedBy: blocked }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'edit_task',
    description:
      'Edit a task you created that has not been dispatched yet: rewrite its requirement text, its '
      + 'DAG predecessors (dependencies), and/or its acceptance criteria. The DAG is program-driven — '
      + 'if you find your flow unreasonable, fix it here before the task dispatches. A dispatched or '
      + 'running task cannot be edited; cancel and recreate instead. After the edit, the task '
      + 'dispatches automatically if every dependency has settled.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The undispatched task to edit.' },
      content: { type: 'string', description: 'New requirement text; omit to keep the current one.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'New predecessor list; omit to keep the current one, pass [] to clear all dependencies.',
      },
      acceptance_criteria: {
        type: 'string',
        description: 'New minimum acceptance requirement; omit to keep the current one.',
      },
      title: {
        type: 'string',
        description: 'New display title (1–20 chars); omit to keep the current one.',
      },
      flow_id: {
        type: 'string',
        description: 'Move the task to another flow; the new flow must contain every dependency of '
          + 'the task (dependencies move with it, so add them to the new flow first if needed).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          blockedBy: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} updated → ${String(result.status)}`
          + (result.blockedBy.length > 0
            ? `, awaiting dependencies: ${result.blockedBy.join(', ')}`
            : ', dependencies satisfied'),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'agent-bus:编辑任务',
      kind: 'other',
      rawInput: { task_id: args.task_id, ...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}) },
    }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:编辑任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'edit_task')
      const taskId = TaskId(args.task_id)
      const existing = ledger.get(taskId)
      if (existing === undefined) throw new Error(`no such task "${taskId}"`)
      if (existing.assignedBy !== callerId) {
        throw new Error(`only the session that created task "${taskId}" may edit it`)
      }
      const patch: {
        content?: string
        title?: string
        dependencies?: TaskId[]
        acceptanceCriteria?: string
        flowId?: string
      } = {}
      if (args.content !== undefined) {
        const admitted = admitContent(args.content, config.maxContentLength)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.content = admitted.content
      }
      if (args.title !== undefined) {
        const admitted = admitContent(args.title, 80)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.title = admitted.content
      }
      if (args.dependencies !== undefined) {
        patch.dependencies = (args.dependencies as string[]).map(id => TaskId(id))
      }
      if (args.acceptance_criteria !== undefined) {
        const admitted = admitContent(args.acceptance_criteria, 2000)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.acceptanceCriteria = admitted.content
      }
      if (args.flow_id !== undefined) {
        const flow = ledger.getFlow(args.flow_id)
        if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
        patch.flowId = flow.id
      }
      const edited = await ledger.editTask(taskId, patch)
      if (!edited.ok) throw new Error(edited.message)

      // Recompute readiness: a dependency edit may have cleared the last
      // blocker, in which case the task dispatches immediately.
      const blocked: string[] = [...blockedByOf(edited.task, ledger.listAll()).map(String)]
      if (blocked.length === 0) {
        await dispatchOne(ctx, ledger, taskId)
      }
      return { taskId: String(taskId), status: edited.task.status, blockedBy: blocked }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'list_tasks',
    description:
      'List the ACTIVE tasks in the ledger. Scope inbox (default) shows work addressed to you, in the '
      + 'order you will do it; scope outbox shows what you dispatched and its current state. Archived '
      + 'tasks are invisible by design: a task leaves the listing once it failed, was canceled, or its '
      + 'settlement is more than 24 hours old — history lives in the panel and session logs. A completed '
      + 'task awaiting your verdict is still active and includes its report text, so read it before '
      + 'settling. Pass status to filter to one task state. Use get_task when a listing truncates a '
      + 'long report.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['inbox', 'outbox'],
        description: 'inbox (default) lists tasks assigned to you; outbox lists tasks you dispatched.',
      },
      status: {
        type: 'string',
        enum: [
          'queued', 'submitted', 'working', 'input-required', 'auth-required',
          'completed', 'failed', 'canceled', 'rejected',
        ],
        description: 'Optional: list only tasks in this state.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            from: { type: 'string', required: true },
            to: { type: 'string' },
            content: { type: 'string', required: true },
            title: { type: 'string' },
            report: { type: 'string' },
            outcome: { type: 'string' },
            reason: { type: 'string' },
            retries: { type: 'number', required: true },
            acceptanceCriteria: { type: 'string' },
            dependencies: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      render: (_args, tasks) => [{
        type: 'text',
        text: tasks.length === 0
          ? '(no tasks)'
          : tasks.map(renderTaskRow).join('\n'),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:任务列表', kind: 'other', rawInput: { scope: args.scope, ...(args.status !== undefined ? { status: args.status } : {}) } }),
    presentResult: (_args, tasks) => ({ card: 'generic', title: 'agent-bus:任务列表', rawInput: tasks }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'list_tasks')
      const scope = args.scope === 'outbox' ? 'outbox' : 'inbox'
      let rows: TaskRecord[]
      switch (scope) {
        case 'inbox':
          rows = ledger.listFor(callerId)
          break
        case 'outbox':
          rows = ledger.listBy(callerId)
          break
        /* v8 ignore next 2 -- the schema-validated closed enum is normalized before dispatch. */
        default:
          return assertNever(scope, 'list_tasks scope')
      }
      if (args.status !== undefined) {
        rows = rows.filter(row => row.status === args.status)
      }
      rows = rows.filter(row => isActiveTask(row, Date.now()))
      return rows.map(view)
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'get_task',
    description:
      'Read one task\'s full record: the complete task content and submitted result, without the '
      + 'truncation list_tasks applies. A live task is readable only by its participants (the '
      + 'dispatching session, the assigned session, and the reviewer); completed or terminally-failed '
      + 'tasks are history and publicly readable. Use it to review a long report before settling.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string' },
          content: { type: 'string', required: true },
          title: { type: 'string' },
          acceptanceCriteria: { type: 'string' },
          handoffs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fromTask: { type: 'string', required: true },
                document: { type: 'string', required: true },
                at: { type: 'string', required: true },
              },
            },
          },
          report: { type: 'string' },
          question: { type: 'string' },
          outcome: { type: 'string' },
          feedback: { type: 'string' },
          reason: { type: 'string' },
          reviewer: { type: 'string' },
          retries: { type: 'number', required: true },
          createdAt: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
      render: (_args, detail) => [{ type: 'text', text: renderTaskDetail(detail) }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:读取任务', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, detail) => ({ card: 'generic', title: 'agent-bus:读取任务', rawInput: detail }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'get_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('get_task: the calling session is not a live agent')
      // Decision 4: a live task is readable by its participants alone; a
      // non-participant gets "该任务与你无关" with no content. Completed and
      // terminally-failed tasks are history and public.
      const denial = authorizeTaskRead(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      // Externalized reports are read back so the reviewer sees the full
      // result; a missing file degrades to the inline summary.
      let fullReport: string | undefined
      if (task.reportRef !== undefined) {
        fullReport = await deps.reports.read(task.reportRef)
      }
      return fullReport !== undefined
        ? { ...detailView(task), report: fullReport }
        : detailView(task)
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'report_task',
    description:
      'As the worker, submit the result of a task assigned to you: a working task becomes completed '
      + 'and waits for the dispatcher\'s verdict; you cannot settle it yourself. If the task was '
      + 'canceled, calling this attaches a summary of the work you had done — the status stays '
      + 'canceled. You may not report tasks that are still submitted (not yet claimed) or that are '
      + 'awaiting input.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id.' },
      result: { type: 'string', required: true, description: 'Your result (or the cancel summary).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:提交结果', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:提交结果', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'report_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const admitted = admitContent(args.result, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      if (task.status === 'canceled') {
        const attached = await ledger.attachReport(taskId, admitted.content)
        if (!attached.ok) throw new Error(attached.message)
        deps.noteActivity(callerId)
        return { taskId, status: attached.task.status }
      }
      // Long reports are externalized: the ledger row carries a bounded
      // summary plus the reference, and get_task reads the full text back.
      let report = admitted.content
      let reportRef: string | undefined
      if (report.length > config.maxInlineReport) {
        reportRef = await deps.reports.save(taskId, admitted.content)
        report = `${admitted.content.slice(0, config.maxInlineReport)}…`
      }
      const completed = await ledger.transition(taskId, 'completed', {
        report,
        ...(reportRef !== undefined ? { reportRef } : {}),
      })
      if (!completed.ok) throw new Error(completed.message)
      // The reviewer is woken to settle; default reviewer is the initiator.
      const reviewer = task.assignedReviewer ?? task.assignedBy
      const excerpt = admitted.content.length > 200
        ? `${admitted.content.slice(0, 200)}…`
        : admitted.content
      notifySession(ctx, reviewer, taskId,
        `任务 ${taskId} 已完成,当前状态为「待验收」,请调用 settle_task 验收。提交结果摘要:${excerpt}`,
        'report_task')
      deps.noteActivity(callerId)
      return { taskId, status: completed.task.status }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'settle_task',
    description:
      'As the reviewer, settle a completed task: outcome=success accepts it and the task is done; '
      + 'outcome=failure sends the SAME task back to the worker for rework, with your feedback as the '
      + 'rework instruction — the task id never changes across attempts. The worker is notified to '
      + 'rework automatically, and the initiator is notified of the final result. Only the task\'s '
      + 'reviewer (the reviewer named at dispatch, or the initiator by default) may settle it.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The completed ledger task id.' },
      outcome: {
        type: 'string',
        required: true,
        enum: ['success', 'failure'],
        description: 'success accepts; failure sends the task back for rework.',
      },
      feedback: { type: 'string', description: 'On failure: the rework instruction. On success: optional note.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} verdict: ${result.outcome} (status: ${result.status})`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:验收', kind: 'other', rawInput: { task_id: args.task_id, outcome: args.outcome } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:验收', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'settle_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeSettlement(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      const outcome = args.outcome === 'failure' ? 'failure' : 'success'
      const settled = await ledger.settle(taskId, outcome, args.feedback)
      if (!settled.ok) throw new Error(settled.message)
      // A settled task is terminal: its report moves hot -> cold.
      await deps.reports.archive(taskId)
      // DAG release: a success verdict frees every dependent whose blockers
      // cleared. The scheduler listener dispatches them.
      if (outcome === 'success') {
        ctx.emit('agent-bus/settle', taskId)
        // Result returns to the initiator: the loop closes. The notice names
        // every downstream task this one feeds, and the executor is asked to
        // hand off structured context to each of them.
        const downstream = ledger.listAll()
          .filter(row => (row.dependencies ?? []).includes(taskId))
          .map(row => row.id)
        const handoffHint = downstream.length > 0
          ? `该任务为以下后向任务提供前向依赖:${downstream.join(', ')}。执行方请为每个后向任务调用 submit_handoff 提交交接文档。`
          : ''
        notifySession(ctx, task.assignedBy, taskId,
          `任务 ${taskId} 已验收通过,状态「已完成」(success)。${handoffHint}最终结果:${settled.task.report ?? '(无)'}`,
          'settle_task')
        if (task.assignedTo !== undefined && task.assignedTo !== task.assignedBy && downstream.length > 0) {
          notifySession(ctx, task.assignedTo, taskId,
            `任务 ${taskId} 已验收通过。它为以下后向任务提供前向依赖:${downstream.join(', ')}。`
              + `请为每个后向任务调用 submit_handoff(task_id=${taskId}, to_task_id=<后向任务id>, document=<交接文档>) 提交交接文档。`,
            'settle_task')
        }
        // End-of-flow summary: when the settled task closes out its whole
        // flow, the creator gets one aggregated notice instead of silence —
        // "the flow finished, here is every step's result".
        if (task.flowId !== undefined) {
          const flow = ledger.getFlow(task.flowId)
          const flowTasks = ledger.listAll().filter(row => row.flowId === task.flowId)
          const allDone = flowTasks.length > 0 && flowTasks.every(row =>
            (row.status === 'completed' && row.outcome === 'success')
            || row.status === 'failed' || row.status === 'canceled' || row.status === 'rejected')
          if (flow !== undefined && allDone) {
            const summary = flowTasks.map(row =>
              `${row.id.slice(0, 8)}: ${row.status === 'completed' ? `已完成(${row.outcome})` : row.status}`,
            ).join('\n')
            notifySession(ctx, flow.createdBy, taskId,
              `流程「${flow.name}」已全部结算,不再有进行中的任务。各任务结果:\n${summary}`,
              'settle_task')
          }
        }
      } else if (task.assignedTo !== undefined) {
        // Rework loop: the worker is woken to execute the SAME task again.
        // The rework notice is a new delivery of the task, so its message id
        // must be recorded on the row first — otherwise the claimed listener
        // cannot find the task and it never leaves `submitted`.
        const instruction = args.feedback !== undefined ? args.feedback : '请根据验收意见重新执行。'
        const reworkNotice = buildTaskMessage(callerId, taskId,
          `任务 ${taskId} 验收未通过,已返回「待执行」等待重新执行(failure)。修改意见:${instruction}。请重新执行后调用 report_task 再次提交。`,
          'settle_task')
        const recorded = await ledger.recordDelivery(taskId, reworkNotice.id)
        if (!recorded.ok) throw new Error(recorded.message)
        const worker = ctx.agents.get(task.assignedTo)
        if (worker !== undefined) deliverTask(worker, reworkNotice, 'steer')
      }
      return { taskId, status: settled.task.status, outcome }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'cancel_task',
    description:
      'As the dispatcher, cancel a task you dispatched while it is queued(待投递), submitted, '
      + 'working, or awaiting your input. The worker is interrupted, told the task is canceled, and '
      + 'asked to report a summary of what it had done; the summary lands on the task (read it with '
      + 'get_task). A task that was never delivered (待投递) is canceled without bothering the '
      + 'worker. Only the session that dispatched a task may cancel it; workers cannot cancel their '
      + 'own dispatched tasks.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id to cancel.' },
      reason: { type: 'string', description: 'Why the task is canceled, shown to the worker.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:取消任务', kind: 'other', rawInput: { task_id: args.task_id, ...(args.reason !== undefined ? { reason: args.reason } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:取消任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'cancel_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeSettlement(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      const reason = args.reason !== undefined ? admitContent(args.reason, 400) : undefined
      if (reason !== undefined && !reason.ok) throw new Error(reason.message)
      const canceled = await ledger.transition(taskId, 'canceled', {
        ...(reason?.ok === true ? { reason: reason.content } : {}),
      })
      if (!canceled.ok) throw new Error(canceled.message)
      // A canceled task is terminal: its report moves hot -> cold.
      await deps.reports.archive(taskId)

      // Interrupt the worker's in-flight turn, then ask for the summary. Both
      // are best-effort: an absent worker keeps the canceled row and the
      // summary request is skipped. A queued task was never delivered, so its
      // worker has nothing to summarize — cancel quietly.
      const worker = task.assignedTo !== undefined && task.status !== 'queued'
        ? ctx.agents.get(task.assignedTo)
        : undefined
      if (worker !== undefined) {
        try {
          worker.cancel({ kind: 'user' }, { keepInbox: true })
        } catch {
          // The cancel signal is advisory; a worker that already settled the
          // turn needs no interruption.
        }
        const note = `任务 ${taskId} 状态「已取消」,由派发方取消${reason?.ok === true ? `(${reason.content})` : ''}。`
          + '请用 report_task 提交你已完成部分的摘要。'
        const summary = buildTaskMessage(callerId, taskId, note, 'cancel_task')
        deliverTask(worker, summary, 'steer')
      }
      return { taskId, status: canceled.task.status }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'request_input',
    description:
      'As the worker, pause a task you are working on because you need information only the '
      + 'dispatcher has. The task enters input-required with your question; the dispatcher answers '
      + 'with create_task passing task_id, and the task resumes when the answer arrives. Keep the '
      + 'question specific so one round-trip suffices.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The working ledger task id.' },
      question: { type: 'string', required: true, description: 'What you need from the dispatcher.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:请求输入', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:请求输入', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'request_input')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const admitted = admitContent(args.question, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const paused = await ledger.transition(taskId, 'input-required', { question: admitted.content })
      if (!paused.ok) throw new Error(paused.message)
      deps.noteActivity(callerId)
      return { taskId, status: paused.task.status }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'update_card',
    description:
      'Maintain your own capability card, which list_peers shows to the workspace. description is '
      + 'what you say about yourself, for other agents to read; capabilities are machine-readable '
      + 'labels — ids are lowercase kebab-case keys, at most 8, each with a short label. The update '
      + 'replaces the whole card. Keep the description honest and the capabilities narrow: peers '
      + 'route work by what you claim here.',
    parameters: {
      description: { type: 'string', description: 'One or two sentences about what you do well.' },
      capabilities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Lowercase kebab-case machine key.' },
            label: { type: 'string', required: true, description: 'Short human-readable label.' },
          },
        },
        description: 'Your machine-readable capability list, at most 8 entries.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
          capabilities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, card) => [{
        type: 'text',
        text: card.description === ''
          ? '(card cleared)'
          : `${card.description}\n${(card.capabilities ?? []).map(c => `${c.id}: ${c.label}`).join('\n')}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:更新卡片', kind: 'other', rawInput: { description: args.description, capabilities: args.capabilities } }),
    presentResult: (_args, card) => ({ card: 'generic', title: 'agent-bus:更新卡片', rawInput: card }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'update_card')
      const description = (args.description ?? '').trim()
      if (description.length > 200) {
        throw new Error(`description is ${description.length} characters, over the 200 limit`)
      }
      const capabilities = (args.capabilities ?? []).map(item => ({
        id: String(item.id).trim(),
        label: String(item.label).trim(),
      }))
      const seen = new Set<string>()
      for (const cap of capabilities) {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(cap.id)) {
          throw new Error(`capability id "${cap.id}" must be lowercase kebab-case`)
        }
        if (cap.label.length === 0 || cap.label.length > 50) {
          throw new Error(`capability label for "${cap.id}" must be 1-50 characters`)
        }
        if (seen.has(cap.id)) {
          throw new Error(`duplicate capability id "${cap.id}"`)
        }
        seen.add(cap.id)
      }
      const card = { description, capabilities, updatedAt: new Date().toISOString() }
      await ledger.putCard(callerId, card)
      // The durable record carries updatedAt; the tool result is the
      // model-facing projection, which must match the declared output schema.
      return { description, capabilities }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'answer_question',
    description:
      'Answer a structured question the worker asked via the dsh ask_user_question tool while executing '
      + 'YOUR task: the task paused as input-required and the question (with its options) was forwarded to '
      + 'you. Provide one answer item per pending question — the question id, the selected option label(s), '
      + 'and optional custom text. Only the task initiator (the session that dispatched the task) may answer.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The input-required task id carrying the worker\'s pending questions.' },
      answers: {
        type: 'array',
        required: true,
        description: 'One answer per pending question, each with the question id, selected option label(s), and optional custom text.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'The pending question id (echoed from the forwarded question).' },
            selected: { type: 'array', required: true, items: { type: 'string' }, description: 'Selected option label(s).' },
            custom: { type: 'string', description: 'Optional free-text answer.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          answered: { type: 'number', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} answered ${result.answered} question(s); status ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:回答问题', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:回答问题', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'answer_question')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedBy !== callerId) throw new Error('仅任务发起方可回答')
      if (task.status !== 'input-required' || task.pendingQuestions === undefined || task.pendingQuestions.length === 0) {
        throw new Error(`task "${taskId}" has no pending question to answer`)
      }
      const normalized = normalizeQuestionAnswers(args.answers, task.pendingQuestions)
      const resolved = deps.questions.resolve(taskId, { answers: normalized })
      if (!resolved) {
        throw new Error(`task "${taskId}" question is no longer pending (it may have timed out)`)
      }
      const resumed = await ledger.transition(taskId, 'working', { pendingQuestions: undefined, question: undefined })
      if (!resumed.ok) throw new Error(resumed.message)
      return { taskId: String(taskId), status: resumed.task.status, answered: normalized.length }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'claim_task',
    description:
      'As the executor, pull a task you were assigned back into working: a '
      + 'submitted task is delivered automatically, but a re-delivery can land '
      + 'while the previous delivery was lost (a rejected step, a restart) — '
      + 'claiming gives you the key to recover it yourself and then report. '
      + 'Only the assigned executor may claim. Claiming a task you already '
      + 'have in working is a no-op that returns the current status.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id to claim.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:领取任务', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:领取任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'claim_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeClaim(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      // Already working AND the executor is the caller: idempotent no-op.
      if (task.status === 'working') {
        deps.noteActivity(callerId)
        return { taskId: String(taskId), status: task.status }
      }
      if (task.status !== 'submitted') {
        throw new Error(`task "${taskId}" is ${task.status}; only a submitted task can be claimed`)
      }
      const claimed = await ledger.transition(taskId, 'working')
      if (!claimed.ok) throw new Error(claimed.message)
      deps.noteActivity(callerId)
      return { taskId: String(taskId), status: claimed.task.status }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'create_member',
    description:
      'One-click onboarding: create a full team member bound to a workspace. Required: '
      + 'name (session title). workspace (path or id) is optional and defaults to the caller\'s '
      + 'current workspace when omitted. Optional: role (persona prose injected '
      + 'as a system-prompt section), skills (runtime skill definitions mounted in the member\'s '
      + 'scope), permissions (preset name, or {sandbox, approval} knobs), flow (flow id or name '
      + 'to join), and description (capability-card text, at most 200 characters). The member '
      + 'receives the deployment\'s default agent preset as its baseline composition when one '
      + 'exists. mcp and modules are accepted but not implemented this phase (mcp needs '
      + 'preset-file authoring; modules is a reserved extension point) — both surface as '
      + 'warnings, never errors. Any step failure rolls back the created session; no '
      + 'half-baked member survives. Use for real team members only — a member is a named '
      + 'session with its own skills, permissions, and card.',
    parameters: {
      workspace: { type: 'string', description: 'Workspace path or id the new member is bound to; omit to use the caller\'s current workspace.' },
      name: { type: 'string', required: true, description: 'Session name (title), 1–20 chars; whitespace-padded values are trimmed.' },
      role: { type: 'string', description: 'Role/persona prose injected as a system-prompt section.' },
      skills: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Kebab-case skill identifier.' },
            description: { type: 'string', description: 'Short routing description; omit to reference an existing skill by name.' },
            content: { type: 'string', description: 'Markdown instruction body; omit to reference an existing skill by name.' },
          },
        },
        description: 'Runtime skill definitions mounted into the member\'s scope: inline {name, description, content}, or {name} only to reference an already-discovered skill (its body is resolved at onboarding).',
      },
      mcp: { type: 'object', additionalProperties: true, description: 'MCP configuration; not injectable programmatically this phase, skipped with a warning.' },
      permissions: {
        oneOf: [
          {
            type: 'string',
            description:
              'Permission preset name. One of: ' + permissionPresetNamesHint
              + '. An unknown preset name is refused.',
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              sandbox: { type: 'string', enum: [...SANDBOX_MODES], required: true, description: `Sandbox mode; one of ${SANDBOX_MODES.join('|')}.` },
              approval: { type: 'string', enum: [...APPROVAL_POLICIES], required: true, description: `Approval policy; one of ${APPROVAL_POLICIES.join('|')}.` },
            },
          },
        ],
        description:
          'Preset name, or explicit {sandbox, approval} knobs (sandbox ∈ ['
          + SANDBOX_MODES.join(', ') + '], approval ∈ [' + APPROVAL_POLICIES.join(', ')
          + ']); omitted keeps the workspace default.',
      },
      flow: { type: 'string', description: 'Flow id or name to join, resolved within the target workspace.' },
      description: { type: 'string', description: 'Capability-card description (at most 200 characters).' },
      modules: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Reserved extension point; ignored this phase.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          workspaceId: { type: 'string', required: true },
          workspacePath: { type: 'string', required: true },
          steps: { type: 'array', items: { type: 'string' }, required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          flow: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `member ${result.name} onboarded (${result.sessionId.slice(0, 8)}…; steps: ${result.steps.join(' → ')}; workspace: ${result.workspacePath})`
          + (result.flow !== undefined ? `; joined flow "${result.flow.name}"` : '')
          + (result.warnings.length > 0 ? `; warnings: ${result.warnings.join('; ')}` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建成员', kind: 'other', rawInput: { name: args.name, ...(args.workspace !== undefined ? { workspace: args.workspace } : {}), ...(args.role !== undefined ? { role: args.role } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_member')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('create_member: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace === undefined) {
        throw new Error('create_member: the calling session is not inside a registered workspace')
      }
      const parsed = parseCreateMemberInput(args, callerWorkspace)
      if (!parsed.ok) throw new Error(parsed.error)
      const host: CreateMemberHost = {
        workspaceRegistry: workspaces,
        agents: ctx.agents,
        sessionTitle: ctx.sessionTitle,
        permissionPresets: ctx.get('permissionPresets') as PermissionPresetHost | undefined,
        agentPresets: ctx.get('agentPresets') as PresetMountHost | undefined,
        skills: ctx.get('skills') as {
          get(name: string): Promise<{ description: string; content: string } | undefined>
        } | undefined,
        ledger,
      }
      // The new agent renders `{{model}}` from options.model and the request
      // build needs a provider route; default both from the caller so the
      // member session can assemble its persona and resolve the model adapter.
      const callerRoute = (caller as { options?: { provider?: string; model?: string } }).options
      const routeForMember = callerRoute !== undefined
        && (callerRoute.provider !== undefined || callerRoute.model !== undefined)
        ? {
            ...parsed.plan,
            ...(callerRoute.provider !== undefined ? { provider: callerRoute.provider } : {}),
            ...(callerRoute.model !== undefined ? { model: callerRoute.model } : {}),
          }
        : parsed.plan
      const result = await onboardMember(host, routeForMember)
      // The output schema infers mutable string arrays; copy the readonly
      // result fields so the return is assignable under any inference variant.
      return { ...result, steps: [...result.steps], warnings: [...result.warnings] }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'reconfigure_member',
    description:
      'Reconfigure an existing member (a peer in your workspace) without rebuilding the session: '
      + 'replace its role and/or its permissions in place. member_id is the member session id from '
      + 'list_peers. role is the persona-style prose injected as the member\'s system-prompt section; '
      + 'permissions is a preset name or an explicit {sandbox, approval} knob pair, exactly as in '
      + 'create_member. The change takes effect on the member\'s next turn (a dormant member is '
      + 'woken first, then configured). Skill reconfiguration is not supported yet — cancel and '
      + 'recreate the member to change skills. Use this instead of cancel/recreate when you built the '
      + 'wrong role or permissions.',
    parameters: {
      member_id: { type: 'string', required: true, description: 'The member session id (peer id from list_peers) to reconfigure.' },
      role: { type: 'string', description: 'Replacement role/persona prose injected as a system-prompt section; takes effect on the member\'s next turn.' },
      permissions: {
        oneOf: [
          {
            type: 'string',
            description:
              'Permission preset name. One of: ' + permissionPresetNamesHint
              + '. An unknown preset name is refused.',
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              sandbox: { type: 'string', enum: [...SANDBOX_MODES], required: true, description: `Sandbox mode; one of ${SANDBOX_MODES.join('|')}.` },
              approval: { type: 'string', enum: [...APPROVAL_POLICIES], required: true, description: `Approval policy; one of ${APPROVAL_POLICIES.join('|')}.` },
            },
          },
        ],
        description:
          'Preset name, or explicit {sandbox, approval} knobs (sandbox ∈ ['
          + SANDBOX_MODES.join(', ') + '], approval ∈ [' + APPROVAL_POLICIES.join(', ')
          + ']); omitted keeps the current permission pin.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberId: { type: 'string', required: true },
          steps: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `member ${result.memberId.slice(0, 8)} reconfigured (${result.steps.join(' → ')})`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:改配成员', kind: 'other', rawInput: { member_id: args.member_id, ...(args.role !== undefined ? { role: args.role } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:改配成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'reconfigure_member')
      const memberId = String(args.member_id) as SessionId
      // A member's role/permissions are set by a peer, never by itself: a
      // worker could otherwise grant itself danger-full-access. The target must
      // still be a real same-workspace peer (live or dormant) to reach here.
      if (memberId === callerId) {
        throw new Error('reconfigure_member: cannot reconfigure the calling session itself')
      }
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('reconfigure_member: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace === undefined) {
        throw new Error('reconfigure_member: the calling session is not inside a registered workspace')
      }
      const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, memberId)
      if (!decision.ok) throw new Error(decision.message)
      const parsed = parseReconfigureMemberInput(args)
      if (!parsed.ok) throw new Error(parsed.error)
      const host: ReconfigureMemberHost = {
        agents: {
          get: id => ctx.agents.get(id),
          resume: async id => wakeSession(ctx, id),
        },
        permissionPresets: ctx.get('permissionPresets') as PermissionPresetHost | undefined,
        setRole: (member, text) => setMemberRole(String(member.id), member.ctx, text),
      }
      const result = await reconfigureMember(host, parsed.plan)
      // The output schema infers mutable string arrays; copy the readonly
      // result fields so the return is assignable under any inference variant.
      return { ...result, steps: [...result.steps] }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'tool_help',
    description:
      'Return the FULL manual of one agent-bus tool as a tool result. The system '
      + 'prompt carries only a short routing overview; call this before executing '
      + 'a tool whose exact contract you want to confirm — it discloses the '
      + 'complete parameter, semantic, and authorization details of that one tool '
      + 'on demand.',
    parameters: {
      tool: {
        type: 'string',
        required: true,
        enum: [...TOOL_NAMES],
        description: 'The agent-bus tool name to document.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: { type: 'string', required: true },
          doc: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{ type: 'text', text: result.doc }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:工具说明书', kind: 'other', rawInput: { tool: args.tool } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:工具说明书', rawInput: result }),
    async execute(args, exec) {
      requireCaller(exec.agent, 'tool_help')
      const name = String(args.tool) as ToolName
      const doc = TOOL_DOCS[name]
      if (doc === undefined) throw new Error(`no manual for tool "${name}"`)
      return { tool: name, doc }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'archive_task',
    description:
      'Mark one task archived or unarchived (manual, never automatic). Archiving is a visibility '
      + 'choice: it hides the row from list_tasks and the active listing; unarchiving restores it. '
      + 'A queued, working, or completed task may be archived, and the change is reversible. Nothing '
      + 'in the lifecycle machine archives a task on its own.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id to toggle.' },
      archived: {
        type: 'boolean',
        description: 'true archives (default), false unarchives.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `任务 ${result.taskId} [${result.status}] 已${result.archived ? '归档' : '取消归档'}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:归档任务', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:归档任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'archive_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (!canReadTask(task, callerId)) throw new Error(`task "${taskId}" is not visible to you`)
      const archived = args.archived !== false
      const archivedRes = await ledger.archiveTask(taskId, archived)
      if (!archivedRes.ok) throw new Error(archivedRes.message)
      return { taskId: String(taskId), status: archivedRes.task.status, archived }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'archive_flow',
    description:
      'Mark one flow archived or unarchived (manual, never automatic). A flow stays active until '
      + 'you archive it, and archiving is not derived from its tasks; unarchiving restores it. Only '
      + 'the flow creator may archive it.',
    parameters: {
      flow_id: { type: 'string', required: true, description: 'The flow id to toggle.' },
      archived: {
        type: 'boolean',
        description: 'true archives (default), false unarchives.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `流程 『${result.name}』 已${result.archived ? '归档' : '取消归档'}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:归档流程', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:归档流程', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'archive_flow')
      const flowId = String(args.flow_id)
      const flow = ledger.getFlow(flowId)
      if (flow === undefined) throw new Error(`no such flow "${flowId}"`)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('archive_flow: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace !== flow.workspacePath) {
        throw new Error(`flow "${flowId}" is in a different workspace`)
      }
      const archived = args.archived !== false
      const archivedRes = await ledger.archiveFlow(flowId, archived)
      if (!archivedRes.ok) throw new Error(archivedRes.message)
      return { flowId, name: archivedRes.flow.name, archived }
    },
  }))

  ctx.tools.register(checkedTool({
    name: 'archive_member',
    description:
      'Archive one member session (a peer in your workspace). Archiving is a visibility and '
      + 'recognition choice: an archived member is hidden from list_peers and is no longer a '
      + 'deliverable target, so it stops being a peer. The change is one-way (the harness session '
      + 'archive set is append-only — no unarchive path), so only archive sessions you no longer '
      + 'want to recognize as peers. It only affects workspace recognition; the session\'s own log is '
      + 'untouched.',
    parameters: {
      member_id: { type: 'string', required: true, description: 'The member session id (peer id from list_peers) to archive.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberId: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `成员 ${result.memberId} 已归档`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:归档成员', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:归档成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'archive_member')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('archive_member: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace === undefined) {
        throw new Error('archive_member: the calling session is not inside a registered workspace')
      }
      // The member must belong to the caller's workspace account: only a real
      // same-workspace session can be hidden from these peers (so a caller
      // cannot archive an unrelated/other-workspace session).
      const memberId = String(args.member_id)
      const inWorkspace = workspaces.list().some(workspace =>
        workspace.path === callerWorkspace
        && workspace.sessionIds.some(id => String(id) === memberId))
      if (!inWorkspace) {
        throw new Error(`archive_member: session "${memberId}" is not a session of your workspace`)
      }
      await workspaces.archiveSession(memberId as SessionId)
      return { memberId, archived: true }
    },
  }))
}

/** Generate a fresh task id. */
function randomTaskId(): string {
  return randomUUID()
}
