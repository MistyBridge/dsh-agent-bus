/**
 * Member reconfiguration (E4.4): the `reconfigure_member` tool's parser and
 * orchestrator.
 *
 * The problem it closes: a member created with the wrong role or permissions
 * had no one-click path — the model had to `cancel`/`recreate` the member,
 * and `reassign_task` only applies to tasks, not to a member's own
 * configuration. This tool lets the PM change a created member's role and
 * permissions in place, without rebuilding the session.
 *
 * It reuses the exact `create_member` semantics via {@link member-config}:
 * the same permission grammar (preset name or explicit {sandbox, approval}
 * knobs) and the same write path (`permissionPresets.set` /
 * `setSandboxMode` / `setApprovalPolicy`), plus the same role-section
 * contract (one name/order, `systemPrompt.section`).
 *
 * The change takes effect on the member's next turn (a live member) or next
 * load (a dormant member is woken first, then configured; waking keeps it
 * live for the process lifetime). Skill reconfiguration is deferred this
 * phase — the skill registry is first-wins per layer, so re-registering a
 * name would not replace the mounted skill; it is documented as a deliberate
 * gap rather than a silent no-op.
 *
 * The orchestrator speaks to the harness through a structural {@link
 * ReconfigureMemberHost} port so unit tests drive it with mocks; the tool
 * wires the live services in `tools.ts`.
 *
 * @module dsh-agent-bus/reconfigure-member
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  applyPermissions,
  parsePermissions,
  type PermissionPresetHost,
  type PermissionKnobs,
} from './member-config.ts'

/** The JSON input `reconfigure_member` accepts (mirrors the tool parameter schema). */
export interface ReconfigureInput {
  /** The member session id (peer id from list_peers). */
  readonly member_id: string
  /** Replacement role/persona prose injected as a system-prompt section. */
  readonly role?: string
  /** Replacement permission preset name or {sandbox, approval} knobs. */
  readonly permissions?: string | PermissionKnobs
}

/** The parsed reconfiguration plan the orchestrator drives. */
export interface ReconfigurePlan {
  readonly memberId: string
  readonly role?: string
  readonly permissions?: string | PermissionKnobs
}

/** Parser outcome: a validated plan, or a field-naming refusal. */
export type ReconfigureParseResult =
  | { readonly ok: true; readonly plan: ReconfigurePlan }
  | { readonly ok: false; readonly error: string }

/**
 * The structural host port the orchestrator drives. Unit tests supply mocks;
 * `tools.ts` wires the live harness services. `setRole` is absent when the
 * deployment composes no systemPrompt service — a role change then refuses.
 */
export interface ReconfigureMemberHost {
  /** Resolve the member to a live agent; `resume` wakes a dormant member. */
  readonly agents: {
    get(id: SessionId): Agent | undefined
    resume(id: SessionId): Promise<Agent | undefined>
  }
  /** Absent when the deployment composes no permission-presets service. */
  readonly permissionPresets?: PermissionPresetHost
  /** Replace the member's role section in its agent scope; absent → role changes refuse. */
  readonly setRole?: (member: Agent, text: string) => void
}

/** The reconfiguration result returned to the caller. */
export interface ReconfigureResult {
  readonly memberId: string
  /** The executed steps (role / permissions), in order. */
  readonly steps: string[]
}

function refusal(error: string): ReconfigureParseResult {
  return { ok: false, error }
}

/**
 * Validate one raw `reconfigure_member` argument object into a plan.
 *
 * Every refusal names the offending field. `member_id` is required; `role` and
 * `permissions` are optional, but at least one must be present for the
 * orchestration step to have something to change. `skills` is deliberately
 * unsupported this phase (see the module doc) and is refused rather than
 * silently ignored.
 *
 * @param raw - the tool arguments, already schema-validated at the wire.
 * @returns a validated plan, or a refusal naming the field.
 */
export function parseReconfigureMemberInput(raw: unknown): ReconfigureParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refusal('reconfigure_member: input must be a JSON object')
  }
  const input = raw as Record<string, unknown>

  if (input.member_id === undefined) {
    return refusal('reconfigure_member: missing required field "member_id"')
  }
  if (typeof input.member_id !== 'string' || input.member_id.trim() === '') {
    return refusal('reconfigure_member: field "member_id" must be a non-empty string')
  }
  const memberId = input.member_id.trim()

  let role: string | undefined
  if (input.role !== undefined) {
    if (typeof input.role !== 'string') {
      return refusal('reconfigure_member: field "role" must be a string')
    }
    const trimmed = input.role.trim()
    if (trimmed === '') {
      return refusal('reconfigure_member: field "role" must be a non-empty string')
    }
    role = trimmed
  }

  // Skills reconfiguration is deferred this phase (see the module doc). A
  // caller that passes it is told explicitly rather than given a silent no-op.
  if (input.skills !== undefined) {
    return refusal('reconfigure_member: field "skills" is not supported yet; cancel/recreate the member to change skills')
  }

  let permissions: string | PermissionKnobs | undefined
  if (input.permissions !== undefined) {
    const parsed = parsePermissions(input.permissions)
    if (!parsed.ok) return refusal(`reconfigure_member: ${parsed.error}`)
    permissions = parsed.permissions
  }

  return {
    ok: true,
    plan: {
      memberId,
      ...(role !== undefined ? { role } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
    },
  }
}

/**
 * Drive the reconfiguration against the host port.
 *
 * Sequence: resolve the member to a live agent (waking a dormant one) →
 * replace role (if given) → replace permissions (if given). A member that is
 * neither live nor resumable refuses; a plan that changes nothing refuses.
 *
 * @param host - the host port (live services or test mocks).
 * @param plan - the validated plan from {@link parseReconfigureMemberInput}.
 * @returns the member id and the executed steps.
 */
export async function reconfigureMember(
  host: ReconfigureMemberHost,
  plan: ReconfigurePlan,
): Promise<ReconfigureResult> {
  if (plan.role === undefined && plan.permissions === undefined) {
    throw new Error('reconfigure_member: nothing to change; provide role and/or permissions')
  }
  const memberId = plan.memberId as SessionId
  const member = host.agents.get(memberId) ?? (await host.agents.resume(memberId))
  if (member === undefined) {
    throw new Error(`reconfigure_member: member "${plan.memberId}" could not be resolved (session is not live and cannot be woken)`)
  }

  const steps: string[] = []
  if (plan.role !== undefined) {
    if (host.setRole === undefined) {
      throw new Error('reconfigure_member: field "role" needs the systemPrompt service, which this deployment does not compose')
    }
    host.setRole(member, plan.role)
    steps.push('role')
  }
  if (plan.permissions !== undefined) {
    applyPermissions(host, member.session, plan.permissions)
    steps.push('permissions')
  }

  return { memberId: plan.memberId, steps }
}
