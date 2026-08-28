/**
 * create_member(决策5 成员入职)单测。
 *
 * 覆盖三块:
 * - 解析器(parseCreateMemberInput):缺必填字段/非法值报错并指明字段;
 *   modules/mcp 为预留/降级字段,接受且只产生 warning,绝不报错。
 * - 入职流程(onboardMember,mock HostPort 驱动):调用序列
 *   create → attach → rename → permissions → card → flow 断言;
 *   setup 注入(基线 preset、role section、skills register)断言;
 *   workspace 按 id/路径解析;mcp/modules warning 透传。
 * - 失败回滚:create 之后任一步抛错 → dispose 被调、错误含步骤/sessionId/
 *   「rolled back」;create 自身抛错 → 官方回滚、dispose 不被调。
 * - 并发去重:同 (workspaceId, name) 并发入职共享一次 create。
 * - 真实 ledger 集成:卡片写入与 flow 解析走 in-memory 域。
 *
 * @module tests/create-member
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PERSONA_ORDER } from '@deepseek-ai/dsh-system-prompt'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  buildSetup,
  MEMBER_ROLE_SECTION,
  onboardMember,
  parseCreateMemberInput,
  type CreateMemberHost,
  type OnboardPlan,
  type SkillSpec,
} from '../src/create-member.ts'
import { TaskLedger } from '../src/ledger/ledger.ts'
import {
  createMemoryCtx,
  makeFlow,
  SESSION_A,
  WORKSPACE,
} from './helpers/memory-ctx.ts'

/** 固定 uuid 形工作区 id(按 id 解析路径的分支)。 */
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

/** 最小 live session 替身:append 记录事件类型,供 setSandboxMode/setApprovalPolicy 观察。 */
interface FakeSession {
  readonly id: SessionId
  readonly events: string[]
  append(type: string): void
}

function fakeSession(id = 'session-new'): FakeSession & Session {
  const events: string[] = []
  const session = {
    id: id as SessionId,
    events,
    append: (type: string): void => {
      events.push(type)
    },
  }
  return session as FakeSession & Session
}

/** 最小 agentCtx 替身:get() 按名返回 systemPrompt/skills 存根。 */
function fakeAgentCtx(): Context & {
  readonly section: ReturnType<typeof vi.fn>
  readonly registerSkill: ReturnType<typeof vi.fn>
} {
  const section = vi.fn(() => () => {})
  const registerSkill = vi.fn(() => () => {})
  const ctx = {
    get: (name: string): unknown => {
      if (name === 'systemPrompt') return { section }
      if (name === 'skills') return { register: registerSkill }
      return undefined
    },
    section,
    registerSkill,
  }
  return ctx as unknown as Context & {
    readonly section: typeof section
    readonly registerSkill: typeof registerSkill
  }
}

/** 构造一个 mock HostPort,记录调用序列与 create 入参。 */
function makeHost(overrides: Partial<CreateMemberHost> = {}) {
  const calls: string[] = []
  let createdSessionId: string | undefined
  let lastSetup: ((ctx: Context) => unknown) | undefined
  let lastSession: FakeSession | undefined

  const dispose = vi.fn(async () => {})
  const attach = vi.fn(async () => {
    calls.push('attach')
  })
  const rename = vi.fn(() => {
    calls.push('rename')
  })
  const presetSet = vi.fn(() => {
    calls.push('preset')
  })
  const putCard = vi.fn(async () => {
    calls.push('card')
  })
  const getFlow = vi.fn(() => undefined)
  const listFlows = vi.fn(() => [])
  const mount = vi.fn(async () => {})
  const workspaceGet = vi.fn((id: string) => (id === WORKSPACE_ID ? workspace : undefined))
  const workspaceResolve = vi.fn(async (path: string) => (path === WORKSPACE ? workspace : undefined))
  const create = vi.fn(async (options: {
    sessionId: SessionId
    meta?: { cwd?: string; agentPreset?: string }
    setup?: (ctx: Context) => unknown
  }) => {
    calls.push('create')
    createdSessionId = String(options.sessionId)
    lastSetup = options.setup
    const session = fakeSession(String(options.sessionId))
    lastSession = session
    return { agent: { session }, dispose }
  })

  const workspace = { id: WORKSPACE_ID, path: WORKSPACE, attachSession: attach }
  const host = {
    workspaceRegistry: { get: workspaceGet, resolveByPath: workspaceResolve },
    agents: { create },
    sessionTitle: { rename },
    permissionPresets: { names: ['workspace-write', 'danger-full-access'], set: presetSet },
    agentPresets: { defaultId: 'cordis', mount },
    ledger: { putCard, getFlow, listFlows },
    ...overrides,
  } as unknown as CreateMemberHost

  return {
    host,
    calls,
    create,
    attach,
    rename,
    presetSet,
    putCard,
    getFlow,
    listFlows,
    dispose,
    mount,
    workspaceGet,
    workspaceResolve,
    createdSessionId: (): string | undefined => createdSessionId,
    lastSetup: (): ((ctx: Context) => unknown) | undefined => lastSetup,
    lastSession: (): FakeSession | undefined => lastSession,
  }
}

/** 构造一个最小 OnboardPlan。 */
function plan(overrides: Partial<OnboardPlan> = {}): OnboardPlan {
  return {
    workspace: WORKSPACE,
    name: 'Member',
    warnings: [],
    ...overrides,
  }
}

/** 一个合法技能定义。 */
function skill(name = 'research', content = 'body'): SkillSpec {
  return { name, description: `desc ${name}`, content }
}

describe('parseCreateMemberInput', () => {
  it('refuses non-object input', () => {
    for (const raw of ['x', 42, null, [1]]) {
      const result = parseCreateMemberInput(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('JSON object')
    }
  })

  it('refuses a missing workspace, naming the field', () => {
    const result = parseCreateMemberInput({ name: 'M' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"workspace"')
  })

  it('fills an omitted workspace from the caller default, trimming it', () => {
    const result = parseCreateMemberInput({ name: 'M' }, '  /caller-workspace  ')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.workspace).toBe('/caller-workspace')
  })

  it('still refuses an omitted workspace when no caller default is available', () => {
    const result = parseCreateMemberInput({ name: 'M' }, '   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"workspace"')
  })

  it('refuses a missing name, naming the field', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"name"')
  })

  it('refuses empty or whitespace workspace', () => {
    const result = parseCreateMemberInput({ workspace: '  ', name: 'M' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"workspace"')
  })

  it('refuses empty or whitespace name', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: ' ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"name"')
  })

  it('refuses an over-long name (session title is capped at 20 chars)', () => {
    const over = parseCreateMemberInput({ workspace: WORKSPACE, name: 'x'.repeat(21) })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('"name"')
    const atLimit = parseCreateMemberInput({ workspace: WORKSPACE, name: 'x'.repeat(20) })
    expect(atLimit.ok).toBe(true)
  })

  it('refuses a non-string role', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: 'M', role: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"role"')
  })

  it('refuses a non-array skills field', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: 'M', skills: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"skills"')
  })

  it('refuses a non-object skill item, naming its index', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: 'M', skills: ['x'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('skills[0]')
  })

  it('refuses a skill item with only content but no description', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      skills: [{ name: 'a', content: 'body' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/both description and content.*or neither/)
  })

  it('accepts a name-only skill reference (neither description nor content), to be resolved by name at onboarding', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      skills: [{ name: 'existing-skill' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.skills).toEqual([{ name: 'existing-skill' }])
  })

  it('refuses an empty preset-name permission', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: 'M', permissions: '  ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"permissions"')
  })

  it('refuses an invalid sandbox knob, naming the field', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      permissions: { sandbox: 'full', approval: 'ask' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('permissions.sandbox')
  })

  it('refuses an invalid approval knob, naming the field', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      permissions: { sandbox: 'workspace-write', approval: 'maybe' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('permissions.approval')
  })

  it('refuses permissions that are neither a string nor an object', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: 'M', permissions: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"permissions"')
  })

  it('refuses an over-long description, naming the field', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      description: 'x'.repeat(201),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"description"')
  })

  it('refuses an empty flow', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: 'M', flow: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"flow"')
  })

  it('accepts modules with a notice, never an error', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      modules: [{ key: 'value' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.warnings.some(w => w.includes('modules'))).toBe(true)
    expect(result.plan.warnings.some(w => w.includes('reserved'))).toBe(true)
  })

  it('accepts mcp with a notice, never an error', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      mcp: { server: 'x' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.warnings.some(w => w.includes('mcp'))).toBe(true)
  })

  it('parses the minimal required input', () => {
    const result = parseCreateMemberInput({ workspace: WORKSPACE, name: 'M' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.workspace).toBe(WORKSPACE)
    expect(result.plan.name).toBe('M')
    expect(result.plan.warnings).toEqual([])
    expect(result.plan.role).toBeUndefined()
    expect(result.plan.skills).toBeUndefined()
    expect(result.plan.permissions).toBeUndefined()
    expect(result.plan.flow).toBeUndefined()
  })

  it('parses a full input with every optional field', () => {
    const result = parseCreateMemberInput({
      workspace: WORKSPACE,
      name: 'M',
      role: 'analyst',
      skills: [skill()],
      permissions: { sandbox: 'read-only', approval: 'never' },
      flow: 'flow-1',
      description: 'card text',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.role).toBe('analyst')
    expect(result.plan.skills).toEqual([{ name: 'research', description: 'desc research', content: 'body' }])
    expect(result.plan.permissions).toEqual({ sandbox: 'read-only', approval: 'never' })
    expect(result.plan.flow).toBe('flow-1')
    expect(result.plan.description).toBe('card text')
  })

  it('trims whitespace-padded required fields', () => {
    const result = parseCreateMemberInput({ workspace: ' /w ', name: '  M  ' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.workspace).toBe('/w')
    expect(result.plan.name).toBe('M')
  })
})

describe('onboardMember', () => {
  it('runs the full sequence create → attach → rename → preset → card → flow', async () => {
    const m = makeHost()
    m.getFlow.mockImplementation((id: string) => {
      m.calls.push('flow')
      return id === 'flow-1' ? makeFlow({ id: 'flow-1', name: 'Flow' }) : undefined
    })
    const result = await onboardMember(m.host, plan({
      role: 'analyst',
      skills: [skill()],
      permissions: 'workspace-write',
      flow: 'flow-1',
    }))
    expect(m.calls).toEqual(['create', 'attach', 'rename', 'preset', 'card', 'flow'])
    expect(result.steps).toEqual([
      'create-session', 'role', 'skills', 'attach-workspace', 'rename',
      'permissions', 'capability-card', 'flow',
    ])
    expect(result.flow).toEqual({ id: 'flow-1', name: 'Flow' })
    expect(result.workspaceId).toBe(WORKSPACE_ID)
    expect(result.workspacePath).toBe(WORKSPACE)
    expect(result.name).toBe('Member')
  })

  it('passes the workspace path as cwd and records the default preset', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan())
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: WORKSPACE, agentPreset: 'cordis' },
    }))
  })

  it('injects role and skills through the captured setup', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan({ role: 'analyst', skills: [skill('a'), skill('b')] }))
    const setup = m.lastSetup()
    expect(setup).toBeDefined()
    const agentCtx = fakeAgentCtx()
    await setup!(agentCtx)
    expect(agentCtx.section).toHaveBeenCalledWith({
      name: MEMBER_ROLE_SECTION,
      order: PERSONA_ORDER + 1,
      text: 'analyst',
    })
    expect(agentCtx.registerSkill).toHaveBeenNthCalledWith(1, { name: 'a', description: 'desc a', content: 'body', source: 'runtime' })
    expect(agentCtx.registerSkill).toHaveBeenNthCalledWith(2, { name: 'b', description: 'desc b', content: 'body', source: 'runtime' })
    // 基线 preset 在 setup 内先 mount。
    expect(m.mount).toHaveBeenCalledTimes(1)
  })

  it('attaches the created session id to the workspace', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan())
    expect(m.attach).toHaveBeenCalledWith(m.createdSessionId())
  })

  it('renames the created session with the plan name', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan({ name: 'Analyst One' }))
    expect(m.rename).toHaveBeenCalledWith(expect.objectContaining({ id: m.createdSessionId() }), 'Analyst One')
  })

  it('applies a preset-name permission through permissionPresets.set', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan({ permissions: 'danger-full-access' }))
    expect(m.presetSet).toHaveBeenCalledWith(expect.objectContaining({ id: m.createdSessionId() }), 'danger-full-access')
  })

  it('applies explicit sandbox/approval knobs through the session log', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan({
      permissions: { sandbox: 'read-only', approval: 'never' },
    }))
    const session = m.lastSession()
    expect(session?.events).toEqual(['sandbox/mode', 'approval/policy'])
    expect(m.presetSet).not.toHaveBeenCalled()
  })

  it('writes the capability card with the plan description', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan({ description: 'card text' }))
    expect(m.putCard).toHaveBeenCalledWith(m.createdSessionId(), expect.objectContaining({
      description: 'card text',
      capabilities: [],
    }))
  })

  it('skips permissions when none are given', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan())
    expect(m.presetSet).not.toHaveBeenCalled()
    expect(m.lastSession()?.events).toEqual([])
  })

  it('skips flow when none is given', async () => {
    const m = makeHost()
    const result = await onboardMember(m.host, plan())
    expect(m.getFlow).not.toHaveBeenCalled()
    expect(result.flow).toBeUndefined()
  })

  it('resolves a workspace by id (uuid-looking value)', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan({ workspace: WORKSPACE_ID }))
    expect(m.workspaceGet).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(m.workspaceResolve).not.toHaveBeenCalled()
  })

  it('resolves a workspace by path', async () => {
    const m = makeHost()
    await onboardMember(m.host, plan({ workspace: WORKSPACE }))
    expect(m.workspaceResolve).toHaveBeenCalledWith(WORKSPACE)
  })

  it('refuses an unknown workspace, naming the field, without creating', async () => {
    const m = makeHost()
    await expect(onboardMember(m.host, plan({ workspace: '/nowhere' }))).rejects.toThrow(/workspace/)
    expect(m.create).not.toHaveBeenCalled()
  })

  it('forwards parser warnings into the result', async () => {
    const m = makeHost()
    const result = await onboardMember(m.host, plan({ warnings: ['mcp notice', 'modules notice'] }))
    expect(result.warnings).toEqual(['mcp notice', 'modules notice'])
  })

  it('falls back to bare composition when no agent-presets service exists', async () => {
    const m = makeHost({ agentPresets: undefined })
    await onboardMember(m.host, plan())
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: WORKSPACE },
    }))
  })
})

describe('onboardMember rollback', () => {
  it('disposes the created session when attach fails', async () => {
    const m = makeHost()
    m.attach.mockRejectedValueOnce(new Error('boom'))
    const error = await onboardMember(m.host, plan()).catch((caught: unknown) => caught)
    expect(String(error)).toContain('attach-workspace')
    expect(String(error)).toContain('rolled back')
    expect(String(error)).toContain(m.createdSessionId() ?? '')
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes when rename fails', async () => {
    const m = makeHost()
    m.rename.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const error = await onboardMember(m.host, plan()).catch((caught: unknown) => caught)
    expect(String(error)).toContain('rename')
    expect(String(error)).toContain('rolled back')
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes when permission set fails', async () => {
    const m = makeHost()
    m.presetSet.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const error = await onboardMember(m.host, plan({ permissions: 'workspace-write' })).catch(
      (caught: unknown) => caught,
    )
    expect(String(error)).toContain('permissions')
    expect(String(error)).toContain('rolled back')
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes when the capability card write fails', async () => {
    const m = makeHost()
    m.putCard.mockRejectedValueOnce(new Error('boom'))
    const error = await onboardMember(m.host, plan()).catch((caught: unknown) => caught)
    expect(String(error)).toContain('capability-card')
    expect(String(error)).toContain('rolled back')
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown flow, naming the field, and rolls back', async () => {
    const m = makeHost()
    const error = await onboardMember(m.host, plan({ flow: 'nope' })).catch((caught: unknown) => caught)
    expect(String(error)).toContain('flow')
    expect(String(error)).toContain('rolled back')
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses a flow from another workspace', async () => {
    const m = makeHost()
    m.getFlow.mockReturnValue(makeFlow({ id: 'other', workspacePath: '/elsewhere' }))
    const error = await onboardMember(m.host, plan({ flow: 'other' })).catch((caught: unknown) => caught)
    expect(String(error)).toContain('another workspace')
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not dispose when create itself fails (the factory rolls back)', async () => {
    const m = makeHost()
    m.create.mockRejectedValue(new Error('create boom'))
    const error = await onboardMember(m.host, plan()).catch((caught: unknown) => caught)
    expect(String(error)).toContain('create-session')
    expect(String(error)).toContain('nothing was created')
    expect(m.dispose).not.toHaveBeenCalled()
  })

  it('reports a dispose failure alongside the rollback note', async () => {
    const m = makeHost()
    m.attach.mockRejectedValueOnce(new Error('boom'))
    m.dispose.mockRejectedValueOnce(new Error('dispose boom'))
    const error = await onboardMember(m.host, plan()).catch((caught: unknown) => caught)
    expect(String(error)).toContain('rolled back')
    expect(String(error)).toContain('dispose also failed')
  })
})

describe('onboardMember setup guards', () => {
  it('fails loud when the systemPrompt service is absent (role requested)', async () => {
    const m = makeHost()
    const setup = buildSetup(m.host, plan({ role: 'analyst' }))
    await expect(setup({ get: () => undefined } as unknown as Context)).rejects.toThrow(/systemPrompt/)
  })

  it('fails loud when the skills service is absent (skills requested)', async () => {
    const m = makeHost()
    const setup = buildSetup(m.host, plan({ skills: [skill()] }))
    await expect(setup({ get: () => undefined } as unknown as Context)).rejects.toThrow(/skills/)
  })

  it('refuses an invalid skill name during buildSetup preflight', () => {
    const m = makeHost()
    expect(() => buildSetup(m.host, plan({
      skills: [{ name: 'Bad Name', description: 'shows', content: 'body' }],
    }))).toThrow(/kebab-case/)
  })

  it('refuses an invalid skill name at create_member time, creating nothing', async () => {
    const m = makeHost()
    const error = await onboardMember(m.host, plan({
      skills: [{ name: 'Bad Name', description: 'shows', content: 'body' }],
    })).catch((caught: unknown) => caught)
    expect(String(error)).toContain('create-session')
    expect(String(error)).toContain('nothing was created')
    expect(m.create).not.toHaveBeenCalled()
  })

  it('resolves a name-only skill reference through the skills service during setup', async () => {
    const skills = { get: vi.fn(async (name: string) =>
      name === 'existing-skill' ? { description: 'from catalog', content: 'catalog body' } : undefined) }
    const m = makeHost({ skills: skills as unknown as CreateMemberHost['skills'] })
    // The reference is registered with the catalog body and source pinned.
    const ctx = fakeAgentCtx()
    await buildSetup(m.host, plan({ skills: [{ name: 'existing-skill' }] }))(ctx)
    expect(skills.get).toHaveBeenCalledWith('existing-skill')
    expect(ctx.registerSkill).toHaveBeenCalledWith({ name: 'existing-skill', description: 'from catalog', content: 'catalog body', source: 'runtime' })
  })

  it('refuses a name-only reference to a skill that does not exist', async () => {
    const skills = { get: vi.fn(async () => undefined) }
    const m = makeHost({ skills: skills as unknown as CreateMemberHost['skills'] })
    const setup = buildSetup(m.host, plan({ skills: [{ name: 'missing-skill' }] }))
    await expect(setup(fakeAgentCtx())).rejects.toThrow(/no such skill/)
  })
})

describe('onboardMember concurrency', () => {
  it('single-flights concurrent onboarding of the same workspace+name', async () => {
    const m = makeHost()
    const [left, right] = await Promise.all([
      onboardMember(m.host, plan()),
      onboardMember(m.host, plan()),
    ])
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(left.sessionId).toBe(right.sessionId)
  })
})

describe('onboardMember with a real in-memory ledger', () => {
  it('writes the card and resolves the flow through the ledger', async () => {
    const harness = await createMemoryCtx()
    const ledger = await TaskLedger.open(harness.ctx)
    try {
      await ledger.createFlow('flow-1', 'Flow', undefined, SESSION_A, WORKSPACE)
      const m = makeHost({ ledger: ledger as unknown as CreateMemberHost['ledger'] })
      const result = await onboardMember(m.host, plan({
        description: 'card text',
        flow: 'flow-1',
      }))
      expect(result.flow).toEqual({ id: 'flow-1', name: 'Flow' })
      const card = ledger.getCard(result.sessionId as SessionId)
      expect(card?.description).toBe('card text')
    } finally {
      await harness.dispose()
    }
  })
})
