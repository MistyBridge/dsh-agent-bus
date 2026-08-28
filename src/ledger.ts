/**
 * The task ledger: durable storage plus the A2A-aligned lifecycle machine.
 *
 * The ledger is the authority on intent and outcome, never on execution. The
 * agent inbox owns execution, and the two drift by design: an interrupt keeps
 * unclaimed queue items but does not requeue one already claimed into the
 * interrupted turn, and disposal discards every unclaimed item. So a row in
 * `submitted` or `working` records what was asked, not a promise that it will
 * finish. Two of those drifts are observable through inbox lifecycle events;
 * the third — a claimed message whose step is rejected, which emits neither
 * `discarded` nor any execution — is why `working` needs a timeout sweep
 * rather than pure event tracking.
 *
 * Domain reads are synchronous from the authoritative in-memory state; only
 * writes queue on the domain's own write chain.
 *
 * @module dsh-agent-bus/ledger
 */

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  agentBusDomainSpec,
  type AgentBusDomainState,
  type StoredBatchRecord,
  type StoredFlowRecord,
  type StoredPeerCard,
  type StoredPendingMessage,
  type StoredTaskRecord,
} from './spec.ts'
import {
  TaskId,
  type BatchRecord,
  type DeliveryMode,
  type FlowRecord,
  type HandoffEntry,
  type PeerCard,
  type TaskOutcome,
  type TaskRecord,
  type TaskStatus,
  type TokenBuckets,
} from './types.ts'

/**
 * Lifecycle transitions. `completed` is NOT terminal: a failure verdict sends
 * the row back to `submitted` for rework, so one task id carries its whole
 * life across repeated attempts.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  // v1.4: queued is the pre-delivery phase — the scheduler transitions it to
  // submitted on dispatch; failure propagation and cancel may close it early.
  // v1.5: submitted → queued is the delivery-failure fallback (the target
  // could not be woken; the sweep retries); working → submitted is the
  // stranded-recovery fallback (the executor went idle without reporting, so
  // the heartbeat re-delivers and the task is claimed again).
  queued: ['submitted', 'failed', 'canceled'],
  submitted: ['working', 'failed', 'canceled', 'queued'],
  working: ['completed', 'input-required', 'failed', 'canceled', 'submitted'],
  'input-required': ['working', 'failed', 'canceled'],
  'auth-required': [],
  completed: ['submitted'],
  failed: [],
  canceled: [],
  rejected: [],
}

/**
 * Report whether one lifecycle transition is permitted.
 *
 * @param from - the current status.
 * @param to - the proposed status.
 * @returns `true` when the transition is part of the state machine.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/**
 * Report whether a status admits no further transition.
 *
 * @param status - the status to test.
 * @returns `true` when the status is terminal.
 */
export function isTerminal(status: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0
}

/** Statuses that occupy a slot in a recipient's queue. */
const UNFINISHED: readonly TaskStatus[] = ['submitted', 'working', 'input-required']

/** Fields a caller supplies when recording a new task. */
export interface NewTask {
  /** Ledger identity, pre-generated so the delivery message can reference it. */
  readonly id: TaskId
  readonly assignedBy: SessionId
  readonly assignedTo: SessionId
  /** Reviewer, defaults to the initiator when absent. */
  readonly assignedReviewer?: SessionId
  readonly workspacePath: string
  readonly content: string
  /** Short display title (REQUIRED); list/DAG nodes display it. */
  readonly title: string
  readonly mode: DeliveryMode
  /**
   * Harness message identity, recorded before delivery so the claimed
   * listener can find the row. Absent for a blocked DAG task: it is created
   * but not delivered until its dependencies settle.
   */
  readonly messageId?: string
  /** Rework count; starts at 0 for a fresh task. */
  readonly retries: number
  /**
   * Dispatch-time token totals per participant session (deduplicated staff).
   * Optional: an offline session or an absent projection registry simply
   * leaves its key out, and the panel shows the delta as unavailable.
   */
  readonly tokensAtStart?: Record<string, TokenBuckets>
  /**
   * DAG predecessors. When non-empty and any predecessor is unsettled, the
   * task is created as `queued` (待投递) WITHOUT delivery; the event-driven
   * scheduler dispatches it once every predecessor settles (v1.4).
   */
  readonly dependencies?: readonly TaskId[]
  /**
   * The dispatcher's minimum acceptance requirement; the reviewer settles
   * against it (v1.4).
   */
  readonly acceptanceCriteria?: string
  /**
   * Owning flow id (v1.4). When set, every dependency must belong to the
   * same flow — a flow is a self-contained DAG and cross-container
   * references are rejected at write time.
   */
  readonly flowId?: string
  /**
   * Owning lightweight batch id (report 4.2). A batch groups independent
   * deliverables created in one `create_batch` call; unlike a flow it has no
   * dependency edges, so the field only labels membership.
   */
  readonly batchId?: string
}

/** Maximum number of DAG predecessors one task may declare. */
export const MAX_DEPENDENCIES = 16

/**
 * Whether one row has settled successfully (its DAG precondition).
 *
 * @param row - the row.
 * @returns `true` when the row is settled and the verdict was success.
 */
export function isSettledSuccess(row: TaskRecord): boolean {
  return row.status === 'completed' && row.outcome === 'success'
}

/**
 * A task's unsatisfied DAG predecessors: dependencies that have not settled
 * successfully. An empty list means the task is ready to dispatch.
 *
 * @param row - the row.
 * @param all - every row (dependency lookup).
 * @returns the ids of still-unsettled dependencies, in declaration order.
 */
export function blockedByOf(row: TaskRecord, all: readonly TaskRecord[]): readonly TaskId[] {
  if (row.dependencies === undefined || row.dependencies.length === 0) return []
  const byId = new Map(all.map(item => [String(item.id), item]))
  return row.dependencies.filter(dep => !isSettledSuccess(byId.get(String(dep)) as TaskRecord))
}

/**
 * Validate a proposed dependency list against the ledger's DAG invariants.
 *
 * @param taskId - the task declaring the dependencies (self-reference check).
 * @param dependencies - the proposed predecessor list.
 * @param all - every row (existence, workspace, and cycle checks).
 * @param workspacePath - the declaring task's workspace.
 * @returns an error message, or `null` when the list is acceptable.
 */
export function validateDependencies(
  taskId: TaskId,
  dependencies: readonly TaskId[] | undefined,
  all: readonly TaskRecord[],
  workspacePath: string,
  flowId?: string,
): string | null {
  if (dependencies === undefined || dependencies.length === 0) return null
  if (dependencies.length > MAX_DEPENDENCIES) {
    return `task "${taskId}" declares ${dependencies.length} dependencies, at the ${MAX_DEPENDENCIES} limit`
  }
  const ids = new Set(dependencies.map(String))
  if (ids.has(String(taskId))) {
    return `task "${taskId}" cannot depend on itself`
  }
  if (ids.size !== dependencies.length) {
    return `task "${taskId}" declares duplicate dependencies`
  }
  const byId = new Map(all.map(item => [String(item.id), item]))
  for (const dep of ids) {
    const row = byId.get(dep)
    if (row === undefined) {
      return `task "${taskId}" depends on unknown task "${dep}"`
    }
    if (row.workspacePath !== workspacePath) {
      return `task "${taskId}" depends on "${dep}" from another workspace`
    }
    // A flow is a self-contained DAG: dependencies must live in the same
    // flow, so cross-container references are impossible by construction.
    // Add the target to the flow first (edit_task with flow_id), then depend.
    if (flowId !== undefined && row.flowId !== flowId) {
      return `task "${taskId}" belongs to flow "${flowId}" but depends on "${dep}" in ${row.flowId === undefined ? 'no flow' : `flow "${row.flowId}"`}; add it to the flow first`
    }
  }
  // Cycle check: the candidate edge set is the current table plus this
  // declaration. A cycle anywhere in the graph rejects the whole change.
  const edges = new Map<string, string[]>()
  for (const row of all) {
    const deps = row.dependencies ?? []
    if (deps.length > 0) edges.set(String(row.id), deps.map(String))
  }
  edges.set(String(taskId), [...ids])
  if (detectCycle(edges)) {
    return `task "${taskId}" would create a dependency cycle`
  }
  return null
}

/**
 * Depth-first cycle detection over a directed edge map.
 *
 * @param edges - node id → outgoing dependency ids.
 * @returns `true` when the graph contains any cycle.
 */
export function detectCycle(edges: ReadonlyMap<string, readonly string[]>): boolean {
  const state = new Map<string, 0 | 1 | 2>() // 0 = unvisited, 1 = in-stack, 2 = done
  const visit = (node: string): boolean => {
    const mark = state.get(node) ?? 0
    if (mark === 1) return true
    if (mark === 2) return false
    state.set(node, 1)
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) return true
    }
    state.set(node, 2)
    return false
  }
  for (const node of edges.keys()) {
    if (visit(node)) return true
  }
  return false
}

/** Result of a ledger mutation. */
export type LedgerResult =
  | { readonly ok: true; readonly task: TaskRecord }
  | { readonly ok: false; readonly message: string }

/** Result of a flow mutation (decision 8). */
export type FlowResult =
  | { readonly ok: true; readonly flow: FlowRecord }
  | { readonly ok: false; readonly message: string }

/** Readable duplicate-flow-name refusal, listing the workspace's existing names. */
function duplicateFlowMessage(name: string, existingNames: readonly string[]): string {
  const list = existingNames.map(existing => `『${existing}』`).join('、')
  return `该工作区已有同名流程『${name}』,现有流程:${list}`
}

/**
 * Durable task ledger over one storage domain.
 *
 * Mutations that read-then-write are serialized through one local chain. The
 * domain form offers no cross-table transaction, so ordering those pairs here
 * is what keeps concurrent mutations from overwriting each other.
 */
export class TaskLedger {
  private table!: KvTable<TaskId, StoredTaskRecord>
  private peers!: KvTable<SessionId, StoredPeerCard>
  private flows!: KvTable<string, StoredFlowRecord>
  private batches!: KvTable<string, StoredBatchRecord>
  private pendingNotes!: KvTable<string, StoredPendingMessage>
  private global!: DomainGlobal<AgentBusDomainState>
  private chain: Promise<unknown> = Promise.resolve()
  private ctx!: Context

  /**
   * Open the ledger domain and bind its teardown to the plugin lifetime.
   *
   * Applies the v1.4 shape migration before the backup snapshot: a
   * pre-release `submitted` row without a messageId is the old implicit
   * "blocked, undelivered" form and becomes the explicit `queued` state.
   *
   * @param ctx - the plugin context, which must have `storageDomain` bound.
   * @returns the opened ledger.
   */
  static async open(ctx: Context): Promise<TaskLedger> {
    const ledger = new TaskLedger()
    const domain = await ctx.storageDomain.open(agentBusDomainSpec)
    ctx.effect(() => () => domain.close(), 'agent-bus.domainClose')
    ledger.ctx = ctx
    ledger.table = domain.table('tasks')
    ledger.peers = domain.table('peers')
    ledger.flows = domain.table('flows')
    ledger.batches = domain.table('batches')
    ledger.pendingNotes = domain.table('pending_messages')
    ledger.global = domain.global
    await ledger.migrateQueued()
    await ledger.snapshotBackup()
    return ledger
  }

  /**
   * v1.4 shape migration: `submitted` without a messageId means "blocked,
   * undelivered" in the pre-v7 row format; the explicit state is `queued`.
   * Runs once at open, idempotently.
   */
  private async migrateQueued(): Promise<void> {
    for (const row of this.listAll()) {
      // v1.6: pre-title rows get a title derived from their content (display
      // continuity; the title field is required for NEW tasks only).
      if (row.title === undefined || row.title === '') {
        const migrated: StoredTaskRecord = {
          ...row,
          title: row.content.trim().slice(0, 20) || 'untitled',
          dependencies: row.dependencies !== undefined ? [...row.dependencies] : undefined,
          handoffs: row.handoffs !== undefined ? [...row.handoffs] : undefined,
          pendingQuestions: row.pendingQuestions !== undefined ? [...row.pendingQuestions] : undefined,
        }
        await this.table.put(row.id, migrated)
        continue
      }
      if (row.status !== 'submitted' || row.messageId !== undefined) continue
      const migrated: StoredTaskRecord = {
        ...row,
        status: 'queued',
        dependencies: row.dependencies !== undefined ? [...row.dependencies] : undefined,
        handoffs: row.handoffs !== undefined ? [...row.handoffs] : undefined,
        pendingQuestions: row.pendingQuestions !== undefined ? [...row.pendingQuestions] : undefined,
      }
      await this.table.put(row.id, migrated)
    }
  }

  /**
   * Emit one TaskChanged event for the client event-driven scheduler.
   *
   * Emitted AFTER the durable write completes, so an event consumer never
   * sees state the ledger has not yet recorded.
   *
   * @param taskId - the row that changed.
   * @param from - prior status, or `-` for creation.
   * @param to - new status, or a settlement marker (`settled-success`,
   *   `settled-failure`) or `edited` for a mutation that keeps the status.
   */
  private emitChange(taskId: TaskId, from: string, to: string): void {
    this.ctx.emit('agent-bus/task-changed', {
      taskId: String(taskId),
      from,
      to,
      at: new Date().toISOString(),
    })
  }

  /**
   * Write a full content snapshot to the backups dir, kept to the newest 20.
   *
   * Insurance, not runtime data: the ledger itself never deletes rows, but a
   * domain version bump recreates the medium wholesale (see v1.2 spec §2.1 —
   * that is how task e420b249 and the v5-era rows were lost). Every open
   * writes one snapshot so a later loss is at least recoverable from the last
   * boot that saw the rows. Best-effort: a failed snapshot logs and does not
   * fail boot.
   */
  private async snapshotBackup(): Promise<void> {
    // vitest sets NODE_ENV=test; unit tests open the ledger over in-memory
    // domains and must not scribble on the real backup dir (or prune real
    // snapshots).
    if (process.env.NODE_ENV === 'test') return
    const dir = dshHomePath('agent-bus', 'backups')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const rows = this.listAll()
    const snapshot = {
      at: new Date().toISOString(),
      taskIds: this.global.get().taskIds,
      tasks: rows,
      peers: Array.from(this.peers.keys(), key => ({ key, card: this.peers.get(key) })),
    }
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `ledger-${stamp}.json`), JSON.stringify(snapshot, null, 1), 'utf8')
      const files = (await readdir(dir)).filter(name => name.startsWith('ledger-')).sort()
      const stale = files.slice(0, Math.max(0, files.length - 20))
      await Promise.all(stale.map(name => unlink(join(dir, name))))
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error(`agent-bus: ledger snapshot backup failed: ${String(error)}`)
    }
  }

  /** Serialize one mutation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => undefined)
    return next
  }

  /**
   * Record a new task.
   *
   * A task with unsettled dependencies is created as `queued` (待投递) and
   * left undelivered — the event-driven scheduler dispatches it once every
   * predecessor settles. A task whose dependencies are already settled is
   * created `submitted` (the caller delivers it immediately). The row is
   * written before any delivery so a delivery failure leaves a durable trace
   * instead of a silent loss.
   *
   * @param task - the create intent.
   * @param maxPending - ceiling on unfinished rows for this recipient.
   * @returns the created row, or a refusal when the recipient's queue is full.
   */
  async record(task: NewTask, maxPending: number): Promise<LedgerResult> {
    return this.enqueue(async () => {
      // Title is a required display field (v1.6): every new task carries one.
      // Naming is uniformly capped at 20 characters (v1.7 product feedback):
      // flows and task nodes share the same concise-name ceiling.
      const title = task.title.trim()
      if (title.length === 0) {
        return { ok: false as const, message: 'task title is required (1–20 characters)' }
      }
      if (title.length > 20) {
        return {
          ok: false as const,
          message: `task title is ${title.length} characters, over the 20 limit`,
        }
      }
      const all = this.listAll()
      const violation = validateDependencies(task.id, task.dependencies, all, task.workspacePath, task.flowId)
      if (violation !== null) {
        return { ok: false as const, message: violation }
      }
      const pending = all.filter(row => row.assignedTo === task.assignedTo && UNFINISHED.includes(row.status))
      if (pending.length >= maxPending) {
        return {
          ok: false as const,
          message: `session "${task.assignedTo}" already has ${pending.length} unfinished tasks, at the ${maxPending} limit; wait for it to drain`,
        }
      }
      const now = new Date().toISOString()
      const blocked = (task.dependencies ?? []).length > 0
        ? blockedByOf({ dependencies: task.dependencies } as TaskRecord, all).length > 0
        : false
      const record: StoredTaskRecord = {
        id: task.id,
        assignedBy: task.assignedBy,
        assignedTo: task.assignedTo,
        workspacePath: task.workspacePath,
        content: task.content,
        title,
        status: blocked ? 'queued' : 'submitted',
        mode: task.mode,
        // A queued row is undelivered BY DEFINITION: it must never carry a
        // messageId, whatever the caller passed.
        ...(blocked ? {} : task.messageId !== undefined ? { messageId: task.messageId } : {}),
        retries: task.retries,
        createdAt: now,
        updatedAt: now,
        ...(task.assignedReviewer !== undefined ? { assignedReviewer: task.assignedReviewer } : {}),
        ...(task.tokensAtStart !== undefined ? { tokensAtStart: task.tokensAtStart } : {}),
        ...(task.dependencies !== undefined ? { dependencies: [...task.dependencies] } : {}),
        ...(task.acceptanceCriteria !== undefined ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
        ...(task.flowId !== undefined ? { flowId: task.flowId } : {}),
        ...(task.batchId !== undefined ? { batchId: task.batchId } : {}),
      }
      await this.table.put(record.id, record)
      const state = this.global.get()
      await this.global.set({ ...state, taskIds: [...state.taskIds, record.id] })
      this.emitChange(record.id, '-', record.status)
      return { ok: true as const, task: record }
    })
  }

  /**
   * Apply one status transition, rejecting a move the machine forbids.
   *
   * A transition INTO a terminal failure (`failed` / `canceled`) additionally
   * runs DAG failure propagation: every downstream task whose unsettled
   * dependencies are now all terminally failed is failed in turn,
   * recursively — the whole flow is driven by code, no human step.
   *
   * @param id - the row to advance.
   * @param to - the target status.
   * @param patch - fields to merge alongside the status change.
   * @returns the updated row, or a refusal naming the illegal transition.
   */
  async transition(
    id: TaskId,
    to: TaskStatus,
    patch: Partial<Omit<StoredTaskRecord, 'id' | 'status'>> = {},
  ): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const from = this.table.get(id)?.status ?? '-'
      const result = await this.applyTransitionLocked(id, to, patch)
      if (result.ok) {
        this.emitChange(id, from, to)
        if (to === 'failed' || to === 'canceled') {
          const reason = result.task.reason ?? to
          await this.propagateFailureLocked(result.task.id, `dependency-${to === 'canceled' ? 'canceled' : 'failed'}`)
          void reason
        }
      }
      return result
    })
  }

  /** Transition core, run inside the write chain (no re-enqueue). */
  private async applyTransitionLocked(
    id: TaskId,
    to: TaskStatus,
    patch: Partial<Omit<StoredTaskRecord, 'id' | 'status'>> = {},
  ): Promise<LedgerResult> {
    const current = this.table.get(id)
    if (current === undefined) {
      return { ok: false as const, message: `no such task "${id}"` }
    }
    if (!canTransition(current.status, to)) {
      return {
        ok: false as const,
        message: `task "${id}" is ${current.status}; it cannot become ${to}`,
      }
    }
    const updated: StoredTaskRecord = {
      ...current,
      ...patch,
      id: current.id,
      status: to,
      updatedAt: new Date().toISOString(),
    }
    await this.table.put(id, updated)
    return { ok: true as const, task: updated }
  }

  /**
   * DAG failure propagation: after `failedId` reached a terminal failure,
   * fail every downstream task whose unsettled dependencies are all
   * terminally failed, recursively. A downstream with any still-active
   * dependency waits for it instead.
   *
   * @param failedId - the terminal-failed task whose dependents are examined.
   * @param reason - the failure reason stamped on propagated rows
   *   (`dependency-failed` / `dependency-canceled`).
   */
  private async propagateFailureLocked(failedId: TaskId, reason: string): Promise<void> {
    for (const row of this.listAll()) {
      const deps = row.dependencies ?? []
      if (!deps.includes(failedId)) continue
      if (isSettledSuccess(row) || row.status === 'failed' || row.status === 'canceled') continue
      const blocked = blockedByOf(row, this.listAll())
      const anyActive = blocked.some(dep => {
        const target = this.table.get(dep)
        return target !== undefined && !isSettledSuccess(target)
          && target.status !== 'failed' && target.status !== 'canceled'
      })
      if (anyActive) continue
      const from = row.status
      const result = await this.applyTransitionLocked(row.id, 'failed', { reason })
      if (result.ok) {
        this.emitChange(row.id, from, 'failed')
        await this.propagateFailureLocked(row.id, reason)
      }
    }
  }

  /**
   * List the downstream tasks that became dispatchable after one task
   * settled: `queued`, dependent on `id`, and with every dependency settled.
   * The scheduler delivers each returned id exactly once (the id vanishes
   * from this list once it transitions to submitted).
   *
   * @param id - the just-settled task.
   * @returns the ready dependents, in creation order.
   */
  async pendingReleases(id: TaskId): Promise<TaskId[]> {
    return this.enqueue(async () => {
      const all = this.listAll()
      const ready: TaskId[] = []
      for (const row of all) {
        if (row.status !== 'queued') continue
        if (!(row.dependencies ?? []).includes(id)) continue
        if (blockedByOf(row, all).length > 0) continue
        ready.push(row.id)
      }
      return ready
    })
  }

  /**
   * Record the delivery identity of the latest message without changing the
   * status. Used by the input-required answer path: the answer is a new
   * delivery on a paused task, and `transition` cannot move
   * `input-required → input-required`.
   *
   * @param id - the row to update.
   * @param messageId - the harness identity of the delivered answer.
   * @param auto - set when the scheduler (not a tool call) delivered this task.
   * @returns the updated row, or a refusal.
   */
  async recordDelivery(id: TaskId, messageId: string, auto?: boolean): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      const updated: StoredTaskRecord = {
        ...current,
        messageId,
        ...(auto === true ? { auto: true } : {}),
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Edit an undispatched task's requirement text and/or DAG predecessors.
   *
   * The topology is program-driven: an agent that finds its DAG unreasonable
   * rewrites it here. Only tasks that were never delivered (`queued` — and,
   * for pre-v7 rows, `submitted` without a messageId) are editable — a
   * delivered task's changes would never reach the worker. Dependency changes
   * run the same validation as creation.
   *
   * @param id - the row to edit.
   * @param patch - `content`, `dependencies`, and/or `acceptanceCriteria`;
   *   absent fields stay put.
   * @returns the updated row, or a refusal.
   */
  async editTask(
    id: TaskId,
    patch: {
      readonly content?: string
      readonly dependencies?: readonly TaskId[]
      readonly acceptanceCriteria?: string
      readonly flowId?: string
    },
  ): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      const editable = current.status === 'queued'
        || (current.status === 'submitted' && current.messageId === undefined)
      if (!editable) {
        return {
          ok: false as const,
          message: `task "${id}" is ${current.status}${current.messageId !== undefined ? ' and already delivered' : ''}; only an undispatched task can be edited`,
        }
      }
      // Revalidate whenever the edge set OR the flow could change: a flow
      // move must carry its dependencies' membership along, so the current
      // dependency list is checked against the new flow too.
      if (patch.dependencies !== undefined || patch.flowId !== undefined) {
        const violation = validateDependencies(
          id, patch.dependencies ?? current.dependencies, this.listAll(), current.workspacePath,
          patch.flowId ?? current.flowId,
        )
        if (violation !== null) {
          return { ok: false as const, message: violation }
        }
      }
      const updated: StoredTaskRecord = {
        ...current,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.dependencies !== undefined ? { dependencies: [...patch.dependencies] } : {}),
        ...(patch.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: patch.acceptanceCriteria }
          : {}),
        ...(patch.flowId !== undefined ? { flowId: patch.flowId } : {}),
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      this.emitChange(id, 'edited', 'edited')
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Create one flow: a named DAG container for tasks.
   *
   * Decision 8: a flow name must be unique within its workspace — a duplicate
   * throws with the existing names listed, so the caller can pick another.
   * The check runs inside the write chain, so two concurrent creations cannot
   * race past it.
   *
   * @param id - flow identity (uuid).
   * @param name - display name, 1–80 characters.
   * @param description - optional note.
   * @param createdBy - the creating session.
   * @param workspacePath - the workspace the flow lives in.
   * @returns the created flow.
   */
  async createFlow(
    id: string,
    name: string,
    description: string | undefined,
    createdBy: SessionId,
    workspacePath: string,
  ): Promise<FlowRecord> {
    return this.enqueue(async () => {
      const siblings = [...this.flows.entries()]
        .map(([, flow]) => flow)
        .filter(flow => flow.workspacePath === workspacePath)
      if (siblings.some(flow => flow.name === name)) {
        throw new Error(duplicateFlowMessage(name, siblings.map(flow => flow.name)))
      }
      const record: StoredFlowRecord = {
        id,
        name,
        ...(description !== undefined && description !== ''
          ? { description }
          : {}),
        createdBy,
        workspacePath,
        createdAt: new Date().toISOString(),
      }
      await this.flows.put(id, record)
      return record
    })
  }

  /** List every flow in creation order. */
  listFlows(): FlowRecord[] {
    return [...this.flows.entries()].map(([, flow]) => flow)
  }

  /** Read one flow. */
  getFlow(id: string): FlowRecord | undefined {
    return this.flows.get(id)
  }

  /**
   * Create one lightweight batch header (report 4.2). Unlike a flow, a batch
   * carries no dependency edges and its name need not be unique within the
   * workspace — the tasks it groups are independent deliverables created by a
   * single `create_batch` call. Membership lives on the task rows
   * (`TaskRecord.batchId`), so this header is only the group's metadata.
   *
   * @param id - batch identity (uuid).
   * @param name - display name, 1–20 characters.
   * @param createdBy - the creating session.
   * @param workspacePath - the workspace the batch lives in.
   * @returns the created batch.
   */
  async createBatch(
    id: string,
    name: string,
    createdBy: SessionId,
    workspacePath: string,
  ): Promise<BatchRecord> {
    return this.enqueue(async () => {
      const record: StoredBatchRecord = {
        id,
        name,
        createdBy,
        workspacePath,
        createdAt: new Date().toISOString(),
      }
      await this.batches.put(id, record)
      return record
    })
  }

  /** Read one batch. */
  getBatch(id: string): BatchRecord | undefined {
    return this.batches.get(id)
  }

  /** List every batch in one workspace, in creation order. */
  listBatches(workspacePath: string): BatchRecord[] {
    return [...this.batches.entries()]
      .map(([, batch]) => batch)
      .filter(batch => batch.workspacePath === workspacePath)
  }

  /**
   * Rename one flow, optionally replacing its description.
   *
   * Decision 8: same-workspace uniqueness applies to renames too — renaming
   * onto an existing sibling's name is refused. `description` is replaced
   * when passed, cleared when empty, and kept when `undefined`. The duplicate
   * check runs inside the write chain like {@link createFlow}.
   *
   * @param flowId - the flow to rename.
   * @param name - the new display name, 1–80 characters.
   * @param description - replacement note; `''` clears it, `undefined` keeps it.
   * @returns the renamed flow, or a refusal.
   */
  async renameFlow(
    flowId: string,
    name: string,
    description: string | undefined,
  ): Promise<FlowResult> {
    return this.enqueue(async () => {
      const current = this.flows.get(flowId)
      if (current === undefined) {
        return { ok: false as const, message: `no such flow "${flowId}"` }
      }
      const siblings = [...this.flows.entries()]
        .map(([, flow]) => flow)
        .filter(flow => flow.id !== flowId && flow.workspacePath === current.workspacePath)
      if (siblings.some(flow => flow.name === name)) {
        return {
          ok: false as const,
          message: duplicateFlowMessage(name, siblings.map(flow => flow.name)),
        }
      }
      const updated: StoredFlowRecord = {
        ...current,
        name,
        ...(description !== undefined
          ? { description: description === '' ? undefined : description }
          : {}),
      }
      await this.flows.put(flowId, updated)
      return { ok: true as const, flow: updated }
    })
  }

  /**
   * Mark one flow archived or active (manual, never automatic). The flow's
   * archive status is independent of its tasks; only a user action toggles it.
   *
   * @param flowId - the flow to toggle.
   * @param archived - `true` moves it to the archived listing, `false` restores it.
   * @returns the updated flow, or a refusal.
   */
  async archiveFlow(flowId: string, archived: boolean): Promise<FlowResult> {
    return this.enqueue(async () => {
      const current = this.flows.get(flowId)
      if (current === undefined) {
        return { ok: false as const, message: `no such flow "${flowId}"` }
      }
      const updated: StoredFlowRecord = {
        ...current,
        archived,
      }
      await this.flows.put(flowId, updated)
      return { ok: true as const, flow: updated }
    })
  }

  /**
   * Queue one undelivered note (v1.5): the recipient was offline, so the
   * message is held durably and the delivery sweep retries it once the
   * recipient is live.
   *
   * @param message - the pending note record.
   */
  async queueNote(message: StoredPendingMessage): Promise<void> {
    await this.enqueue(async () => {
      await this.pendingNotes.put(message.id, message)
    })
  }

  /** All queued undelivered notes, oldest first. */
  listPendingNotes(): StoredPendingMessage[] {
    return [...this.pendingNotes.entries()]
      .map(([, note]) => note)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /**
   * Remove one delivered (or dropped) note.
   *
   * @param id - the note id.
   */
  async deleteNote(id: string): Promise<void> {
    await this.enqueue(async () => {
      await this.pendingNotes.delete(id)
    })
  }

  /**
   * Bump one note's delivery attempt count (the sweep retries it).
   *
   * @param id - the note id.
   * @param attempts - the new attempt count.
   */
  async markNoteAttempt(id: string, attempts: number): Promise<void> {
    await this.enqueue(async () => {
      const note = this.pendingNotes.get(id)
      if (note === undefined) return
      await this.pendingNotes.put(id, { ...note, attempts })
    })
  }

  /**
   * Attach one handoff document to a downstream task: a settled
   * predecessor's executor delivers structured context that dispatch
   * concatenates into the downstream's delivered content.
   *
   * @param id - the DOWNSTREAM task receiving the document.
   * @param handoff - the predecessor id, document text, and stamp.
   * @returns the updated row, or a refusal.
   */
  /**
   * Reassign an unsettled task (v1.5): move the executor and/or the reviewer
   * without recreating the task. The task id, history, dependencies, flow
   * membership, and acceptance criteria all stay — the DAG topology never
   * changes, only who works and who reviews.
   *
   * An executor change clears the delivery identity: the caller re-delivers
   * to the new worker (the old worker's report is then rejected by the
   * state machine, since it is no longer assignedTo).
   *
   * @param id - the row to reassign.
   * @param patch - `executor` and/or `reviewer`; absent fields stay put.
   * @returns the updated row, or a refusal.
   */
  async reassign(
    id: TaskId,
    patch: { readonly executor?: SessionId; readonly reviewer?: SessionId },
  ): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      if (current.status === 'completed'
        || current.status === 'failed' || current.status === 'canceled' || current.status === 'rejected') {
        return {
          ok: false as const,
          message: `task "${id}" is ${current.status}; only an unsettled task can be reassigned`,
        }
      }
      const updated: StoredTaskRecord = {
        ...current,
        ...(patch.executor !== undefined ? { assignedTo: patch.executor } : {}),
        ...(patch.reviewer !== undefined ? { assignedReviewer: patch.reviewer } : {}),
        // The executor changed: the old delivery is void. The caller
        // re-delivers to the new worker (queued stays queued — no delivery
        // until the scheduler fires).
        ...(patch.executor !== undefined
          ? { messageId: undefined, tokensAtStart: undefined, turn: undefined }
          : {}),
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      this.emitChange(id, 'reassigned', 'reassigned')
      return { ok: true as const, task: updated }
    })
  }

  async appendHandoff(id: TaskId, handoff: HandoffEntry): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      const updated: StoredTaskRecord = {
        ...current,
        handoffs: [...(current.handoffs ?? []), handoff],
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      return { ok: true as const, task: updated }
    })
  }

  /** Handoff documents attached to one task, in arrival order. */
  handoffsFor(id: TaskId): readonly HandoffEntry[] {
    return this.table.get(id)?.handoffs ?? []
  }

  /**
   * Attach a report to a row without changing its status.
   *
   * Used twice: the normal report on the way to `completed` goes through
   * {@link transition} instead; this path serves the cancel-summary, which a
   * worker attaches to a `canceled` task whose state must not move.
   *
   * @param id - the row to attach to.
   * @param report - the report text.
   * @returns the updated row, or a refusal.
   */
  async attachReport(id: TaskId, report: string): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      const updated: StoredTaskRecord = {
        ...current,
        report,
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Settle a completed task with the reviewer's verdict.
   *
   * Success records the verdict on the row and leaves it `completed` —
   * terminal. Failure sends the row BACK to `submitted` for rework on the
   * SAME task id: the feedback becomes the rework instruction, `retries`
   * increments, and the previous attempt's report and turn are cleared so the
   * next claim starts fresh. One task id carries its whole life across
   * attempts; there is no new-task redo chain.
   *
   * @param id - the completed row to settle.
   * @param outcome - the verdict.
   * @param feedback - reviewer note; on failure this is the rework instruction.
   * @returns the updated row, or a refusal.
   */
  async settle(
    id: TaskId,
    outcome: TaskOutcome,
    feedback: string | undefined,
  ): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      if (current.status !== 'completed') {
        return {
          ok: false as const,
          message: `task "${id}" is ${current.status}; only a completed task can be settled`,
        }
      }
      if (outcome === 'success') {
        const updated: StoredTaskRecord = {
          ...current,
          outcome,
          updatedAt: new Date().toISOString(),
          ...(feedback !== undefined ? { feedback } : {}),
        }
        await this.table.put(id, updated)
        this.emitChange(id, 'completed', 'settled-success')
        return { ok: true as const, task: updated }
      }
      const updated: StoredTaskRecord = {
        ...current,
        status: 'submitted',
        outcome,
        updatedAt: new Date().toISOString(),
        retries: current.retries + 1,
        report: undefined,
        turn: undefined,
        ...(feedback !== undefined ? { feedback } : {}),
      }
      await this.table.put(id, updated)
      this.emitChange(id, 'completed', 'settled-failure')
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Mark one task archived or active (manual, never automatic). Archiving is
   * a visibility choice, orthogonal to the lifecycle machine: a queued or
   * working task may be archived, and the change is reversible.
   *
   * @param id - the row to toggle.
   * @param archived - `true` hides it from the active set, `false` restores it.
   * @returns the updated row, or a refusal.
   */
  async archiveTask(id: TaskId, archived: boolean): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      const updated: StoredTaskRecord = {
        ...current,
        archived,
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      this.emitChange(id, current.status, archived ? 'archived' : 'unarchived')
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Read one row.
   *
   * @param id - the row to read.
   * @returns the row, or `undefined` when unknown.
   */
  get(id: TaskId): TaskRecord | undefined {
    return this.table.get(id)
  }

  /**
   * List rows addressed to one session, in creation order.
   *
   * @param sessionId - the recipient to filter by.
   * @returns matching rows.
   */
  listFor(sessionId: SessionId): TaskRecord[] {
    return this.listAll().filter(row => row.assignedTo === sessionId)
  }

  /**
   * List rows dispatched by one session, in creation order.
   *
   * @param sessionId - the dispatcher to filter by.
   * @returns matching rows.
   */
  listBy(sessionId: SessionId): TaskRecord[] {
    return this.listAll().filter(row => row.assignedBy === sessionId)
  }

  /**
   * The newest `working` row assigned to one session — the single task a
   * worker is executing (workers run one delivered task at a time).
   *
   * The question bridge uses this to judge whether an `ask_user_question`
   * call is A2A (forward to the task initiator) or a direct human-agent
   * conversation (leave to the original chain).
   *
   * @param sessionId - the calling session.
   * @returns the latest working row, or `undefined` when none.
   */
  findWorkingFor(sessionId: SessionId): TaskRecord | undefined {
    let newest: TaskRecord | undefined
    for (const row of this.listAll()) {
      if (row.assignedTo !== sessionId || row.status !== 'working') continue
      if (newest === undefined || Date.parse(row.updatedAt) > Date.parse(newest.updatedAt)) newest = row
    }
    return newest
  }

  /**
   * List every row in creation order.
   *
   * Order comes from the global `taskIds` account rather than table iteration,
   * which the domain form does not promise to order.
   *
   * @returns every row the ledger holds.
   */
  listAll(): TaskRecord[] {
    const rows: TaskRecord[] = []
    for (const id of this.global.get().taskIds) {
      const row = this.table.get(id)
      if (row !== undefined) rows.push(row)
    }
    return rows
  }

  /**
   * Find the row a delivered message belongs to.
   *
   * Used by inbox lifecycle listeners, which know the `MessageId` but not the
   * ledger id.
   *
   * @param messageId - the harness message identity.
   * @returns the owning row, or `undefined` when the message is not ours.
   */
  findByMessage(messageId: string): TaskRecord | undefined {
    return this.listAll().find(row => row.messageId === messageId)
  }

  /**
   * Write one peer's card, replacing the previous one wholesale.
   *
   * @param sessionId - the card owner.
   * @param card - the validated card content.
   */
  async putCard(sessionId: SessionId, card: PeerCard): Promise<void> {
    await this.enqueue(async () => {
      await this.peers.put(sessionId, {
        description: card.description,
        capabilities: card.capabilities.map(cap => ({ id: cap.id, label: cap.label })),
        updatedAt: card.updatedAt,
      })
    })
  }

  /**
   * Read one peer's card.
   *
   * @param sessionId - the card owner.
   * @returns the card, or `undefined` when the peer never wrote one.
   */
  getCard(sessionId: SessionId): PeerCard | undefined {
    return this.peers.get(sessionId)
  }
}
