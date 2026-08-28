/**
 * The web sub-plugin: `agent-bus:web`.
 *
 * Registers the task-panel snapshot / event-stream / dispatch / archive routes
 * on the harness web server (when one is present). It reads the mutable
 * `agent-bus/boot` record (stale-instance and recovery hints) that the runtime
 * plugin writes.
 *
 * @module dsh-agent-bus/web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TaskLedger } from '../ledger/ledger.ts'
import type { ReportStore } from '../external.ts'
import { registerWebSurface } from './routes.ts'

/** Plugin name, mounted under the agent-bus host context. */
export const name = 'agent-bus:web'

/** Required services. `webServer` is read lazily via `ctx.get` (optional). */
export const inject = ['agents', 'ledger', 'agent-bus/deps', 'agent-bus/boot']

/** The slice of `agent-bus/deps` the web surface consumes. */
interface WebDeps {
  readonly reports: ReportStore
}

/** The `agent-bus/boot` value service shape (recoveryInfo is mutable). */
interface Boot {
  readonly staleInfo: { stale: boolean; message: string | null }
  readonly recoveryInfo: { recoveredWorkers: number; recoveryAt: number | null }
}

/**
 * Mount the web surface: register the routes on the web server if it is
 * present, retrying on each service-binding event.
 *
 * @param ctx - the sub-plugin context.
 */
export function apply(ctx: Context): void {
  const deps = ctx.get('agent-bus/deps') as WebDeps
  const boot = ctx.get('agent-bus/boot') as Boot
  const ledger = ctx.get('ledger') as TaskLedger
  registerWebSurface(ctx, { ledger, reports: deps.reports, boot })
}
