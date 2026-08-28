/**
 * Runtime sweeps for `agent-bus:runtime`: the startup dispatch/resume and the
 * periodic backstop sweeps, moved verbatim out of the composition root.
 *
 * @module dsh-agent-bus/runtime/sweeps
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildDelayedMessage, buildTaskMessage, deliverTask, notifySession } from '../delivery.ts'
import { dispatchReadyTasks, resumeStrandedTasks, shouldHeartbeatRedeliver } from '../scheduler.ts'
import type { TaskLedger } from '../ledger/ledger.ts'
import type { ReportStore } from '../external.ts'
import { TaskId } from '../domain/types.ts'

/** The sweeps' host: ledger, reports, the activity signal, the mutable boot
 * record, and the timeout tunables. */
export interface SweepsHost {
  readonly ledger: TaskLedger
  readonly reports: ReportStore
  readonly activityAt: (sessionId: SessionId) => number | undefined
  readonly boot: { readonly recoveryInfo: { recoveredWorkers: number; recoveryAt: number | null } }
  readonly config: {
    readonly taskTimeoutMs: number
    readonly offlineGraceMs: number
    readonly retryIdleMs: number
    readonly heartbeatCooldownMs: number
  }
}

/**
 * Start the startup dispatch/recovery and register every periodic sweep. Each
 * `setInterval` is unref'd and its disposer registered via `ctx.effect` so
 * unloading the plugin clears it.
 *
 * @param ctx - plugin context (host scope).
 * @param host - ledger, reports, activity signal, mutable boot record, tunables.
 */
export function registerSweeps(ctx: Context, host: SweepsHost): void {
  const { ledger, reports } = host

  // DAG auto-scheduling startup: dispatch any task whose blockers cleared
  // while this process was down (idempotent — an undelivered row is the only
  // one ever dispatched).
  void dispatchReadyTasks(ctx, ledger)
  // Decision 10 B: after a restart, re-wake the executors of tasks a crash
  // left stranded (working / submitted / input-required with a dormant
  // executor) — no human needs to pull workers back online by hand. The
  // recovered count feeds the panel hint (decision 10 C).
  void resumeStrandedTasks(ctx, ledger).then(count => {
    if (count > 0) {
      host.boot.recoveryInfo.recoveredWorkers = count
      host.boot.recoveryInfo.recoveryAt = Date.now()
      ctx.logger.info(`agent-bus: 已自动恢复 ${count} 个滞留任务的执行会话`)
    }
  })
  const dagSweep = setInterval(() => {
    void dispatchReadyTasks(ctx, ledger)
  }, 60_000)
  dagSweep.unref?.()
  ctx.effect(() => () => clearInterval(dagSweep), 'agent-bus.dagSweep')

  // Timeout sweep: a working row whose claimed step was rejected neither
  // reports nor discards, so only time can close it. An unanswered
  // input-required row is the same shape on the dispatcher's side. A timed
  // out task is terminal: its report moves hot -> cold and the INITIATOR is
  // notified — a timeout means a side of the loop went quiet, and the
  // initiator is the one who can decide to redo it.
  const { taskTimeoutMs: timeoutMs, offlineGraceMs, retryIdleMs, heartbeatCooldownMs } = host.config
  const lastOfflineNotice = new Map<string, number>()
  const lastHeartbeat = new Map<string, number>()
  const timer = setInterval(() => {
    const cutoff = Date.now() - timeoutMs
    const now = Date.now()
    for (const row of ledger.listAll()) {
      if (row.status !== 'working' && row.status !== 'input-required'
        && row.status !== 'submitted') continue
      // Stranded-recovery heartbeat (v1.6): a working or submitted task
      // whose LIVE executor sits IDLE past the window lost its turn (the
      // model stopped early, the step was rejected, the process restarted)
      // — re-deliver so the driver claims it afresh. This is teams'
      // owned-open-task retry expressed in our delivery model; the 2h
      // timeout stays the backstop. Decision 2: an executor that was active
      // within the cooldown is ON the task, so no re-delivery — the old
      // "re-deliver refreshes updatedAt → kicks again" loop is closed by
      // binding the cooldown to the EXECUTOR's activity, not the row's.
      if (row.status === 'working' || row.status === 'submitted') {
        const executor = row.assignedTo !== undefined ? ctx.agents.get(row.assignedTo) : undefined
        const lastActive = row.assignedTo !== undefined
          ? host.activityAt(row.assignedTo)
          : undefined
        if (shouldHeartbeatRedeliver(row, executor, now, retryIdleMs, lastActive, heartbeatCooldownMs)) {
          const key = String(row.id)
          const last = lastHeartbeat.get(key) ?? 0
          if (now - last >= retryIdleMs) {
            lastHeartbeat.set(key, now)
            void (async () => {
              const fresh = ledger.get(row.id)
              if (fresh === undefined) return
              const worker = ctx.agents.get(fresh.assignedTo!)
              if (worker === undefined || worker.status !== 'idle') return
              const advanced = fresh.status === 'working'
                ? await ledger.transition(fresh.id, 'submitted')
                : { ok: true as const }
              if (!advanced.ok) return
              const message = buildTaskMessage(fresh.assignedBy, fresh.id,
                `${fresh.content}\n\n[检测到任务中断,已重新投递,请继续执行并调用 report_task。]`,
                'retry')
              await ledger.recordDelivery(fresh.id, message.id)
              deliverTask(worker, message, 'steer')
            })()
          }
        }
      }
      if (row.status === 'input-required') continue
      // Offline-executor grace (v1.5): a working task whose executor has been
      // away past the grace period asks the INITIATOR to decide — reassign,
      // cancel, or wait. Never auto-fails: offline is not failure, the 2h
      // timeout stays as the backstop. Cooldown rides the task state so a
      // restart cannot re-nag.
      if (row.status === 'working' && row.assignedTo !== undefined
        && ctx.agents.get(row.assignedTo) === undefined) {
        const idleMs = now - Date.parse(row.updatedAt)
        if (idleMs >= offlineGraceMs) {
          const key = String(row.id)
          const last = lastOfflineNotice.get(key) ?? 0
          if (now - last >= 15 * 60 * 1000) {
            lastOfflineNotice.set(key, now)
            notifySession(ctx, row.assignedBy, row.id,
              `任务 ${row.id} 的执行方(${row.assignedTo.slice(0, 8)})已离线超过 ${Math.round(offlineGraceMs / 60_000)} 分钟。`
                + `请决策:reassign_task 转派,或 cancel_task 取消,或等待其返回。`,
              'reminder')
          }
        }
      }
      if (Date.parse(row.updatedAt) > cutoff) continue
      const reason = row.status === 'working' ? 'timeout' : 'no-response'
      void ledger.transition(row.id, 'failed', { reason }).then(() => {
        void reports.archive(row.id)
        notifySession(ctx, row.assignedBy, row.id,
          `任务 ${row.id} 已超时,状态「失败」(failed, reason: ${reason})。执行方未在时限内完成或回答。如需重做,请派发新任务。`,
          'timeout')
      })
    }
  }, Math.min(timeoutMs / 2, 600_000))
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'agent-bus.timeoutSweep')

  // Durable-note sweep (v1.5): deliver queued notes once their recipient is
  // live again. A delivery that fails again returns the note to the queue
  // (attempts+1); after 3 failed attempts the note is dropped and the sender
  // is notified. Idempotent by construction — each note is deleted exactly
  // when delivered.
  const NOTE_MAX_ATTEMPTS = 3
  const noteSweep = setInterval(() => {
    void (async () => {
      // Batch by recipient: every undelivered note for one live recipient is
      // delivered in ONE followup (one turn) instead of N queued messages —
      // the fallback-mailbox pattern from agent-teams. Each segment keeps
      // its own delayed stamp and sender.
      const byRecipient = new Map<string, ReturnType<typeof ledger.listPendingNotes>>()
      for (const note of ledger.listPendingNotes()) {
        const list = byRecipient.get(String(note.recipient)) ?? []
        list.push(note)
        byRecipient.set(String(note.recipient), list)
      }
      for (const [recipientId, notes] of byRecipient) {
        const recipient = ctx.agents.get(recipientId as never)
        if (recipient === undefined) continue
        const dropped: typeof notes = []
        const deliverable = notes.filter(note => {
          if (note.attempts >= NOTE_MAX_ATTEMPTS) {
            dropped.push(note)
            return false
          }
          return true
        })
        for (const note of dropped) {
          await ledger.deleteNote(note.id)
          notifySession(ctx, note.sender, TaskId(note.id),
            `你的离线消息(发送于 ${note.sentAt})经过 ${NOTE_MAX_ATTEMPTS} 次补投仍未送达,已丢弃。如需重新发送,请调用 send_note。`,
            'reminder')
        }
        if (deliverable.length === 0) continue
        try {
          const first = deliverable[0]!
          const body = deliverable.map(note =>
            `[来自 ${note.sender.slice(0, 8)},延迟送达,原发送时间 ${note.sentAt}]\n${note.content}`,
          ).join('\n\n---\n\n')
          const message = buildDelayedMessage(first.sender, first.id, body, first.sentAt)
          deliverTask(recipient, message, 'followup')
          for (const note of deliverable) await ledger.deleteNote(note.id)
        } catch {
          for (const note of deliverable) {
            await ledger.markNoteAttempt(note.id, note.attempts + 1)
          }
        }
      }
    })()
  }, 60_000)
  noteSweep.unref?.()
  ctx.effect(() => () => clearInterval(noteSweep), 'agent-bus.noteSweep')

  // Report-store sweep: hot files idle past 7 days and cold files idle past
  // 30 days are removed. Runs hourly; unref'd so it never holds the process.
  const cacheSweep = setInterval(() => {
    void reports.sweep()
  }, 3_600_000)
  cacheSweep.unref?.()
  ctx.effect(() => () => clearInterval(cacheSweep), 'agent-bus.cacheSweep')
}
