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
 * This file is the thin composition root: it resolves config, constructs the
 * shared value services (`agent-bus/deps`, `agent-bus/boot`, the config
 * services), and mounts the nested cordis sub-plugins (ledger, members, tools,
 * runtime, bridges, web) in dependency order. All tools, hooks, sweeps, and
 * routes live in their own sub-plugin.
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
import {
  apply as applyMembersPlugin,
  inject as injectMembersPlugin,
  name as membersPluginName,
} from './members/index.ts'
import {
  apply as applyToolsPlugin,
  inject as injectToolsPlugin,
  name as toolsPluginName,
  type ToolsConfig,
} from './tools/index.ts'
import {
  apply as applyRuntimePlugin,
  inject as injectRuntimePlugin,
  name as runtimePluginName,
  type RuntimeConfig,
} from './runtime/index.ts'
import {
  apply as applyBridgesPlugin,
  inject as injectBridgesPlugin,
  name as bridgesPluginName,
  type BridgesConfig,
} from './bridges/index.ts'
import {
  apply as applyWebPlugin,
  inject as injectWebPlugin,
  name as webPluginName,
} from './web/index.ts'
import { DispatchRateLimiter } from './rate-limit.ts'
import { QuestionRegistry } from './bridges/question-registry.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setWakeRoute } from './members/wake.ts'

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
 * Mount the gateway: construct the shared value services, set the wake route,
 * and mount every nested sub-plugin in dependency order. A failed ledger open
 * is loud and the tools stay unregistered rather than accepting dispatches the
 * ledger cannot record.
 *
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 * @returns resolution after every sub-plugin is mounted.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved: ToolsConfig = {
    maxContentLength: config.maxContentLength ?? 16000,
    maxPendingPerAgent: config.maxPendingPerAgent ?? 20,
    maxSendsPerMinute: config.maxSendsPerMinute ?? 10,
    maxMessagesPerMinute: config.maxMessagesPerMinute ?? 20,
    maxInlineReport: config.maxInlineReport ?? 400,
  }

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
  const staleInfo: { stale: boolean; message: string | null } = {
    stale: isInstanceStale(BUILD_FINGERPRINT, diskFingerprint),
    message: staleMessage(BUILD_FINGERPRINT, diskFingerprint),
  }
  if (staleInfo.stale) {
    ctx.logger.warn(`agent-bus: ${staleInfo.message ?? '代码已更新,需重启生效'}`)
  }

  // Decision 10 C: the startup-recovery record (workers re-woken this boot).
  // Written by the runtime sub-plugin after its recovery sweep settles; read
  // by the web panel snapshot. Mutable, shared via `agent-bus/boot`.
  const recoveryInfo: { recoveredWorkers: number; recoveryAt: number | null } = {
    recoveredWorkers: 0,
    recoveryAt: null,
  }
  setWakeRoute({
    ...(config.wakeProvider !== undefined ? { provider: config.wakeProvider } : {}),
    ...(config.wakeModel !== undefined ? { model: config.wakeModel } : {}),
  })
  // Mount the members sub-plugin after the wake-route singleton is set (so its
  // `wakeSession` always reads the configured fallback route) and the ledger
  // service is open (the member-host face carries the same `ledger`).
  await ctx.plugin({
    name: membersPluginName,
    inject: injectMembersPlugin,
    apply: applyMembersPlugin,
  })

  // Construct the shared runtime deps. The rate limiters and report/question
  // stores are process-scoped; the executors' activity map backs both the
  // tools' `noteActivity` signal and the runtime heartbeat's `activityAt`.
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
  const activityAt = (sessionId: SessionId): number | undefined => lastActivity.get(String(sessionId))

  // Provide the shared value services the sub-plugins consume.
  ctx.provide('agent-bus/deps', { limiter, messageLimiter, reports, questions, noteActivity, activityAt })
  ctx.provide('agent-bus/boot', { staleInfo, recoveryInfo })
  ctx.provide('agent-bus/tools-config', resolved)
  const runtimeConfig: RuntimeConfig = {
    taskTimeoutMs: config.taskTimeoutMs ?? 7_200_000,
    offlineGraceMs: config.offlineGraceMs ?? 900_000,
    retryIdleMs: config.retryIdleMs ?? 300_000,
    heartbeatCooldownMs: config.heartbeatCooldownMs ?? (config.retryIdleMs ?? 300_000),
    promptSectionOrder: config.promptSectionOrder ?? 118,
  }
  ctx.provide('agent-bus/runtime-config', runtimeConfig)
  ctx.provide('agent-bus/bridges-config', {
    questionTimeoutMs: config.questionTimeoutMs ?? 600_000,
    approvalTimeoutMs: config.approvalTimeoutMs ?? 600_000,
    fullAccessSessions: (config.fullAccessSessions ?? []).map(id => SessionId(id)),
  } satisfies BridgesConfig)

  // Mount the remaining sub-plugins in dependency order: tools consume the
  // ledger + deps + member-host; runtime consumes deps + boot; bridges consume
  // the ledger + deps; web consumes the ledger + deps + boot.
  await ctx.plugin({
    name: toolsPluginName,
    inject: injectToolsPlugin,
    apply: applyToolsPlugin,
  })
  await ctx.plugin({
    name: runtimePluginName,
    inject: injectRuntimePlugin,
    apply: applyRuntimePlugin,
  })
  await ctx.plugin({
    name: bridgesPluginName,
    inject: injectBridgesPlugin,
    apply: applyBridgesPlugin,
  })
  await ctx.plugin({
    name: webPluginName,
    inject: injectWebPlugin,
    apply: applyWebPlugin,
  })
}
