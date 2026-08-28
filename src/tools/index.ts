/**
 * The model-facing tool surface: the agent-bus tools over the ledger and the
 * delivery path, named after the A2A operation set where one exists.
 *
 * @module dsh-agent-bus/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskLedger } from '../ledger/ledger.ts'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ReportStore } from '../external.ts'
import type { QuestionRegistry } from '../question-bridge.ts'
import type { DispatchRateLimiter } from '../rate-limit.ts'
import { registerAnswerTools } from './answer.ts'
import { registerFlowsTools } from './flows.ts'
import { registerHelpTools } from './help.ts'
import { registerListTools } from './list.ts'
import { registerMembersTools } from './members.ts'
import { registerSendTools } from './send.ts'
import { registerTasksTools } from './tasks.ts'
import { type ToolsConfig, type ToolsDeps } from './common.ts'
export { isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type ToolsConfig, type ToolsDeps } from './common.ts'

/** Plugin name, mounted under the agent-bus host context. */
export const name = 'agent-bus:tools'

/** Required services; optional service reads (`permissionPresets` / `sessionProjections` / `agentPresets` / `skills`) use `ctx.get`. */
export const inject = ['tools', 'agents', 'sessionTitle', 'workspaceRegistry', 'ledger', 'agent-bus/deps', 'agent-bus/member-host']

/** The shared runtime deps the tools consume, provided by the composition root. */
interface SharedDeps {
  readonly limiter: DispatchRateLimiter
  readonly messageLimiter: DispatchRateLimiter
  readonly reports: ReportStore
  readonly questions: QuestionRegistry
  readonly noteActivity: (sessionId: SessionId) => void
}

export async function apply(ctx: Context): Promise<void> {
  const config = ctx.get('agent-bus/tools-config') as ToolsConfig
  const shared = ctx.get('agent-bus/deps') as SharedDeps
  const deps: ToolsDeps = {
    ledger: ctx.get('ledger') as TaskLedger,
    workspaces: ctx.workspaceRegistry,
    limiter: shared.limiter,
    messageLimiter: shared.messageLimiter,
    reports: shared.reports,
    questions: shared.questions,
    noteActivity: shared.noteActivity,
  }
  registerAgentBusTools(ctx, config, deps)
}

/**
 * Register every agent-bus tool, grouped by domain; each is gated by
 * `checkedTool`.
 *
 * @param ctx - context carrying the tool registry and live Agent registry.
 * @param config - resolved tunables.
 * @param deps - the opened ledger and the workspace registry.
 */
export function registerAgentBusTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  registerListTools(ctx, config, deps)
  registerSendTools(ctx, config, deps)
  registerFlowsTools(ctx, config, deps)
  registerTasksTools(ctx, config, deps)
  registerAnswerTools(ctx, config, deps)
  registerMembersTools(ctx, config, deps)
  registerHelpTools(ctx, config, deps)
}
