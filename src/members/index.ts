/**
 * The members sub-plugin: `agent-bus:members`.
 *
 * Owns the member / identity / authorization / wake vocabulary as pure
 * modules the `agent-bus:tools` sub-plugin imports, and composes the minimal
 * harness service face both `create_member` and `reconfigure_member` drive
 * into one value service (`'agent-bus/member-host'`) so the tools never
 * re-assemble it.
 *
 * This plugin registers no tools. The tools phase (`agent-bus:tools`) injects
 * `'agent-bus/member-host'` and imports the member modules directly. The wake
 * route singleton (`setWakeRoute` in `wake.ts`) is module-level and set by the
 * composition root BEFORE this plugin mounts, so `wakeSession` always reads the
 * configured fallback route.
 *
 * @module dsh-agent-bus/members
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskLedger } from '../ledger/ledger.ts'
import type { CreateMemberHost, PresetMountHost } from './create-member.ts'
import { setMemberRole, type PermissionPresetHost } from './member-config.ts'
import { wakeSession } from './wake.ts'

/** Plugin name, mounted under the agent-bus host context. */
export const name = 'agent-bus:members'

/**
 * Required services. The optional member-composition services
 * (`permissionPresets` / `agentPresets` / `skills` / `sessionPersistence`) are
 * read via `ctx.get` so a deployment that composes none degrades instead of
 * blocking the plugin.
 */
export const inject = ['agents', 'sessionTitle', 'workspaceRegistry', 'ledger']

/**
 * The member-host value service: the structural face both the `create_member`
 * orchestrator (`CreateMemberHost`) and the `reconfigure_member` orchestrator
 * (`ReconfigureMemberHost`) drive. A superset of {@link CreateMemberHost} that
 * additionally carries `agents.get`, a wake-route-aware `agents.resume`, and
 * `setRole` so a single host serves both tools without re-assembly.
 */
export interface MemberHost extends CreateMemberHost {
  /** Resolve the member to a live agent; `resume` wakes a dormant member. */
  readonly agents: CreateMemberHost['agents'] & {
    get(id: SessionId): Agent | undefined
    resume(id: SessionId): Promise<Agent | undefined>
  }
  /** Replace the member's role section in its agent scope; absent → role changes refuse. */
  readonly setRole?: (member: Agent, text: string) => void
}

/**
 * Compose the member-host face and expose it as the `'agent-bus/member-host'`
 * value service.
 *
 * `wakeSession` (from the moved `wake.ts`) is the wake-route-aware resume — it
 * reads the module `setWakeRoute` singleton set by the composition root before
 * this plugin mounts, and restores the dormant session's preset composition.
 *
 * @param ctx - the sub-plugin context; `agents` / `sessionTitle` /
 *   `workspaceRegistry` / `ledger` are injected.
 */
export function apply(ctx: Context): void {
  const host: MemberHost = {
    workspaceRegistry: ctx.workspaceRegistry,
    agents: {
      create: options => ctx.agents.create(options),
      get: id => ctx.agents.get(id),
      resume: id => wakeSession(ctx, id),
    },
    sessionTitle: ctx.sessionTitle,
    permissionPresets: ctx.get('permissionPresets') as PermissionPresetHost | undefined,
    agentPresets: ctx.get('agentPresets') as PresetMountHost | undefined,
    skills: ctx.get('skills') as {
      get(name: string): Promise<{ description: string; content: string } | undefined>
    } | undefined,
    ledger: ctx.get('ledger') as TaskLedger,
    setRole: (member, text) => setMemberRole(String(member.id), member.ctx, text),
  }
  ctx.provide('agent-bus/member-host', host)
}
