/**
 * Runtime event hooks for `agent-bus:runtime`: the ledger lifecycle hooks and
 * the turn-end reminder, moved verbatim out of the composition root.
 *
 * @module dsh-agent-bus/runtime/hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { notifySession } from '../delivery.ts'
import { releaseDependents } from '../scheduler.ts'
import type { TaskLedger } from '../ledger/ledger.ts'
import { TaskId } from '../domain/types.ts'

/** The hooks' host: the ledger and the shared executor-activity signal. */
export interface HooksHost {
  readonly ledger: TaskLedger
  readonly noteActivity: (sessionId: SessionId) => void
}

/**
 * Register the lifecycle hooks. Ledger state follows the real inbox lifecycle:
 * a claimed delivery starts (or resumes) the task, a discarded one fails it.
 * The turn-end reminder covers the "worked in prose but never reported" case,
 * and a settled task releases its DAG dependents.
 *
 * The events are scope-filtered per agent; a listener on the host context
 * admits them from every agent.
 *
 * @param ctx - plugin context (host scope).
 * @param host - the ledger and the executor-activity signal.
 */
export function registerRuntimeHooks(ctx: Context, host: HooksHost): void {
  const { ledger, noteActivity } = host

  ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    const task = ledger.findByMessage(message.id)
    if (task === undefined) return
    // A claimed delivery is executor activity (decision 2): the worker is
    // demonstrably on the task, so the heartbeat must not re-deliver it.
    if (task.assignedTo !== undefined) noteActivity(task.assignedTo)
    // A claimed task starts working; a claimed answer resumes a paused task.
    if (task.status === 'submitted' || task.status === 'input-required') {
      void ledger.transition(task.id, 'working', { turn })
    }
  })
  ctx.on('agent/inbox/discarded', ({ message }) => {
    const task = ledger.findByMessage(message.id)
    if (task === undefined) return
    if (task.status === 'submitted' || task.status === 'working') {
      void ledger.transition(task.id, 'failed', { reason: 'discarded' })
    }
  })

  // Turn-end reminder: an executor that finishes a turn without reporting
  // leaves its task in working forever (the PM-receives-a-misdirected-task
  // case: the worker answered in prose but never called report_task). After
  // every turn/end of a session holding a working task, remind once with a
  // cooldown so the loop cannot stall silently — and so multi-turn work is
  // not nagged to death.
  const lastReminder = new Map<string, number>()
  const REMINDER_COOLDOWN_MS = 15 * 60 * 1000
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const now = Date.now()
    // Any completed turn is executor activity (decision 2): multi-turn work
    // must not be re-delivered by the heartbeat just because the row sat in
    // working between turns.
    noteActivity(session.id)
    for (const task of ledger.listFor(session.id)) {
      if (task.status !== 'working') continue
      const key = String(task.id)
      const last = lastReminder.get(key) ?? 0
      // Cooldown rides the TASK's own state, not process memory: a task that
      // changed recently (the worker is clearly active on it) is never
      // nagged, and a restart cannot cause an instant re-reminder of work
      // the worker already reported — reported tasks are no longer working.
      if (now - Date.parse(task.updatedAt) < REMINDER_COOLDOWN_MS) continue
      if (now - last < REMINDER_COOLDOWN_MS) continue
      lastReminder.set(key, now)
      notifySession(ctx, session.id, task.id,
        `任务 ${task.id} 当前状态「进行中」,本轮次已结束。若已完成,请调用 report_task 提交结果(进入「待验收」);若仍需继续处理,可忽略本提醒;若该任务并不适合由你执行,请调用 report_task 简述情况,由派发方验收或取消,避免任务长期滞留。`,
        'reminder')
      break
    }
  })

  // DAG auto-scheduling: settle success releases every dependent whose
  // blockers cleared; a startup sweep restores pending releases after a
  // restart; a periodic backstop covers anything the event path missed
  // (delivery failure, edge races). All idempotent — an undelivered row is
  // the only one ever dispatched.
  ctx.on('agent-bus/settle', (taskId: string) => {
    void releaseDependents(ctx, ledger, TaskId(taskId))
  })
}
