/**
 * Shared member-configuration semantics for `create_member` (decision 5) and
 * `reconfigure_member` (E4.4): the permission parser and write path, the
 * role-section contract, and the live-role disposer registry.
 *
 * `create_member` mounts a member's role + permissions at onboarding;
 * `reconfigure_member` replaces them on a live (or freshly-woken) member.
 * Both route through this module so the two never drift: one permission
 * grammar, one role-section name/order, one write path.
 *
 * The role disposer registry is process-local. It lets a later reconfigure
 * dispose the section a live member mounted at creation instead of colliding
 * with it (`systemPrompt.section` rejects a duplicate name within one scope
 * layer). A cold member that was resumed under a fresh agent scope has no
 * section to dispose, so the registry simply misses it and the new section
 * registers cleanly.
 *
 * @module dsh-agent-bus/member-config
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { PERSONA_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { setSandboxMode, SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'

/** The sandbox modes the harness supports, in declaration order. */
export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** The approval policies the harness supports, in declaration order. */
export type ApprovalPolicy = 'ask' | 'never'

/** Explicit permission knobs, an alternative to naming a preset. */
export interface PermissionKnobs {
  readonly sandbox: SandboxMode
  readonly approval: ApprovalPolicy
}

/** Minimal permission-presets face used for preset-name permissions. */
export interface PermissionPresetHost {
  readonly names: readonly string[]
  set(session: Session, name: string): void
}

/**
 * The system-prompt section that carries the member's role. A dedicated name
 * (not the persona section) so layering over a default preset that already
 * installed a persona cannot collide — `systemPrompt.section` rejects
 * duplicate names within one scope layer.
 */
export const MEMBER_ROLE_SECTION = 'agent-bus:member-role'

/** Order of the role section: directly after the persona section. */
export const MEMBER_ROLE_ORDER = PERSONA_ORDER + 1

/** Outcome of validating one raw `permissions` value. */
export type PermissionsParseResult =
  | { readonly ok: true; readonly permissions: string | PermissionKnobs }
  | { readonly ok: false; readonly error: string }

/**
 * Validate one raw `permissions` value into a preset name or explicit knobs.
 *
 * Shared by `create_member` and `reconfigure_member` so the two accept (and
 * refuse) exactly the same permission grammar. The error names the offending
 * field without a tool prefix; callers prepend their own so a refusal reads
 * as coming from the tool that raised it.
 *
 * @param value - the raw `permissions` tool argument.
 * @returns the validated value, or a field-naming refusal.
 */
export function parsePermissions(value: unknown): PermissionsParseResult {
  if (typeof value === 'string') {
    if (value.trim() === '') {
      return { ok: false, error: 'field "permissions" must be a non-empty preset name' }
    }
    return { ok: true, permissions: value.trim() }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const knobs = value as Record<string, unknown>
    if (!SANDBOX_MODES.includes(knobs.sandbox as SandboxMode)) {
      return { ok: false, error: `field "permissions.sandbox" must be one of ${SANDBOX_MODES.join('|')}` }
    }
    if (knobs.approval !== 'ask' && knobs.approval !== 'never') {
      return { ok: false, error: 'field "permissions.approval" must be one of ask|never' }
    }
    return {
      ok: true,
      permissions: { sandbox: knobs.sandbox as SandboxMode, approval: knobs.approval as ApprovalPolicy },
    }
  }
  return { ok: false, error: 'field "permissions" must be a preset name or a {sandbox, approval} object' }
}

/**
 * Apply a member's permissions to its live session, overriding the current
 * pin. A preset name is routed through the permission-presets service (which
 * writes its own permission/preset event plus knob deltas); explicit knobs
 * write `sandbox/mode` and `approval/policy`. Both are durable session-log
 * events, so a reconfigured member keeps the new policy across restart.
 *
 * @param host - the permission-presets face (may be absent).
 * @param session - the member's live session.
 * @param permissions - the preset name or explicit knobs from the plan.
 */
export function applyPermissions(
  host: { permissionPresets?: PermissionPresetHost },
  session: Session,
  permissions: string | PermissionKnobs,
): void {
  if (typeof permissions === 'string') {
    const service = host.permissionPresets
    if (service === undefined) {
      throw new Error('field "permissions" needs the permissionPresets service, which this deployment does not compose')
    }
    if (!service.names.includes(permissions)) {
      throw new Error(
        `field "permissions" must be one of the preset names (${service.names.join(', ')}); got "${permissions}"`,
      )
    }
    service.set(session, permissions)
    return
  }
  setSandboxMode(session, permissions.sandbox)
  setApprovalPolicy(session, permissions.approval)
}

/** Removable system-prompt-section disposer, keyed by member session id. */
const roleDisposers = new Map<string, () => void>()

/**
 * Install (or replace) a member's role section in its agent scope.
 *
 * The prior section for the same member is disposed and forgotten first, so a
 * live member reconfigured twice never collides with `systemPrompt.section`'s
 * duplicate-name rejection. When `sessionId` is omitted (a bare `buildSetup`
 * call outside onboarding) the disposer is not remembered — there is no later
 * reconfigure to pair with.
 *
 * @param sessionId - the member's session id, or `undefined` to skip the registry.
 * @param agentCtx - the member's agent-scoped context.
 * @param text - the role prose.
 */
export function setMemberRole(sessionId: string | undefined, agentCtx: Context, text: string): void {
  const systemPrompt = agentCtx.get('systemPrompt') as
    | { section(section: { name: string; order: number; text: string }): () => void }
    | undefined
  if (systemPrompt === undefined) {
    throw new Error('field "role" needs the systemPrompt service, which this deployment does not compose')
  }
  const prior = sessionId !== undefined ? roleDisposers.get(sessionId) : undefined
  if (prior !== undefined) {
    prior()
    if (sessionId !== undefined) roleDisposers.delete(sessionId)
  }
  const disposer = systemPrompt.section({ name: MEMBER_ROLE_SECTION, order: MEMBER_ROLE_ORDER, text })
  if (sessionId !== undefined) roleDisposers.set(sessionId, disposer)
}

/** Forget a member's role-section disposer (e.g. when its session is disposed). */
export function clearMemberRole(sessionId: string): void {
  roleDisposers.delete(sessionId)
}
