/**
 * Browser plugin for dsh-agent-bus.
 *
 * Two surfaces, both composed through the harness client slot system:
 * - collapsed `agent-bus-task` tool rows in the keyed `tool.call.toolview`
 *   slot (one entry per tool name), instead of the generic "Tool call" card;
 * - the floating workbench mounted in the frame-wide `shell.overlay` list
 *   slot. That slot is rendered by the app frame under both the browser web
 *   GUI and the Electron desktop shell, so the workbench appears in either
 *   environment. A raw `document.body` fixed-position append would render
 *   only inside a bare browser page.
 *
 * @module dsh-agent-bus/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { AgentBusToolRow } from './AgentBusToolRow.tsx'
import { TaskPanel } from './TaskPanel.tsx'

/** Required services: the slot registry. Session data arrives through the panel's useSessions slot hook. */
export const inject = ['slots']

/** Every model-facing tool this plugin renders in collapsed form. */
const AGENT_BUS_TOOLS = [
  'list_peers',
  'send_note',
  'create_flow',
  'list_flows',
  'create_task',
  'dispatch_task',
  'edit_task',
  'list_tasks',
  'get_task',
  'report_task',
  'settle_task',
  'cancel_task',
  'request_input',
  'update_card',
]

/**
 * Mount the toolview registrations.
 *
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  for (const tool of AGENT_BUS_TOOLS) {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: tool }, AgentBusToolRow))
  }

  // The floating workbench mounts through the frame-wide `shell.overlay` list
  // slot (rendered by the app frame) instead of a raw `document.body` append,
  // so it appears under the browser web GUI and the Electron desktop shell
  // alike — both host the same web bundle.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'agent-bus-task-panel', order: 100 },
      TaskPanel))
}
