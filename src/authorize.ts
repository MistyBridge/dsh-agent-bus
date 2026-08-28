/**
 * The single authorization gate for every agent-bus operation.
 *
 * One function, called from one place per tool. The reference implementation
 * this replaces had an exported `requireSameWorkspace` that no caller ever
 * invoked, with each handler hand-rolling its own check — three of its tools
 * ended up with no gate at all. Reachability is decided here or nowhere.
 *
 * No role field participates. Authority is derived from durable relationships,
 * mirroring the harness's own lineage check: reachability from shared
 * workspace membership, settlement authority from the recorded dispatcher.
 *
 * @module dsh-agent-bus/authorize
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { isTerminal } from './ledger.ts'
import type { TaskRecord } from './domain/types.ts'

/** Why an operation was refused. */
export type DenialReason =
  | 'caller-not-live'
  | 'caller-has-no-workspace'
  | 'target-not-live'
  | 'target-outside-workspace'
  | 'target-is-subagent'
  | 'target-not-in-workspace'
  | 'target-archived'
  | 'self-delivery'
  | 'not-dispatcher'
  | 'not-executor'
  | 'not-task-party'
  | 'task-not-found'

/** A refusal carrying the reason and a model-facing explanation. */
export interface Denial {
  readonly ok: false
  readonly reason: DenialReason
  readonly message: string
}

/** A granted peer operation, carrying the resolved participants. */
export interface PeerGrant {
  readonly ok: true
  /** The verified live caller. */
  readonly caller: Agent
  /** The verified live recipient. */
  readonly target: Agent
  /** Canonical workspace path both share. */
  readonly workspacePath: string
}

/** Outcome of a peer authorization request. */
export type PeerDecision = PeerGrant | Denial

/** Grant for a note recipient (v1.5): the workspace is all that is needed. */
export interface NoteGrant {
  readonly ok: true
  readonly workspacePath: string
}

export type NoteDecision = NoteGrant | Denial

function deny(reason: DenialReason, message: string): Denial {
  return { ok: false, reason, message }
}

/**
 * Resolve the canonical workspace path a live agent belongs to.
 *
 * `SessionHeader` carries no workspace id, so the only route is the session's
 * `cwd` through the registry's `realpath`-based lookup. Membership in the
 * registry is a two-part condition — the id must be in the durable account
 * AND the session's canonical `cwd` must equal the workspace path — so the
 * returned path is authoritative for equality comparisons.
 *
 * @param registry - the workspace registry service.
 * @param agent - the agent whose workspace to resolve.
 * @returns the canonical workspace path, or `undefined` when the agent has no
 * `cwd` or its directory is not a registered workspace.
 */
export async function resolveWorkspacePath(
  registry: WorkspaceRegistry,
  agent: Agent,
): Promise<string | undefined> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) return undefined
  try {
    const workspace = await registry.resolveByPath(cwd)
    return workspace?.path
  } catch {
    // resolveByPath realpaths the directory, which throws when the session's
    // cwd was deleted after the session was created. A session whose
    // directory no longer exists has no workspace, same as one with no cwd.
    return undefined
  }
}

/**
 * Authorize one peer operation between two sessions.
 *
 * Both parties must be exactly live: ambient presence is neither liveness
 * proof nor authorization, so each id is resolved against `ctx.agents` and
 * compared by identity. A caller without a resolvable workspace is refused
 * outright rather than defaulted into a fallback workspace.
 *
 * @param ctx - the plugin context, used to resolve live agents.
 * @param registry - the workspace registry service.
 * @param callerId - the session claiming to act.
 * @param targetId - the intended peer.
 * @returns a grant with both resolved agents, or a refusal.
 */
export async function authorizePeer(
  ctx: Context,
  registry: WorkspaceRegistry,
  callerId: SessionId,
  targetId: SessionId,
): Promise<PeerDecision> {
  const caller = ctx.agents.get(callerId)
  if (caller === undefined) {
    return deny('caller-not-live', 'the calling session is not a live agent')
  }
  if (callerId === targetId) {
    // Self-execution is allowed (a flow may schedule the PM as a worker), but
    // the caller still needs a workspace to reach itself with. The reviewer
    // independence rule is enforced at create_task (reviewer must differ from
    // the executor when target === caller), never here.
    const workspacePath = await resolveWorkspacePath(registry, caller)
    if (workspacePath === undefined) {
      return deny(
        'caller-has-no-workspace',
        'the calling session is not inside a registered workspace, so it has no reachable peers',
      )
    }
    return { ok: true, caller, target: caller, workspacePath }
  }
  const callerWorkspace = await resolveWorkspacePath(registry, caller)
  if (callerWorkspace === undefined) {
    return deny(
      'caller-has-no-workspace',
      'the calling session is not inside a registered workspace, so it has no reachable peers',
    )
  }
  const target = ctx.agents.get(targetId)
  if (target === undefined) {
    return deny(
      'target-not-live',
      `session "${targetId}" is not live; this version delivers only to running sessions`,
    )
  }
  // Subagents are owned by their parent session through the harness lineage;
  // peer dispatch applies to independent sessions only.
  if (target.session.header.origin === 'subagent') {
    return deny(
      'target-is-subagent',
      `session "${targetId}" is a subagent owned by another session; dispatch reaches independent sessions only`,
    )
  }
  const targetWorkspace = await resolveWorkspacePath(registry, target)
  if (targetWorkspace !== callerWorkspace) {
    return deny(
      'target-outside-workspace',
      `session "${targetId}" is not in workspace "${callerWorkspace}"`,
    )
  }
  return { ok: true, caller, target, workspacePath: callerWorkspace }
}

/**
 * Authorize a verdict on a completed task.
 *
 * Settlement authority belongs to the session recorded as the task's
 * reviewer — the explicit `assignedReviewer`, or the initiator when none was
 * named. This keeps the reviewer role emergent from the durable relationship
 * rather than a stored role flag, and it forecloses self-approval: a worker
 * that is not also the reviewer can never settle its own task.
 *
 * @param task - the ledger row to settle, or `undefined` when the id is unknown.
 * @param callerId - the session claiming settlement authority.
 * @returns `undefined` when authorized, otherwise the refusal.
 */
export function authorizeSettlement(
  task: TaskRecord | undefined,
  callerId: SessionId,
): Denial | undefined {
  if (task === undefined) {
    return deny('task-not-found', 'no such task in this ledger')
  }
  const reviewer = task.assignedReviewer ?? task.assignedBy
  if (reviewer !== callerId) {
    return deny(
      'not-dispatcher',
      `only the task's reviewer may settle task "${task.id}"`,
    )
  }
  return undefined
}

/**
 * Authorize a claim on a submitted task.
 *
 * Claim authority belongs to the recorded executor (`assignedTo`) alone — the
 * same durable relationship that lets the executor report. A worker that is
 * not the assigned executor cannot pull a task it was never given, and the
 * initiator cannot claim a task it dispatched (reassign is the initiator's
 * lever). This is the worker-side counterpart of {@link authorizeSettlement}.
 *
 * @param task - the ledger row to claim, or `undefined` when the id is unknown.
 * @param callerId - the session claiming execution.
 * @returns `undefined` when authorized, otherwise the refusal.
 */
export function authorizeClaim(
  task: TaskRecord | undefined,
  callerId: SessionId,
): Denial | undefined {
  if (task === undefined) {
    return deny('task-not-found', 'no such task in this ledger')
  }
  if (task.assignedTo !== callerId) {
    return deny(
      'not-executor',
      `该任务不属于你:task "${task.id}" is assigned to another session`,
    )
  }
  return undefined
}

/**
 * Whether a session is one of a task's participants: the dispatcher
 * (`assignedBy`), the executor (`assignedTo`), or the reviewer
 * (`assignedReviewer`, defaulting to the dispatcher when unnamed).
 *
 * @param task - the ledger row.
 * @param callerId - the session to test.
 * @returns `true` when the session holds one of the three durable roles.
 */
export function isTaskParty(task: TaskRecord, callerId: SessionId): boolean {
  return task.assignedBy === callerId
    || task.assignedTo === callerId
    || task.assignedReviewer === callerId
}

/**
 * Authorize reading a task.
 *
 * A LIVE task (queued / submitted / working / input-required / auth-required)
 * is owned by its participants alone — content, feedback, and questions must
 * not leak to same-workspace bystanders that were never part of the job.
 * Completed and terminally-failed tasks are history and public, so a reviewer
 * or a future audit can still read the record.
 *
 * @param task - the ledger row to read, or `undefined` when the id is unknown.
 * @param callerId - the session requesting the read.
 * @returns `undefined` when authorized, otherwise the refusal.
 */
export function authorizeTaskRead(
  task: TaskRecord | undefined,
  callerId: SessionId,
): Denial | undefined {
  if (task === undefined) {
    return deny('task-not-found', 'no such task in this ledger')
  }
  // History is public: completed (settled or awaiting its verdict) and
  // terminally-failed (failed / canceled / rejected, the immediately-archived
  // set) tasks are readable by anyone.
  if (task.status === 'completed' || isTerminal(task.status)) return undefined
  if (isTaskParty(task, callerId)) return undefined
  return deny(
    'not-task-party',
    `该任务与你无关:task "${task.id}" belongs to other sessions`,
  )
}

/**
 * Authorize a send_note recipient (v1.5 durable notes).
 *
 * Looser than {@link authorizePeer}: the recipient may be OFFLINE — the
 * note is queued and delivered when the recipient is live again. The
 * recipient must still be a real session of the caller's workspace (the
 * same registry index the sidebar uses), so messages never go to strangers
 * or to other workspaces.
 *
 * @param ctx - the plugin context, used to resolve live agents.
 * @param registry - the workspace registry service.
 * @param callerId - the session claiming to act.
 * @param targetId - the intended recipient (may be offline).
 * @returns a grant with the resolved caller and workspace path, or a refusal.
 */
export async function authorizeNoteRecipient(
  ctx: Context,
  registry: WorkspaceRegistry,
  callerId: SessionId,
  targetId: SessionId,
): Promise<NoteDecision> {
  const caller = ctx.agents.get(callerId)
  if (caller === undefined) {
    return deny('caller-not-live', 'the calling session is not a live agent')
  }
  if (callerId === targetId) {
    return deny('self-delivery', 'a session cannot send a note to itself')
  }
  const callerWorkspace = await resolveWorkspacePath(registry, caller)
  if (callerWorkspace === undefined) {
    return deny(
      'caller-has-no-workspace',
      'the calling session is not inside a registered workspace, so it has no reachable peers',
    )
  }
  // The recipient must be indexed by the caller's workspace — the same
  // registry account the sidebar and the session directory use. Attach
  // state does not matter: an offline recipient gets a queued note. A
  // manually ARCHIVED session is out of reach: the user archived it, so it
  // must not be woken.
  const archived = new Set((registry.archivedSessionIds ?? []).map(String))
  const known = registry.list().some(workspace =>
    workspace.path === callerWorkspace
    && workspace.sessionIds.some(id => String(id) === String(targetId)))
  if (!known) {
    return deny(
      'target-not-in-workspace',
      `session "${targetId}" is not a session of your workspace`,
    )
  }
  if (archived.has(String(targetId))) {
    return deny(
      'target-archived',
      `session "${targetId}" is archived; unarchive it in the workspace before sending notes`,
    )
  }
  return { ok: true, workspacePath: callerWorkspace }
}

/**
 * Authorize a delivery target that may be DORMANT (v1.5 wake-on-delivery).
 *
 * Looser than {@link authorizePeer}: the target may be offline, as long as
 * it is a real session of the caller's workspace (the same registry index
 * the sidebar uses). The caller still must be live and inside a workspace;
 * the target's identity is the registry account, never a guess. The caller
 * then wakes the target (see wake.ts) and delivers; if waking fails, the
 * task stays queued or the note is queued offline.
 *
 * @param ctx - the plugin context, used to resolve live agents.
 * @param registry - the workspace registry service.
 * @param callerId - the session claiming to act.
 * @param targetId - the intended target (may be dormant).
 * @returns a grant with the caller, workspace path, and liveness of the
 *   target, or a refusal.
 */
export async function authorizePeerOrDormant(
  ctx: Context,
  registry: WorkspaceRegistry,
  callerId: SessionId,
  targetId: SessionId,
): Promise<PeerDecision> {
  const caller = ctx.agents.get(callerId)
  if (caller === undefined) {
    return deny('caller-not-live', 'the calling session is not a live agent')
  }
  if (callerId === targetId) {
    // Self-execution is allowed; reviewer independence is enforced by the
    // caller (create_task / reassign_task), never here.
    const workspacePath = await resolveWorkspacePath(registry, caller)
    if (workspacePath === undefined) {
      return deny(
        'caller-has-no-workspace',
        'the calling session is not inside a registered workspace, so it has no reachable peers',
      )
    }
    return { ok: true, caller, target: caller, workspacePath }
  }
  const callerWorkspace = await resolveWorkspacePath(registry, caller)
  if (callerWorkspace === undefined) {
    return deny(
      'caller-has-no-workspace',
      'the calling session is not inside a registered workspace, so it has no reachable peers',
    )
  }
  const known = registry.list().some(workspace =>
    workspace.path === callerWorkspace
    && workspace.sessionIds.some(id => String(id) === String(targetId)))
  if (!known) {
    return deny(
      'target-not-in-workspace',
      `session "${targetId}" is not a session of your workspace`,
    )
  }
  // A manually archived session is out of reach: the user archived it, so it
  // must not be woken or delivered to.
  const archived = new Set((registry.archivedSessionIds ?? []).map(String))
  if (archived.has(String(targetId))) {
    return deny(
      'target-archived',
      `session "${targetId}" is archived; unarchive it in the workspace before dispatching to it`,
    )
  }
  const live = ctx.agents.get(targetId)
  if (live !== undefined && live.session.header.origin === 'subagent') {
    return deny(
      'target-is-subagent',
      `session "${targetId}" is a subagent owned by another session; dispatch reaches independent sessions only`,
    )
  }
  return {
    ok: true,
    caller,
    target: live ?? caller, // dormant: wake.ts provides the real agent
    workspacePath: callerWorkspace,
  }
}
