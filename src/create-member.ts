/**
 * Member onboarding (decision 5): the `create_member` tool's parser and
 * orchestrator.
 *
 * One JSON call turns a workspace + name into a full team member: a session
 * bound to the workspace, a title, a baseline composition (the deployment's
 * default agent preset when one exists), an optional persona-style role
 * section and runtime skills, explicit permissions, a capability card, and an
 * optional flow membership. Any step after the session exists rolls the
 * created agent back through `AgentHandle.dispose()` so a failed onboarding
 * never leaves a half-baked member behind.
 *
 * Two deliberate degradations, documented here and surfaced as result
 * warnings rather than errors:
 * - `mcp` (a configuration row in the harness, one server per instance) has
 *   no runtime registration API — programmatic injection would require
 *   authoring a preset composition file, which is out of scope. The schema
 *   accepts the field and the parser ignores it with a notice.
 * - `modules` is the reserved extension point for per-session dsh module
 *   customization. It is declared in the input schema but not implemented
 *   (pending dsh-side capability confirmation); the parser ignores it with a
 *   notice.
 *
 * The orchestrator speaks to the harness through a structural {@link
 * CreateMemberHost} port so unit tests drive it with mocks and assert the
 * exact call sequence; the tool wires the live services in `tools.ts`.
 *
 * @module dsh-agent-bus/create-member
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { PERSONA_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { setSandboxMode, SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'
import type { FlowRecord, PeerCard } from './types.ts'

/** The sandbox modes the harness supports, in declaration order. */
export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** The approval policies the harness supports, in declaration order. */
export type ApprovalPolicy = 'ask' | 'never'

/** One runtime skill definition the new member mounts in its own scope. */
export interface SkillSpec {
  /** Kebab-case skill identifier (the skill tool addresses skills by name). */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Markdown instruction body. */
  readonly content: string
}

/** Explicit permission knobs, an alternative to naming a preset. */
export interface PermissionKnobs {
  readonly sandbox: SandboxMode
  readonly approval: ApprovalPolicy
}

/** The JSON input `create_member` accepts (mirrors the tool parameter schema). */
export interface CreateMemberInput {
  /** Workspace path or id the new member is bound to. */
  readonly workspace: string
  /** Session name (title), required. */
  readonly name: string
  /** Role/persona prose injected as a system-prompt section. */
  readonly role?: string
  /** Runtime skill definitions mounted into the member's scope. */
  readonly skills?: readonly SkillSpec[]
  /** MCP configuration; accepted but not injectable programmatically (degraded). */
  readonly mcp?: unknown
  /** Preset name or explicit {sandbox, approval} knobs. */
  readonly permissions?: string | PermissionKnobs
  /** Flow id or name to join, resolved within the target workspace. */
  readonly flow?: string
  /** Capability-card description (≤200 characters). */
  readonly description?: string
  /** Reserved extension point; ignored this phase. */
  readonly modules?: unknown
}

/** The parsed onboarding plan the orchestrator drives. */
export interface OnboardPlan {
  readonly workspace: string
  readonly name: string
  readonly role?: string
  readonly skills?: readonly SkillSpec[]
  readonly permissions?: string | PermissionKnobs
  readonly flow?: string
  readonly description?: string
  /** Non-fatal notices accumulated during parsing (mcp / modules). */
  readonly warnings: readonly string[]
  /** Model for the created agent, resolved from the caller; supplies `{{model}}`. */
  readonly model?: string
}

/** Parser outcome: a validated plan, or a field-naming refusal. */
export type ParseResult =
  | { readonly ok: true; readonly plan: OnboardPlan }
  | { readonly ok: false; readonly error: string }

/** The onboarding result returned to the caller. */
export interface OnboardResult {
  readonly sessionId: string
  readonly name: string
  readonly workspaceId: string
  readonly workspacePath: string
  /** Executed steps in order (create-session, role, skills, attach-workspace, rename, permissions, capability-card, flow). */
  readonly steps: string[]
  /** Degradation notices (mcp / modules). */
  readonly warnings: string[]
  /** Present when the member joined a flow. */
  readonly flow?: { readonly id: string; readonly name: string }
}

/** Minimal workspace face the orchestrator needs. */
export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  attachSession(sessionId: SessionId): Promise<void>
}

/** Minimal agent-presets face used for the baseline composition. */
export interface PresetMountHost {
  readonly defaultId: string
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Minimal permission-presets face used for preset-name permissions. */
export interface PermissionPresetHost {
  readonly names: readonly string[]
  set(session: Session, name: string): void
}

/**
 * The structural host port the orchestrator drives. Unit tests supply mocks;
 * `tools.ts` wires the live harness services. Every member is optional except
 * the core creation/binding/naming/card chain.
 */
export interface CreateMemberHost {
  readonly workspaceRegistry: {
    get(id: string): WorkspaceLike | undefined
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  }
  readonly agents: {
    create(options: CreateAgentOptions): Promise<AgentHandle>
  }
  readonly sessionTitle: {
    rename(session: Session, title: string): unknown
  }
  /** Absent when the deployment composes no permission-presets service. */
  readonly permissionPresets?: PermissionPresetHost
  /** Absent when the deployment composes no agent-presets service. */
  readonly agentPresets?: PresetMountHost
  readonly ledger: {
    putCard(sessionId: SessionId, card: PeerCard): Promise<void>
    getFlow(id: string): FlowRecord | undefined
    listFlows(): FlowRecord[]
  }
}

/**
 * The system-prompt section that carries the member's role. A dedicated name
 * (not the persona section) so layering over a default preset that already
 * installed a persona cannot collide — `systemPrompt.section` rejects
 * duplicate names within one scope layer.
 */
export const MEMBER_ROLE_SECTION = 'agent-bus:member-role'

/** Order of the role section: directly after the persona section. */
const MEMBER_ROLE_ORDER = PERSONA_ORDER + 1

/** Length cap for the capability-card description, matching the peer card. */
const DESCRIPTION_MAX = 200

/** Workspace ids are uuids; anything else is treated as a path. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function refusal(error: string): ParseResult {
  return { ok: false, error }
}

/**
 * Validate one raw `create_member` argument object into an onboarding plan.
 *
 * Every refusal names the offending field; missing required fields and
 * invalid values fail, while the reserved `modules` and degraded `mcp` fields
 * are accepted with a notice so a caller that passes them is told what
 * happened instead of rejected.
 *
 * @param raw - the tool arguments, already schema-validated at the wire.
 * @returns a validated plan, or a refusal naming the field.
 */
export function parseCreateMemberInput(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refusal('create_member: input must be a JSON object')
  }
  const input = raw as Record<string, unknown>
  const warnings: string[] = []

  if (input.workspace === undefined) {
    return refusal('create_member: missing required field "workspace"')
  }
  if (typeof input.workspace !== 'string' || input.workspace.trim() === '') {
    return refusal('create_member: field "workspace" must be a non-empty string')
  }
  if (input.name === undefined) {
    return refusal('create_member: missing required field "name"')
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    return refusal('create_member: field "name" must be a non-empty string')
  }
  const nameTrimmed = input.name.trim()
  if (nameTrimmed.length > 20) {
    return refusal(`create_member: field "name" must be at most 20 characters; got ${nameTrimmed.length}`)
  }

  let role: string | undefined
  if (input.role !== undefined) {
    if (typeof input.role !== 'string') {
      return refusal('create_member: field "role" must be a string')
    }
    role = input.role.trim()
  }

  let skills: SkillSpec[] | undefined
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills)) {
      return refusal('create_member: field "skills" must be an array of skill definitions')
    }
    const parsed: SkillSpec[] = []
    for (let index = 0; index < input.skills.length; index += 1) {
      const item = input.skills[index]
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return refusal(`create_member: field "skills[${index}]" must be a skill definition object`)
      }
      const spec = item as Record<string, unknown>
      for (const key of ['name', 'description', 'content'] as const) {
        if (typeof spec[key] !== 'string' || (spec[key] as string).trim() === '') {
          return refusal(`create_member: field "skills[${index}].${key}" must be a non-empty string`)
        }
      }
      parsed.push({
        name: (spec.name as string).trim(),
        description: (spec.description as string).trim(),
        content: (spec.content as string).trim(),
      })
    }
    skills = parsed
  }

  let permissions: string | PermissionKnobs | undefined
  if (input.permissions !== undefined) {
    if (typeof input.permissions === 'string') {
      if (input.permissions.trim() === '') {
        return refusal('create_member: field "permissions" must be a non-empty preset name')
      }
      permissions = input.permissions.trim()
    } else if (typeof input.permissions === 'object' && input.permissions !== null && !Array.isArray(input.permissions)) {
      const knobs = input.permissions as Record<string, unknown>
      if (!SANDBOX_MODES.includes(knobs.sandbox as SandboxMode)) {
        return refusal(
          `create_member: field "permissions.sandbox" must be one of ${SANDBOX_MODES.join('|')}`,
        )
      }
      if (knobs.approval !== 'ask' && knobs.approval !== 'never') {
        return refusal('create_member: field "permissions.approval" must be one of ask|never')
      }
      permissions = { sandbox: knobs.sandbox as SandboxMode, approval: knobs.approval as 'ask' | 'never' }
    } else {
      return refusal('create_member: field "permissions" must be a preset name or a {sandbox, approval} object')
    }
  }

  let flow: string | undefined
  if (input.flow !== undefined) {
    if (typeof input.flow !== 'string' || input.flow.trim() === '') {
      return refusal('create_member: field "flow" must be a non-empty string')
    }
    flow = input.flow.trim()
  }

  let description: string | undefined
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      return refusal('create_member: field "description" must be a string')
    }
    const trimmed = input.description.trim()
    if (trimmed.length > DESCRIPTION_MAX) {
      return refusal(
        `create_member: field "description" is ${trimmed.length} characters, over the ${DESCRIPTION_MAX} limit`,
      )
    }
    description = trimmed
  }

  // Reserved / degraded fields: accepted, never fatal.
  if (input.modules !== undefined) {
    warnings.push('field "modules" is a reserved extension point (pending dsh-side capability confirmation); ignored this phase')
  }
  if (input.mcp !== undefined) {
    warnings.push('field "mcp": programmatic injection is not supported (requires preset-file authoring, pending dsh-side capability confirmation); skipped')
  }

  return {
    ok: true,
    plan: {
      workspace: input.workspace.trim(),
      name: input.name.trim(),
      ...(role !== undefined ? { role } : {}),
      ...(skills !== undefined && skills.length > 0 ? { skills } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(flow !== undefined ? { flow } : {}),
      ...(description !== undefined ? { description } : {}),
      warnings,
    },
  }
}

/**
 * Resolve a workspace by id (uuid-looking values) or canonical path.
 *
 * A path that cannot be realpathed (missing directory) resolves to `undefined`
 * so the caller reports it as "not found" rather than leaking a filesystem
 * error.
 *
 * @param registry - the workspace registry face.
 * @param value - workspace id or path.
 * @returns the resolved workspace, or `undefined` when unknown.
 */
async function resolveWorkspace(
  registry: CreateMemberHost['workspaceRegistry'],
  value: string,
): Promise<WorkspaceLike | undefined> {
  if (UUID_RE.test(value)) {
    const byId = registry.get(value)
    if (byId !== undefined) return byId
  }
  try {
    return await registry.resolveByPath(value)
  } catch {
    return undefined
  }
}

/**
 * Build the agent-factory `setup` that composes the member's scoped world.
 *
 * Composition order: the deployment's default agent preset (baseline tools
 * and persona, when the service exists — the bare fallback per the decision
 * 5 reconnaissance), then the role section, then the runtime skills. A
 * missing required service (systemPrompt for role, skills registry for
 * skills) fails loud inside setup, which rolls the whole creation back.
 *
 * @param host - the host port.
 * @param plan - the validated plan.
 * @returns the setup callback for `agents.create`.
 */
export function buildSetup(host: CreateMemberHost, plan: OnboardPlan): (agentCtx: Context) => Promise<void> {
  return async (agentCtx) => {
    if (host.agentPresets !== undefined) {
      await host.agentPresets.mount(agentCtx)
    }
    if (plan.role !== undefined) {
      const systemPrompt = agentCtx.get('systemPrompt') as
        | { section(section: { name: string; order: number; text: string }): () => void }
        | undefined
      if (systemPrompt === undefined) {
        throw new Error('create_member: field "role" needs the systemPrompt service, which this deployment does not compose')
      }
      systemPrompt.section({ name: MEMBER_ROLE_SECTION, order: MEMBER_ROLE_ORDER, text: plan.role })
    }
    if (plan.skills !== undefined && plan.skills.length > 0) {
      const skills = agentCtx.get('skills') as
        | { register(skill: SkillSpec): () => void }
        | undefined
      if (skills === undefined) {
        throw new Error('create_member: field "skills" needs the skills service, which this deployment does not compose')
      }
      for (const spec of plan.skills) {
        skills.register({ name: spec.name, description: spec.description, content: spec.content })
      }
    }
  }
}

/** Apply the member's permissions, overriding the creation-time default pin. */
function applyPermissions(
  host: CreateMemberHost,
  session: Session,
  permissions: string | PermissionKnobs,
): void {
  if (typeof permissions === 'string') {
    const service = host.permissionPresets
    if (service === undefined) {
      throw new Error('create_member: field "permissions" needs the permissionPresets service, which this deployment does not compose')
    }
    if (!service.names.includes(permissions)) {
      throw new Error(
        `create_member: field "permissions" must be one of the preset names (${service.names.join(', ')}); got "${permissions}"`,
      )
    }
    service.set(session, permissions)
    return
  }
  setSandboxMode(session, permissions.sandbox)
  setApprovalPolicy(session, permissions.approval)
}

/**
 * Resolve the flow to join, by id or by name within the target workspace.
 *
 * Flow membership is task-ownership semantics: a `FlowRecord` carries no
 * session list, so joining validates the flow and links the member as a
 * future task owner of that flow. Unknown flows refuse with the field named.
 *
 * @param ledger - the ledger face.
 * @param workspace - the target workspace.
 * @param value - flow id or name.
 * @returns the joined flow.
 */
function joinFlow(
  ledger: CreateMemberHost['ledger'],
  workspace: WorkspaceLike,
  value: string,
): FlowRecord {
  const byId = ledger.getFlow(value)
  if (byId !== undefined) {
    if (byId.workspacePath !== workspace.path) {
      throw new Error(`create_member: flow "${value}" belongs to another workspace (field "flow")`)
    }
    return byId
  }
  const byName = ledger.listFlows().find(
    flow => flow.name === value && flow.workspacePath === workspace.path,
  )
  if (byName === undefined) {
    throw new Error(`create_member: flow "${value}" does not exist in this workspace (field "flow")`)
  }
  return byName
}

/** Render one caught error for inclusion in an onboarding refusal. */
function describeCause(error: unknown): string {
  return error instanceof Error ? `original error: ${error.message}` : `original error: ${String(error)}`
}

/**
 * Single-flight table for concurrent onboarding of the same workspace+name:
 * two simultaneous `create_member` calls for the same member share one
 * creation instead of racing into two sessions. Keyed by the resolved
 * workspace id and the name; a settled flight (success or failure) is removed
 * so the next call retries afresh.
 */
const memberFlights = new Map<string, Promise<OnboardResult>>()

/**
 * Drive the full onboarding sequence against the host port.
 *
 * Sequence: resolve workspace → create session+agent (baseline composition,
 * role, skills inside `setup`) → attach the workspace → rename → permissions
 * → capability card → optional flow join. A failure anywhere after the
 * session exists disposes the created agent and refuses with the failed step,
 * the rolled-back session id, and the original error — no half-baked member
 * survives.
 *
 * @param host - the host port (live services or test mocks).
 * @param plan - the validated plan from {@link parseCreateMemberInput}.
 * @returns the created member's identity and executed steps.
 */
export async function onboardMember(host: CreateMemberHost, plan: OnboardPlan): Promise<OnboardResult> {
  const workspace = await resolveWorkspace(host.workspaceRegistry, plan.workspace)
  if (workspace === undefined) {
    throw new Error(`create_member: workspace "${plan.workspace}" not found (field "workspace")`)
  }

  const flightKey = `${workspace.id}\u0000${plan.name}`
  const inFlight = memberFlights.get(flightKey)
  if (inFlight !== undefined) {
    return await inFlight
  }
  const flight = runOnboarding(host, plan, workspace)
  memberFlights.set(flightKey, flight)
  try {
    return await flight
  } finally {
    if (memberFlights.get(flightKey) === flight) memberFlights.delete(flightKey)
  }
}

/** The actual onboarding run, guarded by the single-flight table. */
async function runOnboarding(
  host: CreateMemberHost,
  plan: OnboardPlan,
  workspace: WorkspaceLike,
): Promise<OnboardResult> {
  const warnings = [...plan.warnings]
  const steps: string[] = []

  const sessionId = randomUUID() as SessionId
  let handle: AgentHandle
  try {
    handle = await host.agents.create({
      sessionId,
      meta: {
        cwd: workspace.path,
        ...(host.agentPresets !== undefined ? { agentPreset: host.agentPresets.defaultId } : {}),
      },
      // `{{model}}` reads agent.options.model; without a value the persona
      // section fails to render, so pin the caller's model on the new agent.
      ...(plan.model !== undefined ? { agentOptions: { model: plan.model } } : {}),
      setup: buildSetup(host, plan),
    })
  } catch (error) {
    // A setup throw is rolled back entirely by the agent factory; there is no
    // partial session to compensate here.
    throw new Error(`create_member: step "create-session" failed; nothing was created (${describeCause(error)})`)
  }
  steps.push('create-session')
  if (plan.role !== undefined) steps.push('role')
  if (plan.skills !== undefined && plan.skills.length > 0) steps.push('skills')

  const session = handle.agent.session
  let flow: FlowRecord | undefined
  try {
    steps.push('attach-workspace')
    await workspace.attachSession(sessionId)

    steps.push('rename')
    host.sessionTitle.rename(session, plan.name)

    if (plan.permissions !== undefined) {
      steps.push('permissions')
      applyPermissions(host, session, plan.permissions)
    }

    steps.push('capability-card')
    await host.ledger.putCard(sessionId, {
      description: plan.description ?? '',
      capabilities: [],
      updatedAt: new Date().toISOString(),
    })

    if (plan.flow !== undefined) {
      steps.push('flow')
      flow = joinFlow(host.ledger, workspace, plan.flow)
    }
  } catch (error) {
    const step = steps[steps.length - 1] ?? 'create-session'
    let rollbackNote = ''
    try {
      await handle.dispose()
    } catch (disposeError) {
      rollbackNote = `; rollback dispose also failed: ${String(disposeError)}`
    }
    throw new Error(
      `create_member: step "${step}" failed; rolled back created session ${sessionId}${rollbackNote} (${describeCause(error)})`,
    )
  }

  return {
    sessionId: String(sessionId),
    name: plan.name,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    steps,
    warnings,
    ...(flow !== undefined ? { flow: { id: flow.id, name: flow.name } } : {}),
  }
}
