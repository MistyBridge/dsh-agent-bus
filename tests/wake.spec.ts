/**
 * wake.ts 单测:唤醒会话时的 preset 恢复逻辑(决策10 A 部分)。
 *
 * 覆盖:
 * - resolveSessionPreset:header 与事件日志的预设解析(最新 selection 获胜、header 兜底、无预设)
 * - composeWakeSetup:有 agentPresets 服务时构造 setup;无服务时返回 undefined
 *
 * @module tests/wake
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { composeWakeSetup, resolveSessionPreset } from '../src/members/wake.ts'

/** 构造一个最小 header。 */
function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-test-0000' as SessionHeader['id'],
    origin: 'user',
    ...overrides,
  } as SessionHeader
}

/** 构造一个 agent-preset/selected 事件。 */
function presetEvent(agentPreset: string): SessionEvent {
  return { type: 'agent-preset/selected', data: { agentPreset } } as SessionEvent
}

describe('resolveSessionPreset', () => {
  it('returns the header preset when no selection event exists', () => {
    expect(resolveSessionPreset(header({ agentPreset: 'cordis' }), [])).toBe('cordis')
  })

  it('returns undefined when neither header nor events name a preset', () => {
    expect(resolveSessionPreset(header({}), [])).toBeUndefined()
  })

  it('prefers the newest agent-preset/selected event over the header', () => {
    const events = [presetEvent('standard'), presetEvent('cordis')]
    expect(resolveSessionPreset(header({ agentPreset: 'standard' }), events)).toBe('cordis')
  })

  it('ignores non-preset events and still finds a later selection', () => {
    const events: SessionEvent[] = [
      { type: 'message/user', data: { content: 'hi' } } as SessionEvent,
      presetEvent('minimal'),
    ]
    expect(resolveSessionPreset(header({ agentPreset: 'cordis' }), events)).toBe('minimal')
  })

  it('ignores a selection event with a non-string payload', () => {
    const events = [
      { type: 'agent-preset/selected', data: {} } as SessionEvent,
    ]
    // 无效事件被跳过 → header 兜底
    expect(resolveSessionPreset(header({ agentPreset: 'cordis' }), events)).toBe('cordis')
  })
})

describe('composeWakeSetup', () => {
  /** 伪造 ctx.get:仅提供 agentPresets 服务。 */
  function ctxWithPresets(agentPresets: unknown): Context {
    return {
      get: (name: string): unknown => (name === 'agentPresets' ? agentPresets : undefined),
    } as Context
  }

  it('returns undefined when the agent-presets service is absent', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const setup = await composeWakeSetup(ctx, header({}), [])
    expect(setup).toBeUndefined()
  })

  it('builds a setup that mounts the resolved preset', async () => {
    const mounted: string[] = []
    const presets = {
      mount: async (_agentCtx: Context, id?: string): Promise<void> => {
        mounted.push(id ?? 'undefined')
      },
    }
    const ctx = ctxWithPresets(presets)
    const setup = await composeWakeSetup(
      ctx,
      header({ agentPreset: 'cordis' }),
      [presetEvent('minimal')],
    )
    expect(setup).toBeDefined()
    // 事件最新选择优先:minimal 而非 header 的 cordis
    await setup!({} as Context)
    expect(mounted).toEqual(['minimal'])
  })

  it('mounts with the header preset when no selection event exists', async () => {
    const mounted: string[] = []
    const presets = {
      mount: async (_agentCtx: Context, id?: string): Promise<void> => {
        mounted.push(id ?? 'undefined')
      },
    }
    const setup = await composeWakeSetup(ctxWithPresets(presets), header({ agentPreset: 'cordis' }), [])
    await setup!({} as Context)
    expect(mounted).toEqual(['cordis'])
  })

  it('mounts with undefined (default) when no preset is recorded anywhere', async () => {
    const mounted: string[] = []
    const presets = {
      mount: async (_agentCtx: Context, id?: string): Promise<void> => {
        mounted.push(id ?? 'undefined')
      },
    }
    const setup = await composeWakeSetup(ctxWithPresets(presets), header({}), [])
    await setup!({} as Context)
    expect(mounted).toEqual(['undefined'])
  })
})
