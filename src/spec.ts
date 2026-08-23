/**
 * The agent-bus task ledger domain: record schemas and the `defineDomain` spec
 * the gateway opens. The zod schema is the durable-boundary validator.
 *
 * Durable state lives here rather than in the session log on purpose. An
 * out-of-repo plugin cannot enter `KNOWN_SESSION_EVENT_TYPES` (the generator
 * globs the harness repo only), so a custom session event would make every
 * later read of that log refuse unless marked `ignorable` — and `ignorable`
 * means the record may not affect reconstruction. Task state must survive
 * replay, so a storage domain is the only correct home.
 *
 * @module dsh-agent-bus/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { TaskId } from './types.ts'

/** Task id schema at the durable boundary; branding has no runtime representation. */
const taskId = z.string().transform(value => value as TaskId)

/** Session id schema at the durable boundary. */
const sessionId = z.string().transform(SessionId)

/**
 * Four-bucket token usage at the durable boundary, mirroring the token-meter
 * projection shape. Non-negative integers; strict so an unexpected bucket
 * fails load rather than parsing silently.
 */
export const tokenBuckets = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

/** Capability id: kebab-case machine key, matched by programs and future routing. */
const capabilityId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)

/** One advertised capability: machine key plus a short readable label. */
export const capability = z.object({
  id: capabilityId,
  label: z.string().min(1).max(50),
})

/** One structured question option at the durable boundary. */
export const pendingQuestionOption = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
}).strict()

/** One structured question at the durable boundary (decision 9): serialized
 * from the official `ask_user_question` tool's questions argument while the
 * task awaits the initiator's answer. */
export const pendingQuestion = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(pendingQuestionOption),
  multiSelect: z.boolean(),
}).strict()

/**
 * Durable shape of one task row. Optional fields are absent until the
 * lifecycle reaches the state that produces them.
 */
export const taskRecord = z.object({
  id: taskId,
  assignedBy: sessionId,
  assignedTo: sessionId.optional(),
  assignedReviewer: sessionId.optional(),
  workspacePath: z.string(),
  content: z.string(),
  /** Short display title (v1.6); list/DAG nodes prefer it over content. */
  title: z.string().max(80).optional(),
  status: z.enum([
    'queued',
    'submitted',
    'working',
    'input-required',
    'auth-required',
    'completed',
    'failed',
    'canceled',
    'rejected',
  ]),
  mode: z.enum(['followup', 'steer']),
  messageId: z.string().optional(),
  turn: z.number().int().nonnegative().optional(),
  report: z.string().optional(),
  reportRef: z.string().optional(),
  question: z.string().optional(),
  pendingQuestions: z.array(pendingQuestion).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  feedback: z.string().optional(),
  reason: z.string().optional(),
  retries: z.number().int().nonnegative(),
  tokensAtStart: z.record(sessionId, tokenBuckets).optional(),
  dependencies: z.array(taskId).max(16).optional(),
  auto: z.boolean().optional(),
  /** Dispatcher's minimum acceptance requirement, the reviewer's settle basis. */
  acceptanceCriteria: z.string().max(2000).optional(),
  /** Owning flow id (v1.4): dependencies must stay inside the same flow. */
  flowId: z.string().optional(),
  /** Handoff documents from settled predecessors (v1.4): dispatched with the task. */
  handoffs: z.array(z.object({
    fromTask: taskId,
    document: z.string(),
    at: z.string(),
  })).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored task row, inferred from {@link taskRecord}. */
export type StoredTaskRecord = z.infer<typeof taskRecord>

/**
 * Durable shape of one peer's self-maintained card. The description serves
 * model readers; capabilities serve programs, so their ids are
 * format-validated at the durable boundary.
 */
export const peerCard = z.object({
  description: z.string().max(200),
  capabilities: z.array(capability).max(8),
  updatedAt: z.string(),
})

/** One stored peer card, inferred from {@link peerCard}. */
export type StoredPeerCard = z.infer<typeof peerCard>

/**
 * Durable shape of one flow: a named DAG container for tasks (v1.4). A flow
 * has no status of its own — active/archived is derived from its tasks.
 */
export const flowRecord = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  createdBy: sessionId,
  workspacePath: z.string(),
  createdAt: z.string(),
})

/** One stored flow, inferred from {@link flowRecord}. */
export type StoredFlowRecord = z.infer<typeof flowRecord>

/**
 * Durable shape of one pending note: a send_note that could not be
 * delivered because the recipient was offline (v1.5). The delivery sweep
 * retries it once the recipient is live; no acceptance, no receipt.
 */
export const pendingMessageRecord = z.object({
  id: z.string(),
  sender: sessionId,
  recipient: sessionId,
  content: z.string(),
  /** Original send time (kept across retries for the delayed marker). */
  sentAt: z.string(),
  createdAt: z.string(),
  /** Delivery attempts so far; > 3 drops the message and notifies the sender. */
  attempts: z.number().int().nonnegative().default(0),
})

/** One stored pending note, inferred from {@link pendingMessageRecord}. */
export type StoredPendingMessage = z.infer<typeof pendingMessageRecord>

/**
 * Durable ledger state. `taskIds` is the authoritative creation order, which
 * the listing tools page over without scanning the table. Defaulted so a
 * record written before the field parses unchanged.
 */
export const agentBusDomainState = z.object({
  taskIds: z.array(taskId).default([]),
})

/** Durable ledger state inferred from {@link agentBusDomainState}. */
export type AgentBusDomainState = z.infer<typeof agentBusDomainState>

/**
 * The agent-bus domain spec: a `tasks` table keyed by task id, a `peers`
 * table keyed by session id, a `flows` table keyed by flow id, a
 * `pending_messages` table keyed by note id, plus the order singleton.
 * Version 8 adds the flows container (`flows` table, `tasks.flowId`),
 * version 9 adds `tasks.handoffs`, version 10 adds `pending_messages`
 * (durable offline send_note delivery). The version bump invalidates the
 * storage unit — keep a backup of `agent_bus.json` first (v1.3 §6), then
 * bump the version stamp once after upgrading; the ledger migrates
 * pre-release `submitted` rows without a messageId to `queued` at open.
 */
export const agentBusDomainSpec = defineDomain({
  name: 'agent_bus',
  version: 10,
  global: {
    schema: agentBusDomainState,
    initial: { taskIds: [] },
  },
  tables: {
    tasks: domainTable<TaskId, StoredTaskRecord>(taskRecord),
    peers: domainTable<SessionId, StoredPeerCard>(peerCard),
    flows: domainTable<string, StoredFlowRecord>(flowRecord),
    pending_messages: domainTable<string, StoredPendingMessage>(pendingMessageRecord),
  },
})
