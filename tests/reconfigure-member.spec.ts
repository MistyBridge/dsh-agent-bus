/**
 * reconfigure_member (E4.4 成员改配)单测。
 *
 * 覆盖三块:
 * - 解析器(parseReconfigureMemberInput):缺必填/非法值报错并指明字段;
 *   member_id 必填;role 可选但须非空;permissions 与 create_member 同语法
 *   (preset 名或 {sandbox, approval} 旋钮);skills 本期明确拒绝(说明原因)。
 * - 改配流程(reconfigureMember,mock HostPort 驱动):成员解析(在线 /
 *   dormant 唤醒 / 不可唤醒拒绝)、role 经 setRole、permissions 经
 *   applyPermissions(旋钮写会话日志 / preset 名写 permissionPresets.set)、
 *   步骤序列、无可改项拒绝、缺 systemPrompt / permissionPresets 拒。
 * - 与 create_member 的复用:permissions 语法与写入走同一
 *   member-config(parsePermissions / applyPermissions)helper。
 *
 * @module tests/reconfigure-member
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  parseReconfigureMemberInput,
  reconfigureMember,
  type ReconfigureMemberHost,
  type ReconfigurePlan,
} from '../src/reconfigure-member.ts'
import { setMemberRole } from '../src/member-config.ts'

/** 最小 live-session 替身:append 记录事件类型,供 setSandboxMode/setApprovalPolicy 观察。 */
interface FakeSession {
  readonly id: SessionId
  readonly events: string[]
  append(type: string): void
}

function fakeSession(id: string): FakeSession & Session {
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

/** 最小 agent-ctx 替身:get('systemPrompt') 返回记录 section 调用的存根。 */
function fakeAgentCtx(record: { sections: Array<Record<string, unknown>> }): Context {
  const section = (value: Record<string, unknown>) => {
    record.sections.push(value)
    return () => {}
  }
  return {
    get: (name: string): unknown => name === 'systemPrompt' ? { section } : undefined,
  } as unknown as Context
}

/** 构造一个 mock 成员 Agent(带可 append 的 session 与可注入的 ctx)。 */
function makeMember(
  id: string,
  record: { sections: Array<Record<string, unknown>> },
): Agent {
  const session = fakeSession(id)
  const member = {
    id: id as SessionId,
    session,
    ctx: fakeAgentCtx(record),
  }
  return member as unknown as Agent
}

/** 构造一个 mock HostPort,记录调用序列。 */
function makeHost(overrides: Partial<ReconfigureMemberHost> = {}) {
  const sectionRecord: { sections: Array<Record<string, unknown>> } = { sections: [] }
  const setRole = vi.fn(() => {
    sectionRecord.sections.push({ kind: 'setRole' })
  })
  const presetSet = vi.fn(() => {})
  const host: ReconfigureMemberHost = {
    agents: {
      get: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    },
    permissionPresets: { names: ['workspace-write', 'danger-full-access'], set: presetSet },
    setRole,
    ...overrides,
  }
  return {
    host,
    sectionRecord,
    setRole,
    presetSet,
    makeMember: (id: string) => makeMember(id, sectionRecord),
  }
}

function plan(overrides: Partial<ReconfigurePlan> = {}): ReconfigurePlan {
  return { memberId: 'member-1', ...overrides }
}

describe('parseReconfigureMemberInput', () => {
  it('refuses non-object input', () => {
    for (const raw of ['x', 42, null, [1]]) {
      const result = parseReconfigureMemberInput(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('JSON object')
    }
  })

  it('refuses a missing member_id, naming the field', () => {
    const result = parseReconfigureMemberInput({ role: 'analyst' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"member_id"')
  })

  it('refuses an empty or non-string member_id', () => {
    for (const value of ['', '   ', 42]) {
      const result = parseReconfigureMemberInput({ member_id: value })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('"member_id"')
    }
  })

  it('refuses a non-string role', () => {
    const result = parseReconfigureMemberInput({ member_id: 'm', role: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"role"')
  })

  it('refuses an empty role', () => {
    const result = parseReconfigureMemberInput({ member_id: 'm', role: '  ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"role"')
  })

  it('refuses an invalid permissions value, naming the field', () => {
    const result = parseReconfigureMemberInput({ member_id: 'm', permissions: '  ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"permissions"')
  })

  it('refuses an invalid sandbox knob, naming the field', () => {
    const result = parseReconfigureMemberInput({
      member_id: 'm',
      permissions: { sandbox: 'full', approval: 'ask' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('permissions.sandbox')
  })

  it('refuses an invalid approval knob, naming the field', () => {
    const result = parseReconfigureMemberInput({
      member_id: 'm',
      permissions: { sandbox: 'workspace-write', approval: 'maybe' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('permissions.approval')
  })

  it('refuses skills as unsupported this phase, naming the field', () => {
    const result = parseReconfigureMemberInput({ member_id: 'm', skills: [{ name: 'research' }] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('"skills"')
      expect(result.error).toContain('not supported')
    }
  })

  it('parses a member_id plus role and preset-name permissions', () => {
    const result = parseReconfigureMemberInput({
      member_id: '  member-1  ',
      role: '  analyst  ',
      permissions: 'danger-full-access',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan).toEqual({ memberId: 'member-1', role: 'analyst', permissions: 'danger-full-access' })
  })

  it('parses explicit sandbox/approval knobs', () => {
    const result = parseReconfigureMemberInput({
      member_id: 'm',
      permissions: { sandbox: 'read-only', approval: 'never' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.permissions).toEqual({ sandbox: 'read-only', approval: 'never' })
  })

  it('parses minimal input (member_id only) with no role/permissions', () => {
    const result = parseReconfigureMemberInput({ member_id: 'm' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.role).toBeUndefined()
    expect(result.plan.permissions).toBeUndefined()
  })
})

describe('reconfigureMember', () => {
  it('replaces role and applies knob permissions on a live member', async () => {
    const m = makeHost()
    const member = m.makeMember('member-1')
    m.host.agents.get = vi.fn(() => member) as never
    const result = await reconfigureMember(m.host, plan({
      role: 'analyst',
      permissions: { sandbox: 'read-only', approval: 'never' },
    }))
    expect(m.setRole).toHaveBeenCalledWith(member, 'analyst')
    expect((member.session as unknown as FakeSession).events).toEqual(['sandbox/mode', 'approval/policy'])
    expect(result.steps).toEqual(['role', 'permissions'])
    expect(result.memberId).toBe('member-1')
  })

  it('applies a preset-name permission through permissionPresets.set', async () => {
    const m = makeHost()
    const member = m.makeMember('member-1')
    m.host.agents.get = vi.fn(() => member) as never
    await reconfigureMember(m.host, plan({ permissions: 'danger-full-access' }))
    expect(m.presetSet).toHaveBeenCalledWith(member.session, 'danger-full-access')
    expect((member.session as unknown as FakeSession).events).toEqual([])
  })

  it('wakes a dormant member before reconfiguring', async () => {
    const m = makeHost()
    const member = m.makeMember('member-1')
    m.host.agents.get = vi.fn(() => undefined) as never
    m.host.agents.resume = vi.fn(async () => member) as never
    const result = await reconfigureMember(m.host, plan({ role: 'analyst' }))
    expect(m.host.agents.resume).toHaveBeenCalledWith('member-1')
    expect(m.setRole).toHaveBeenCalledWith(member, 'analyst')
    expect(result.steps).toEqual(['role'])
  })

  it('refuses an unwakeable (not live, not resumable) member', async () => {
    const m = makeHost()
    m.host.agents.get = vi.fn(() => undefined) as never
    m.host.agents.resume = vi.fn(async () => undefined) as never
    await expect(reconfigureMember(m.host, plan({ role: 'analyst' })))
      .rejects.toThrow(/could not be resolved/)
  })

  it('refuses a plan with nothing to change', async () => {
    const m = makeHost()
    const member = m.makeMember('member-1')
    m.host.agents.get = vi.fn(() => member) as never
    await expect(reconfigureMember(m.host, plan()))
      .rejects.toThrow(/nothing to change/)
  })

  it('refuses a role change when no systemPrompt service is composed', async () => {
    const m = makeHost({ setRole: undefined })
    const member = m.makeMember('member-1')
    m.host.agents.get = vi.fn(() => member) as never
    await expect(reconfigureMember(m.host, plan({ role: 'analyst' })))
      .rejects.toThrow(/systemPrompt/)
  })

  it('refuses a preset-name permission when no permissionPresets service is composed', async () => {
    const m = makeHost({ permissionPresets: undefined })
    const member = m.makeMember('member-1')
    m.host.agents.get = vi.fn(() => member) as never
    await expect(reconfigureMember(m.host, plan({ permissions: 'danger-full-access' })))
      .rejects.toThrow(/permissionPresets/)
  })

  it('runs role-only and permissions-only plans independently', async () => {
    const m = makeHost()
    const member = m.makeMember('member-1')
    m.host.agents.get = vi.fn(() => member) as never
    const roleOnly = await reconfigureMember(m.host, plan({ role: 'analyst' }))
    expect(roleOnly.steps).toEqual(['role'])
    const permOnly = await reconfigureMember(m.host, plan({
      permissions: { sandbox: 'workspace-write', approval: 'ask' },
    }))
    expect(permOnly.steps).toEqual(['permissions'])
    expect((member.session as unknown as FakeSession).events).toEqual(['sandbox/mode', 'approval/policy'])
  })
})

describe('setMemberRole (live-role disposer registry)', () => {
  it('registers the role section under the member section name/order', () => {
    const record: { sections: Array<Record<string, unknown>> } = { sections: [] }
    const agentCtx = fakeAgentCtx(record)
    setMemberRole('member-1', agentCtx, 'analyst')
    expect(record.sections).toEqual([{ name: 'agent-bus:member-role', order: expect.any(Number), text: 'analyst' }])
  })

  it('disposes the prior section before re-registering the same member', () => {
    const record: { sections: Array<Record<string, unknown>> } = { sections: [] }
    const agentCtx = fakeAgentCtx(record)
    setMemberRole('member-1', agentCtx, 'first')
    setMemberRole('member-1', agentCtx, 'second')
    // Two registrations, the second replacing the first (the disposer is
    // invoked between them — no duplicate-name throw in prompt assembly).
    expect(record.sections).toEqual([
      { name: 'agent-bus:member-role', order: expect.any(Number), text: 'first' },
      { name: 'agent-bus:member-role', order: expect.any(Number), text: 'second' },
    ])
  })

  it('fails loud when the systemPrompt service is absent', () => {
    expect(() => setMemberRole('member-1', { get: () => undefined } as unknown as Context, 'x'))
      .toThrow(/systemPrompt/)
  })
})
