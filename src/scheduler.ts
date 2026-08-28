/**
 * DAG auto-dispatch: the code that turns a settled dependency into a
 * delivered task.
 *
 * The scheduler is deliberately dumb — it reads ledger state and delivers
 * exactly the tasks that are ready, through the same message path a tool
 * call uses. Idempotency comes from the state itself: a task whose row has a
 * messageId is already delivered, so a restart sweep or a second release
 * trigger can never double-dispatch.
 *
 * @module dsh-agent-bus/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { buildTaskMessage, deliverTask, notifySession } from './delivery.ts'
import { blockedByOf, type TaskLedger } from './ledger/ledger.ts'
import type { TaskId, TaskRecord } from './domain/types.ts'
import { wakeSession } from './members/wake.ts'

/**
 * Whether the stranded-recovery heartbeat may re-deliver one task.
 *
 * The heartbeat re-delivers a working/submitted task whose LIVE executor sits
 * idle past the retry window — but only when the executor has NOT been active
 * recently. Activity (a turn ending, a claim, a report) means the worker is on
 * the task, so re-delivering would only pile up another delivery and refresh
 * the row's `updatedAt`, re-arming the very window that kicked it (the T5
 * loop). The cooldown is bound to the EXECUTOR's activity, never to the row's
 * own timestamp.
 *
 * @param row - the task row under heartbeat consideration.
 * @param executor - the live executor, or `undefined` when offline.
 * @param now - current epoch milliseconds.
 * @param retryIdleMs - how stale the row must be before a re-delivery is due.
 * @param lastActivityAt - the executor's last recorded activity, if any.
 * @param cooldownMs - how recent activity must be to suppress the heartbeat.
 * @returns `true` when the heartbeat may re-deliver this task.
 */
export function shouldHeartbeatRedeliver(
  row: TaskRecord,
  executor: { status: string } | undefined,
  now: number,
  retryIdleMs: number,
  lastActivityAt: number | undefined,
  cooldownMs: number,
): boolean {
  if (executor === undefined || executor.status !== 'idle') return false
  if (now - Date.parse(row.updatedAt) < retryIdleMs) return false
  if (lastActivityAt !== undefined && now - lastActivityAt < cooldownMs) return false
  return true
}

/**
 * Result of one {@link dispatchOne} attempt. `dispatched: true` means the task
 * moved queued → submitted and was delivered; `dispatched: false` carries why
 * it did not (`dag-paused` suppresses delivery until the switch returns to
 * `running`).
 */
export type DispatchOutcome =
  | { readonly dispatched: true; readonly taskId: TaskId; readonly status: 'submitted' }
  | { readonly dispatched: false; readonly reason: 'not-queued' | 'no-worker' | 'dag-paused' | 'raced' }

/**
 * Deliver one queued task: transition it to submitted, record the delivery
 * with the auto flag, and hand it to the harness inbox. Idempotent by
 * construction — a task that is not queued (already delivered, running, or
 * terminal) is skipped, so the client's event-driven POST /dispatch and the
 * server backstop sweep can race without double-delivery.
 *
 * Exported so the edit_task tool can dispatch a task whose dependencies just
 * cleared.
 *
 * @param ctx - plugin context (notifications).
 * @param ledger - the task ledger.
 * @param id - the ready task's id.
 * @returns the dispatch outcome; `dag-paused` short-circuits before any wake
 *   or message construction, so a paused switch has zero side effects.
 */
export async function dispatchOne(ctx: Context, ledger: TaskLedger, id: TaskId): Promise<DispatchOutcome> {
  // DAG switch: paused suppresses every NEW delivery. Short-circuit before the
  // worker wake / message build so a paused state has no side effects.
  if (ledger.dagState() === 'paused') return { dispatched: false, reason: 'dag-paused' }
  const task = ledger.get(id)
  if (task === undefined || task.assignedTo === undefined) return { dispatched: false, reason: 'not-queued' }
  if (task.status !== 'queued') return { dispatched: false, reason: 'not-queued' } // idempotent: nothing to deliver
  // Wake-on-delivery (v1.5): a dormant worker is resumed instead of leaving
  // the row queued; only an unwakeable session keeps the row queued for the
  // next sweep.
  const worker = await wakeSession(ctx, task.assignedTo)
  if (worker === undefined) return { dispatched: false, reason: 'no-worker' } // unwakeable worker: the row stays queued and the sweep retries
  // Handoff documents from settled predecessors ride along: structured
  // context (values, decisions, caveats) concatenated after the instruction,
  // so the worker reads the chain's state instead of excavating old reports.
  const handoffs = ledger.handoffsFor(task.id)
  const body = handoffs.length > 0
    ? `${task.content}\n\n【前置任务交接文档】\n${handoffs.map(handoff =>
      `来自 ${String(handoff.fromTask)}:\n${handoff.document}`).join('\n\n')}`
    : task.content
  const message = buildTaskMessage(task.assignedBy, task.id, body, 'scheduler')
  const advanced = await ledger.transition(id, 'submitted')
  if (!advanced.ok) return { dispatched: false, reason: 'raced' } // raced: another dispatcher already moved it
  await ledger.recordDelivery(task.id, message.id, true)
  deliverTask(worker, message, task.mode)
  notifySession(
    ctx,
    task.assignedBy,
    task.id,
    `任务 ${task.id} 的前置依赖已全部结算,已自动派发,状态「待执行」,等待执行方认领。`,
    'scheduler',
  )
  return { dispatched: true, taskId: id, status: 'submitted' }
}

/**
 * Release the dependents of one just-settled task. Every dependent that is
 * submitted, undelivered, and no longer blocked is dispatched.
 *
 * @param ctx - plugin context.
 * @param ledger - the task ledger.
 * @param taskId - the task that just settled.
 * @returns how many tasks were actually dispatched (a `dag-paused` dependent
 *   is NOT counted as released — it stays queued and is picked up on resume).
 */
export async function releaseDependents(
  ctx: Context,
  ledger: TaskLedger,
  taskId: TaskId,
): Promise<number> {
  const ready = await ledger.pendingReleases(taskId)
  let dispatched = 0
  for (const id of ready) {
    const outcome = await dispatchOne(ctx, ledger, id)
    if (outcome.dispatched) dispatched += 1
  }
  return dispatched
}

/**
 * Sweep every ready-but-undelivered task. Used at startup (restore
 * auto-scheduling after a restart) and as a periodic backstop; idempotent by
 * construction.
 *
 * @param ctx - plugin context.
 * @param ledger - the task ledger.
 * @returns how many tasks were actually dispatched (zero while the DAG switch
 *   is paused).
 */
export async function dispatchReadyTasks(ctx: Context, ledger: TaskLedger): Promise<number> {
  const all = ledger.listAll()
  const ready = all.filter(task =>
    task.status === 'queued'
    && blockedByOf(task, all).length === 0)
  let dispatched = 0
  for (const task of ready) {
    const outcome = await dispatchOne(ctx, ledger, task.id)
    if (outcome.dispatched) dispatched += 1
  }
  return dispatched
}

/**
 * Startup recovery (decision 10 B): re-wake the executors of tasks that a
 * process restart left stranded, so a crash needs no human to pull workers
 * back online.
 *
 * A restart drops every agent back to dormant. Tasks in `working`,
 * `submitted`, or `input-required` have a live-context promise behind them
 * (a claimed message, a paused question) — their executor must be woken and
 * reminded to continue, exactly as the PM would by hand. Waking restores the
 * full tool set through {@link wakeSession} (which now carries the session's
 * recorded preset setup), so the worker resumes with its file/shell tools
 * intact.
 *
 * Idempotent: a task whose executor is already live is skipped (it is
 * genuinely working, not stranded), and the reminder is delivered once per
 * wake. Dormant executors that cannot be woken stay as-is; the existing
 * offline-grace / timeout sweeps remain the backstop.
 *
 * @param ctx - plugin context.
 * @param ledger - the task ledger.
 * @returns how many workers were woken.
 */
export async function resumeStrandedTasks(ctx: Context, ledger: TaskLedger): Promise<number> {
  const stranded = ledger.listAll().filter(task =>
    task.assignedTo !== undefined
    && (task.status === 'working' || task.status === 'submitted' || task.status === 'input-required'))
  const woken = new Set<string>()
  for (const task of stranded) {
    const executor = task.assignedTo
    if (executor === undefined) continue
    if (ctx.agents.get(executor) !== undefined) continue // live executor: not stranded
    const worker = await wakeSession(ctx, executor)
    if (worker === undefined) continue // unwakeable: offline grace / timeout will decide
    if (woken.has(String(executor))) continue // one reminder per worker
    woken.add(String(executor))
    const message = buildTaskMessage(
      task.assignedBy,
      task.id,
      `[系统恢复通知] dsh 服务曾重启,你的会话已自动恢复。你正在执行的任务 ${task.id} 仍处于「${task.status}」,`
        + `请继续完成并调用 report_task 提交结果;若中断位置已丢失,可重新读取任务要求继续。`,
      'scheduler',
    )
    deliverTask(worker, message, 'followup')
  }
  return woken.size
}
