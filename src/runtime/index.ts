/**
 * The runtime sub-plugin: `agent-bus:runtime`.
 *
 * Owns the ledger lifecycle hooks, the startup dispatch/recovery, and the
 * periodic sweeps that were inline in the composition root, plus the
 * `agent-bus:usage` prompt section. It consumes the shared `agent-bus/deps`
 * and `agent-bus/boot` value services and writes the mutable `boot.recoveryInfo`
 * that the web panel reads.
 *
 * @module dsh-agent-bus/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskLedger } from '../ledger/ledger.ts'
import type { ReportStore } from '../external.ts'
import { USAGE_OVERVIEW } from '../tools/tool-docs.ts'
import { registerRuntimeHooks } from './hooks.ts'
import { registerSweeps } from './sweeps.ts'

/** Plugin name, mounted under the agent-bus host context. */
export const name = 'agent-bus:runtime'

/** Required services. `systemPrompt` hosts the usage section; `agent-bus/deps`
 * and `agent-bus/boot` are provided by the composition root. */
export const inject = ['agents', 'ledger', 'agent-bus/deps', 'agent-bus/boot', 'systemPrompt']

/** The runtime tunables, provided by the composition root as a value service. */
export interface RuntimeConfig {
  readonly taskTimeoutMs: number
  readonly offlineGraceMs: number
  readonly retryIdleMs: number
  readonly heartbeatCooldownMs: number
  readonly promptSectionOrder: number
}

/** The slice of `agent-bus/deps` the runtime consumes. */
interface RuntimeDeps {
  readonly reports: ReportStore
  readonly noteActivity: (sessionId: SessionId) => void
  readonly activityAt: (sessionId: SessionId) => number | undefined
}

/** The `agent-bus/boot` value service shape (recoveryInfo is mutable). */
interface Boot {
  readonly staleInfo: { stale: boolean; message: string | null }
  readonly recoveryInfo: { recoveredWorkers: number; recoveryAt: number | null }
}

/**
 * Mount the runtime: host the usage prompt section, register the lifecycle
 * hooks, and start the startup dispatch/recovery plus the periodic sweeps.
 *
 * @param ctx - the sub-plugin context.
 */
export function apply(ctx: Context): void {
  const config = ctx.get('agent-bus/runtime-config') as RuntimeConfig
  const deps = ctx.get('agent-bus/deps') as RuntimeDeps
  const boot = ctx.get('agent-bus/boot') as Boot
  const ledger = ctx.get('ledger') as TaskLedger

  // Carries the ROUTE BY SCOPE + ROUTING PREFERENCE guidance: prefer agent-bus
  // flows (create_flow / create_task) over a fire-and-forget subagent for large,
  // multi-deliverable work, so the work stays durable and reviewable per task.
  ctx.systemPrompt.section({
    name: 'agent-bus:usage',
    order: config.promptSectionOrder,
    text: USAGE_OVERVIEW,
  })

  registerRuntimeHooks(ctx, { ledger, noteActivity: deps.noteActivity })
  registerSweeps(ctx, {
    ledger,
    reports: deps.reports,
    activityAt: deps.activityAt,
    boot,
    config,
  })
}
