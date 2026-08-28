/**
 * The bridges sub-plugin: `agent-bus:bridges`.
 *
 * Wires the question bridge (decision 9) and the approval bridge (decision 6):
 * both route a worker-side interaction to the task initiator (the PM) through
 * a durable `assignedBy` relationship instead of a stored role. The shared
 * `QuestionRegistry` is provided by the composition root via `agent-bus/deps`.
 *
 * @module dsh-agent-bus/bridges
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskLedger } from '../ledger/ledger.ts'
import { installApprovalBridge } from './approval-bridge.ts'
import { registerQuestionBridge } from './question-bridge.ts'
import type { QuestionRegistry } from './question-registry.ts'

/** Plugin name, mounted under the agent-bus host context. */
export const name = 'agent-bus:bridges'

/** Required services. `tools` is needed because the approval bridge registers
 * the `respond_approval` tool; the question bridge reads the registry via
 * `agent-bus/deps`. */
export const inject = ['agents', 'ledger', 'agent-bus/deps', 'tools']

/** The bridge tunables, provided by the composition root as a value service. */
export interface BridgesConfig {
  readonly questionTimeoutMs: number
  readonly approvalTimeoutMs: number
  readonly fullAccessSessions: readonly SessionId[]
}

/** The slice of `agent-bus/deps` the bridges consume. */
interface BridgesDeps {
  readonly questions: QuestionRegistry
}

/**
 * Mount the bridges: register the question around-wrapper on `tools/execute`
 * and delegate authorization-requiring operations to the task initiator.
 *
 * @param ctx - the sub-plugin context.
 */
export function apply(ctx: Context): void {
  const config = ctx.get('agent-bus/bridges-config') as BridgesConfig
  const deps = ctx.get('agent-bus/deps') as BridgesDeps
  const ledger = ctx.get('ledger') as TaskLedger

  registerQuestionBridge(ctx, ledger, deps.questions, {
    questionTimeoutMs: config.questionTimeoutMs,
  })
  // Decision 6: delegate authorization-requiring operations from a working
  // sub-agent to its task initiator (the PM). Registered after the question
  // bridge; both are host-level and independent seams.
  ctx.effect(() => installApprovalBridge(ctx, ledger, {
    approvalTimeoutMs: config.approvalTimeoutMs,
    fullAccessSessions: config.fullAccessSessions,
  }), 'agent-bus.approvalBridge')
}
