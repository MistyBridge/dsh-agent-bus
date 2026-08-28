/**
 * Agent Bus for DeepSeek Harness.
 *
 * A host-plane plugin that gives live sessions in the same workspace a way to
 * dispatch work to each other, with a durable ledger recording what was asked
 * and how it turned out. The ledger's lifecycle follows the A2A TaskState
 * vocabulary; the settlement verdict is recorded without changing the state.
 *
 * Two planes, deliberately separate. Delivery is the harness's own: a task
 * becomes one `followup()` on the recipient's inbox, and the driver claims one
 * queued item at a time, running each as its own turn with a durability
 * checkpoint between them. The ledger is this plugin's: it records intent and
 * outcome, and never mirrors the inbox — the inbox is the execution authority
 * and the two drift by design.
 *
 * Authority is derived from durable relationships, never from a stored role.
 * Reachability comes from shared workspace membership; settlement and cancel
 * authority belong to the session recorded as a task's dispatcher. So "PM" is
 * emergent: dispatch work to someone and you are that task's dispatcher, with
 * no role to assign and no way to approve your own work.
 *
 * Installation: `dsh plugin --profile <name> add <this package>`.
 *
 * @module dsh-agent-bus
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.storageDomain and ctx.systemPrompt visible.
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { BUILD_FINGERPRINT } from './build-fingerprint.ts'
import { ReportStore } from './external.ts'
import { isInstanceStale, readDiskFingerprint, staleMessage } from './fingerprint.ts'
import type { TaskLedger } from './ledger/ledger.ts'
import {
  apply as applyLedgerPlugin,
  inject as injectLedgerPlugin,
  name as ledgerPluginName,
} from './ledger/index.ts'
import { buildPanelSnapshot, type RecoveryInfo, type StaleInfo } from './panel.ts'
import { installApprovalBridge } from './approval-bridge.ts'
import { registerQuestionBridge, QuestionRegistry } from './question-bridge.ts'
import { DispatchRateLimiter } from './rate-limit.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildDelayedMessage, buildTaskMessage, deliverTask, notifySession } from './delivery.ts'
import { dispatchOne, dispatchReadyTasks, releaseDependents, resumeStrandedTasks, shouldHeartbeatRedeliver } from './scheduler.ts'
import { setWakeRoute } from './wake.ts'
import { registerAgentBusTools, type ToolsConfig } from './tools.ts'
import { USAGE_OVERVIEW } from './tool-docs.ts'
import { TaskId } from './domain/types.ts'

export const name = 'agent-bus'

/**
 * Required services and provided values. `storageDomain` is a value the
 * storage-domain plugin provides (not a Service), so it is injected by name
 * exactly as the workspace package injects it. A profile that mounts neither
 * storage nor the workspace registry fails loud at load rather than booting a
 * gateway that could record nothing — misconfiguration must not degrade into
 * a silent prompt-only stub. `sessionTitle` ships with the base bundle, so it
 * resolves in every profile.
 */
export const inject = ['tools', 'agents', 'systemPrompt', 'sessionTitle', 'storageDomain', 'workspaceRegistry']

/** Plugin configuration. */
export interface Config {
  /** Character ceiling on relayed content; over-length content is refused, not truncated (default `16000`). */
  maxContentLength?: number
  /** Unfinished tasks one recipient may hold before dispatch is refused (default `20`). */
  maxPendingPerAgent?: number
  /** Dispatches one sender may issue per minute (default `10`). */
  maxSendsPerMinute?: number
  /** Lightweight messages one sender may send per minute (default `20`). */
  maxMessagesPerMinute?: number
  /** How long a working or input-required task may sit before failing (default `7200000`, 2 hours). */
  taskTimeoutMs?: number
  /** How long a working task's offline executor may be gone before the initiator is asked to decide (default `900000`, 15 min). */
  offlineGraceMs?: number
  /** Model route for woken dormant sessions; defaults to inheriting from a live session. */
  wakeProvider?: string
  /** Model id for woken dormant sessions; defaults to inheriting from a live session. */
  wakeModel?: string
  /** How long a working/submitted task may sit with an IDLE live executor before the heartbeat re-delivers it (default `300000`, 5 min). */
  retryIdleMs?: number
  /** How recently an executor's activity (a turn ending, a claim, a report) suppresses the stranded-recovery heartbeat for it; defaults to `retryIdleMs` (decision 2). */
  heartbeatCooldownMs?: number
  /** How long the question bridge waits for the task initiator to answer a forwarded `ask_user_question` before failing closed (default `600000`, 10 min). */
  questionTimeoutMs?: number
  /** How long the approval bridge waits for the task initiator to answer a delegated approval before failing closed (default `600000`, 10 min). */
  approvalTimeoutMs?: number
  /** Fallback approvers for session-level approval requests with no owning task (decision 6 §5); empty means such requests defer to the harness chain. */
  fullAccessSessions?: string[]
  /** Reports longer than this are externalized to the report store (default `400`). */
  maxInlineReport?: number
  /** Prompt-section order for the usage policy (default `118`). */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  maxContentLength: z.natural().min(1).default(16000),
  maxPendingPerAgent: z.natural().min(1).default(20),
  maxSendsPerMinute: z.natural().min(1).default(10),
  maxMessagesPerMinute: z.natural().min(1).default(20),
  taskTimeoutMs: z.natural().min(60_000).default(7_200_000),
  offlineGraceMs: z.natural().min(60_000).default(900_000),
  questionTimeoutMs: z.natural().min(1).default(600_000),
  approvalTimeoutMs: z.natural().min(1).default(600_000),
  fullAccessSessions: z.array(z.string()).default([]),
  maxInlineReport: z.natural().min(1).default(400),
  promptSectionOrder: z.natural().default(118),
})

/**
 * Mount the gateway.
 *
 * Opens the ledger first; a failed open is loud and the tools stay
 * unregistered rather than accepting dispatches the ledger cannot record.
 *
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 * @returns resolution after the ledger is open and the tools are registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved: ToolsConfig = {
    maxContentLength: config.maxContentLength ?? 16000,
    maxPendingPerAgent: config.maxPendingPerAgent ?? 20,
    maxSendsPerMinute: config.maxSendsPerMinute ?? 10,
    maxMessagesPerMinute: config.maxMessagesPerMinute ?? 20,
    maxInlineReport: config.maxInlineReport ?? 400,
  }

  // Carries the ROUTE BY SCOPE + ROUTING PREFERENCE guidance: prefer agent-bus
  // flows (create_flow / create_task) over a fire-and-forget subagent for large,
  // multi-deliverable work, so the work stays durable and reviewable per task.
  ctx.systemPrompt.section({
    name: 'agent-bus:usage',
    order: config.promptSectionOrder ?? 118,
    text: USAGE_OVERVIEW,
  })

  // Mount the ledger sub-plugin first: it is the single opener of the
  // storage domain and provides the `'ledger'` value service. Consumers below
  // obtain the SAME instance from `ctx.get('ledger')` — never open it again.
  await ctx.plugin({
    name: ledgerPluginName,
    inject: injectLedgerPlugin,
    apply: applyLedgerPlugin,
  })
  const ledger = ctx.get('ledger') as TaskLedger

  // Decision 7: detect a lib/ rebuild this process did not pick up. The loaded
  // code carries its build-time fingerprint; the disk fingerprint is read once
  // at startup (both live next to this module in lib/). A mismatch surfaces as
  // a startup warning and a panel hint — never an auto-restart, which would
  // interrupt sessions without the user's decision.
  const diskFingerprint = readDiskFingerprint(
    fileURLToPath(new URL('./build-fingerprint.json', import.meta.url)),
  )
  const instanceInfo: StaleInfo = {
    stale: isInstanceStale(BUILD_FINGERPRINT, diskFingerprint),
    message: staleMessage(BUILD_FINGERPRINT, diskFingerprint),
  }
  if (instanceInfo.stale) {
    ctx.logger.warn(`agent-bus: ${instanceInfo.message ?? '代码已更新,需重启生效'}`)
  }

  // Decision 10 C: the startup-recovery record (workers re-woken this boot).
  // Written once after the recovery sweep settles; read by every state poll.
  // Mutable local, structurally assignable to the readonly RecoveryInfo the
  // snapshot builder consumes.
  const recoveryInfo: { recoveredWorkers: number; recoveryAt: number | null } = {
    recoveredWorkers: 0,
    recoveryAt: null,
  }
  setWakeRoute({
    ...(config.wakeProvider !== undefined ? { provider: config.wakeProvider } : {}),
    ...(config.wakeModel !== undefined ? { model: config.wakeModel } : {}),
  })
  const limiter = new DispatchRateLimiter(resolved.maxSendsPerMinute, 60_000)
  // Separate window for the message channel: chatter must not exhaust the
  // task quota, and a dispatch loop must not be able to hide behind message
  // rate.
  const messageLimiter = new DispatchRateLimiter(resolved.maxMessagesPerMinute, 60_000)
  const reports = new ReportStore(
    dshHomePath('agent-bus', 'cache'),
    dshHomePath('agent-bus', 'archive'),
  )
  // Decision 9: the pending-question registry shared by the tools/execute
  // bridge (registers an ask while waiting) and the answer_question tool
  // (resolves one). Cleared on teardown so no ask outlives the plugin.
  const questions = new QuestionRegistry()
  ctx.effect(() => () => questions.clear('agent-bus plugin disposed'), 'agent-bus.questionRegistry')
  // Decision 2: the stranded-recovery heartbeat must not kick an executor that
  // is demonstrably ON the task. `lastActivity` records the last time a session
  // ended a turn, claimed a delivery, or called a task-progress tool; the
  // heartbeat skips a re-delivery while that timestamp is fresh. Process-local
  // by design: a restart wipes it, and the freshly recovered row's own
  // `updatedAt` re-arms the retry window anyway.
  const lastActivity = new Map<string, number>()
  const noteActivity = (sessionId: SessionId): void => {
    lastActivity.set(String(sessionId), Date.now())
  }
  registerAgentBusTools(ctx, resolved, {
    ledger,
    workspaces: ctx.workspaceRegistry,
    limiter,
    messageLimiter,
    reports,
    questions,
    noteActivity,
  })
  registerQuestionBridge(ctx, ledger, questions, {
    questionTimeoutMs: config.questionTimeoutMs ?? 600_000,
  })
  // Decision 6: delegate authorization-requiring operations from a working
  // sub-agent to its task initiator (the PM). Registered after the question
  // bridge; both are host-level and independent seams.
  ctx.effect(() => installApprovalBridge(ctx, ledger, {
    approvalTimeoutMs: config.approvalTimeoutMs ?? 600_000,
    fullAccessSessions: (config.fullAccessSessions ?? []).map(id => SessionId(id)),
  }), 'agent-bus.approvalBridge')

  // Task panel state route. The browser floater polls this snapshot every two
  // seconds. `webServer` exists only in Web profiles and may bind after this
  // plugin under concurrent activation, so the route registers lazily: try
  // now, then on each service-binding event. A webless profile stays
  // tool-only and never blocks boot.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const webServer = ctx.get('webServer') as
      | { register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void }
      | undefined
    if (webServer === undefined) return
    webRegistered = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/state',
      handler: async (_req, res) => {
        try {
          const snapshot = await buildPanelSnapshot(ctx, ledger, reports, Date.now(), instanceInfo, recoveryInfo)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(snapshot))
        } catch (error: unknown) {
          ctx.logger.warn(`agent-bus: state route failed: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'snapshot-failed' }))
        }
      },
    }), 'agent-bus: panel route')
    // TaskChanged event stream (SSE) for the client event-driven scheduler.
    // Every ledger mutation emits after the durable write; the panel holds
    // one connection and drives dispatch decisions from these events.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/events',
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        const listener = (event: unknown): void => {
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        const dispose = ctx.on('agent-bus/task-changed', listener)
        req.on('close', dispose)
      },
    }), 'agent-bus: events route')
    // Dispatch endpoint: the client scheduler posts a queued task id once its
    // dependencies have all settled. Idempotent — dispatchOne skips any task
    // that is no longer queued, so concurrent posts and the server backstop
    // sweep can race safely.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/dispatch',
      handler: async (req, res) => {
        const send = (status: number, body: object): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method !== 'POST') {
            send(405, { error: 'method-not-allowed' })
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { taskId?: unknown }
          if (typeof parsed.taskId !== 'string' || parsed.taskId === '') {
            send(400, { error: 'taskId required' })
            return
          }
          const taskId = TaskId(parsed.taskId)
          const task = ledger.get(taskId)
          if (task === undefined) {
            send(404, { error: 'no such task' })
            return
          }
          if (task.status !== 'queued') {
            // Idempotent no-op: already delivered or terminal.
            send(200, { taskId: String(taskId), status: task.status, dispatched: false })
            return
          }
          await dispatchOne(ctx, ledger, taskId)
          send(200, { taskId: String(taskId), status: 'submitted', dispatched: true })
        } catch (error: unknown) {
          send(500, { error: String(error) })
        }
      },
    }), 'agent-bus: dispatch route')
    // Manual archive endpoint (decision 12): the panel's archive/unarchive
    // buttons POST here. User-driven, never automatic — mirrors the workspace
    // session-archive UX. Archiving is a reversible visibility toggle.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/archive',
      handler: async (req, res) => {
        const send = (status: number, body: object): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method !== 'POST') {
            send(405, { error: 'method-not-allowed' })
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as
            { kind?: unknown; id?: unknown; archived?: unknown }
          if (typeof parsed.kind !== 'string' || typeof parsed.id !== 'string' || parsed.id === '') {
            send(400, { error: 'kind and id required' })
            return
          }
          const archived = parsed.archived !== false
          if (parsed.kind === 'task') {
            const taskId = TaskId(parsed.id)
            const task = ledger.get(taskId)
            if (task === undefined) {
              send(404, { error: 'no such task' })
              return
            }
            const result = await ledger.archiveTask(taskId, archived)
            if (!result.ok) {
              send(400, { error: result.message })
              return
            }
            send(200, { taskId: String(taskId), status: result.task.status, archived })
            return
          }
          if (parsed.kind === 'flow') {
            const flowId = parsed.id
            const flow = ledger.getFlow(flowId)
            if (flow === undefined) {
              send(404, { error: 'no such flow' })
              return
            }
            const result = await ledger.archiveFlow(flowId, archived)
            if (!result.ok) {
              send(400, { error: result.message })
              return
            }
            send(200, { flowId, name: result.flow.name, archived })
            return
          }
          send(400, { error: 'kind must be task or flow' })
        } catch (error: unknown) {
          ctx.logger.warn(`agent-bus: archive route failed: ${String(error)}`)
          send(500, { error: 'archive-failed' })
        }
      },
    }), 'agent-bus: archive route')
  }
  registerWebSurface()
  ctx.on('internal/service', (name) => {
    if (name === 'webServer') registerWebSurface()
  })

  // Ledger state follows the real inbox lifecycle. The events are scope-filtered
  // per agent; a listener on the host context admits them from every agent.
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
  void dispatchReadyTasks(ctx, ledger)
  // Decision 10 B: after a restart, re-wake the executors of tasks a crash
  // left stranded (working / submitted / input-required with a dormant
  // executor) — no human needs to pull workers back online by hand. The
  // recovered count feeds the panel hint (decision 10 C).
  void resumeStrandedTasks(ctx, ledger).then(count => {
    if (count > 0) {
      recoveryInfo.recoveredWorkers = count
      recoveryInfo.recoveryAt = Date.now()
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
  const timeoutMs = config.taskTimeoutMs ?? 7_200_000
  const offlineGraceMs = config.offlineGraceMs ?? 900_000
  const retryIdleMs = config.retryIdleMs ?? 300_000
  // Decision 2: the heartbeat skips an executor whose activity is fresher than
  // the cooldown; the cooldown defaults to the retry window itself.
  const heartbeatCooldownMs = config.heartbeatCooldownMs ?? retryIdleMs
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
          ? lastActivity.get(String(row.assignedTo))
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
