/**
 * The ledger sub-plugin: opens the agent-bus storage domain and exposes the
 * `TaskLedger` instance as a Cordis value service (`'ledger'`), so every other
 * sub-plugin and the composition root consume exactly one instance.
 *
 * This is the only place `TaskLedger.open` is called — the domain may be
 * opened once per process, and a second open on the same storage unit would
 * corrupt its write chain. Consumers obtain the instance via `ctx.get('ledger')`
 * (or as a passed `ledger` argument) and never open it again.
 *
 * `TaskLedger.open` already registers the domain-close disposer with
 * `ctx.effect`; the plugin's own `provide` disposer is registered on the same
 * fiber, so unloading the `agent-bus:ledger` plugin tears down both.
 *
 * @module dsh-agent-bus/ledger
 */

import type { Context } from '@deepseek-ai/cordis'
import { TaskLedger } from './ledger.ts'

/** Plugin name, mounted under the agent-bus host context. */
export const name = 'agent-bus:ledger'

/** Required services; {@link TaskLedger.open} reads `storageDomain`. */
export const inject = ['storageDomain']

/**
 * Open the ledger once and expose it as the `'ledger'` value service.
 *
 * @param ctx - the sub-plugin context; `storageDomain` is injected.
 */
export async function apply(ctx: Context): Promise<void> {
  const ledger = await TaskLedger.open(ctx)
  ctx.provide('ledger', ledger)
}
