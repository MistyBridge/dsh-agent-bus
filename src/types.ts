/**
 * Vocabulary types for the agent-bus task ledger: branded ids, the A2A-aligned
 * task lifecycle, the peer card, and the durable record shape.
 *
 * The ledger records intent and outcome. It is deliberately NOT a mirror of
 * the agent inbox: the inbox is the execution authority and the two drift by
 * design (an interrupt keeps unclaimed queue items but does not requeue a
 * claimed one, and disposal discards every unclaimed item).
 *
 * @module dsh-agent-bus/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

// The agent-bus relay kinds are declared in delivery.ts (AgentBusTaskMessageSource /
// AgentBusMessageSource). An earlier duplicate of this MessageSourceMap
// augmentation here used inline literal types and merged with delivery.ts's
// interface-typed declaration, which TS rejects (TS2717: subsequent property
// declarations must have the same type). delivery.ts already contributes these
// kinds globally, so no separate augmentation is needed here.

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A task settled successfully; the DAG scheduler releases its dependents.
     * @param taskId - the settled task's id.
     * @mode emit
     */
    'agent-bus/settle'(taskId: string): void
    /**
     * A task's status or settlement changed (v1.4). Emitted AFTER the durable
     * write; the client event-driven scheduler consumes this stream via SSE.
     */
    'agent-bus/task-changed'(change: TaskChangedEvent): void
  }
}

/** One TaskChanged event: a status/settlement change after the durable write. */
export interface TaskChangedEvent {
  readonly taskId: string
  /** Prior status, or `-` for creation. */
  readonly from: string
  /** New status, settlement marker, or `edited`. */
  readonly to: string
  readonly at: string
}

/**
 * Ledger-owned task identity. Independent of the harness `MessageId` because
 * a task exists in `submitted` before any delivery has produced one.
 */
export type TaskId = string & { readonly __brand: 'AgentBusTaskId' }

/** Brand a raw string as a {@link TaskId}; branding has no runtime effect. */
export function TaskId(value: string): TaskId {
  return value as TaskId
}

/**
 * Task lifecycle: the A2A TaskState vocabulary plus one extension.
 * `queued` is the pre-delivery phase of `submitted` — a task whose DAG
 * predecessors are not all settled. Everything else is verbatim A2A;
 * extensions ride {@link TaskRecord.reason} and friends.
 *
 * - `queued` — created but not delivered; waiting for every dependency to
 *   settle. The client event-driven scheduler dispatches it (v1.4).
 * - `submitted` — delivered to the worker, awaiting claim.
 * - `working` — claimed into a turn and executing.
 * - `input-required` — the worker asked the dispatcher for input; the task
 *   resumes `working` when the answer is claimed.
 * - `auth-required` — retained for vocabulary completeness; this plugin
 *   never produces it.
 * - `completed` — terminal. The worker reported; the report is the artifact.
 * - `failed` — terminal; {@link TaskRecord.reason} distinguishes timeout,
 *   no-response, discarded, and rejected-by-dispatcher.
 * - `canceled` — terminal; the dispatcher canceled.
 * - `rejected` — reserved; no transition produces it yet.
 */
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

/** Verdict the dispatcher records on a completed task. */
export type TaskOutcome = 'success' | 'failure'

/**
 * Delivery mode requested for a task, mapped onto the harness inbox
 * boundaries. Task delivery uses `followup`; `inject` only enqueues and waits
 * for another message to wake the recipient, so it never carries work.
 */
export type DeliveryMode = 'followup' | 'steer'

/**
 * Four-bucket token usage, the same shape as the token-meter projection
 * (`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` /
 * `cacheWriteTokens`). Used for task-period consumption deltas.
 */
export interface TokenBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** One machine-readable capability a peer advertises. */
export interface Capability {
  /** Machine key: kebab-case, matched by programs and future routing. */
  readonly id: string
  /** Short label for human and model readers. */
  readonly label: string
}

/**
 * One peer's self-maintained card. Keyed by the session id; the whole record
 * is overwritten on update, never field-merged.
 */
export interface PeerCard {
  /** Model-facing self-introduction. */
  readonly description: string
  /** Machine-readable capabilities, at most 8, ids unique. */
  readonly capabilities: readonly Capability[]
  /** ISO-8601 stamp of the last update. */
  readonly updatedAt: string
}

/**
 * One handoff document: a completed task's executor delivers structured
 * context to each task that depends on it. Attached to the DOWNSTREAM task;
 * dispatch concatenates handoffs into its delivered content.
 */
export interface HandoffEntry {
  /** The completed predecessor whose executor wrote this document. */
  readonly fromTask: TaskId
  readonly document: string
  readonly at: string
}

/**
 * One flow: a named DAG container for tasks (v1.4). Archiving is a user
 * action, never automatic: a flow stays active until it is manually archived,
 * and unarchiving returns it to the active listing.
 */
export interface FlowRecord {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly createdBy: SessionId
  readonly workspacePath: string
  readonly createdAt: string
  /** Manual archive marker; never derived from task state. */
  readonly archived?: boolean
}

/** One option of a structured question; structurally equal to the official
 * `ask_user_question` option (`{ label, description? }`), defined here so the
 * out-of-repo plugin carries no runtime dependency on the tool package. */
export interface PendingQuestionOption {
  /** Short user-facing option label; the answer's `selected` references it. */
  label: string
  /** One sentence explaining the tradeoff or impact. */
  description?: string
}

/** One structured question a worker asked via `ask_user_question` while
 * executing a task; persisted on the row while the task is `input-required`
 * awaiting the initiator's answer. */
export interface PendingQuestion {
  /** Stable id echoed in the answer. */
  id: string
  /** The specific question to answer. */
  question: string
  /** Optional short heading, such as "Confirm" or "Choose Mode". */
  header?: string
  /** Choices shown to the answerer; empty when the question is free-form. */
  options: PendingQuestionOption[]
  /** Whether more than one option may be selected. */
  multiSelect: boolean
}

/** One answer item; structurally equal to the official
 * `AskUserQuestionAnswerItem` (`{ id, selected, custom? }`). */
export interface QuestionAnswerItem {
  /** The pending question id being answered. */
  id: string
  /** Selected option label(s). */
  selected: string[]
  /** Optional free-text answer. */
  custom?: string
}

/** The answer payload returned to the worker; structurally equal to the
 * official `AskUserQuestionAnswer` (`{ answers: [...] }`). */
export interface QuestionAnswer {
  answers: QuestionAnswerItem[]
}

/**
 * One durable task row.
 */
export interface TaskRecord {
  /** Ledger identity. */
  readonly id: TaskId
  /** The session that initiated the task; cancel authority and final result reports belong to it. */
  readonly assignedBy: SessionId
  /** The worker that executes the task, absent until dispatched. */
  readonly assignedTo?: SessionId
  /** The session that reviews and settles the result; defaults to the initiator. */
  readonly assignedReviewer?: SessionId
  /** Canonical workspace path all parties shared at admission. */
  readonly workspacePath: string
  /** The task instruction delivered to the recipient. */
  readonly content: string
  /** Short display title (≤20 chars); list/DAG nodes prefer it over content. */
  readonly title?: string
  /** Current lifecycle position. */
  readonly status: TaskStatus
  /** Requested delivery mode. */
  readonly mode: DeliveryMode
  /** Harness message identity of the latest delivery, present once dispatched. */
  readonly messageId?: string
  /** Turn that claimed the latest delivery, present from `working` onward. */
  readonly turn?: number
  /** Worker's report (the artifact) of the latest attempt; when externalized, an inline summary. */
  readonly report?: string
  /** Reference into the report store when the full report lives on disk. */
  readonly reportRef?: string
  /** The question the worker asked, present while `input-required`. */
  readonly question?: string
  /** Structured questions the worker asked via `ask_user_question`, present
   * while the task is `input-required` awaiting the initiator's answer. */
  readonly pendingQuestions?: readonly PendingQuestion[]
  /** Latest verdict: success is terminal; failure returns the row to `submitted` for rework. */
  readonly outcome?: TaskOutcome
  /** Review feedback: on failure it is the rework instruction. */
  readonly feedback?: string
  /** Failure classification: timeout, no-response, discarded, rejected-by-dispatcher. */
  readonly reason?: string
  /** Rework count: how many times this task has been sent back to the worker. */
  readonly retries: number
  /**
   * Dispatch-time token totals per participant session (deduplicated staff),
   * taken when the task was recorded. Task-period consumption is the current
   * projection minus this snapshot; absent sessions were offline at dispatch.
   */
  readonly tokensAtStart?: Record<string, TokenBuckets>
  /**
   * DAG predecessors: task ids that must settle (outcome success) before this
   * task may be dispatched. Written at creation, editable via edit_task while
   * the task is undispatched; the ledger rejects cycles and self-references.
   */
  readonly dependencies?: readonly TaskId[]
  /** Set when the scheduler auto-dispatched this task after its dependencies cleared. */
  readonly auto?: boolean
  /** The dispatcher's minimum acceptance requirement (v1.4). */
  readonly acceptanceCriteria?: string
  /** Owning flow id (v1.4); dependencies must stay inside the same flow. */
  readonly flowId?: string
  /** Handoff documents from settled predecessors; dispatched with the task. */
  readonly handoffs?: readonly HandoffEntry[]
  /** Manual archive marker; archiving is a user action, never automatic. */
  readonly archived?: boolean
  /** ISO-8601 creation stamp. */
  readonly createdAt: string
  /** ISO-8601 stamp of the last status change. */
  readonly updatedAt: string
}

/**
 * The harness's approval outcome vocabulary (decision 6). Structurally equal
 * to the official `ApprovalOutcome` from `@deepseek-ai/dsh-user-approval` but
 * defined here so the out-of-repo plugin carries no runtime dependency on
 * that package — the bridge only ever returns these strings through the
 * `approval/request` waterfall.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The minimal shape of one `approval/request` payload the bridge consumes.
 * Structurally a subset of the official `ApprovalRequest` (agent, toolName,
 * callId, reason, signal) — defined here because the official type is not
 * resolvable from this out-of-repo plugin.
 */
export interface ApprovalRequestLike {
  /** The agent on whose behalf the question is asked. */
  readonly agent?: { readonly id: SessionId }
  /** The tool the question is about. */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /** Aborting withdraws the question. */
  readonly signal?: { readonly aborted: boolean }
}
