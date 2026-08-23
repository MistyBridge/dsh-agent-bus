/**
 * 渐进式披露(决策:tool_help 按需说明书)单测。
 *
 * 覆盖:
 * - tool-help 工具:合法工具名返回完整说明书(含参数/语义/鉴权)、非法名报错、
 *   checkedTool 输出 schema 一致性(经真实 execute + 运行实例的 schema 校验);
 * - TOOL_DOCS/TOOL_NAMES:19 个文档工具全部有非空说明书、名称唯一、与 tools.ts
 *   注册集一致(list_peers…create_member 19 个,不含 tool_help 自身);
 * - USAGE_OVERVIEW:短总览(篇幅受限)、含「tool_help」指引与完整工具名清单。
 *
 * 说明书内容以 src/tools.ts 的 checkedTool 定义、src/authorize.ts 鉴权、ledger
 * 状态机为基准;漂移由 tools-completeness 用例钉住。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_DOCS, TOOL_NAMES, USAGE_OVERVIEW } from '../src/tool-docs.ts'
import {
  createToolHarness,
  makeAgent,
  type ToolHarness,
  type ToolHarnessOptions,
} from './helpers/tool-harness.ts'
import { SESSION_A } from './helpers/memory-ctx.ts'

let harnesses: ToolHarness[] = []

afterEach(async () => {
  const pending = harnesses
  harnesses = []
  await Promise.all(pending.map(harness => harness.dispose()))
})

async function newHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  const harness = await createToolHarness(options)
  harnesses.push(harness)
  return harness
}

describe('tool_help (progressive disclosure loader)', () => {
  it('returns the full manual for a valid tool name through the real tool', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))

    const result = await harness.run('tool_help', { tool: 'send_note' }, SESSION_A) as {
      tool: string
      doc: string
    }
    expect(result.tool).toBe('send_note')
    expect(result.doc.length).toBeGreaterThan(50)
    expect(result.doc).toContain('send_note')
    expect(result.doc).toContain('SMALL')
    expect(result.doc).toContain('鉴权')
  })

  it('every documented tool resolves to a non-empty manual', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))

    for (const name of TOOL_NAMES) {
      const result = await harness.run('tool_help', { tool: name }, SESSION_A) as { doc: string }
      expect(result.doc.length, name).toBeGreaterThan(0)
      expect(result.doc, name).toContain(name)
    }
  })

  it('refuses an unknown tool name at the schema gate with a clear error', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))

    // tool_help 的参数 enum 先校验:非法工具名在 execute 前即被 schema 门拒绝,
    // 报错列出所有合法工具名。
    await expect(
      harness.run('tool_help', { tool: 'not_a_tool' }, SESSION_A),
    ).rejects.toThrow('must be one of')
  })

  it('its output schema agrees with the real return surface (checkedTool gate)', async () => {
    // tool_help 的 execute 返回 {tool, doc};checkedTool 会在返回时用自身
    // output.schema 校验,不一致会抛 ToolOutputMismatchError——此用例能跑通
    // 即证明返回面与 schema 一致。
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    const result = await harness.run('tool_help', { tool: 'create_task' }, SESSION_A) as {
      tool: string
      doc: string
    }
    expect(Object.keys(result).sort()).toEqual(['doc', 'tool'])
  })
})

describe('TOOL_DOCS / TOOL_NAMES completeness', () => {
  it('names are unique and every one has a non-empty manual', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
    for (const name of TOOL_NAMES) {
      expect(TOOL_DOCS[name].length, name).toBeGreaterThan(0)
    }
  })

  it('the documented set matches the tools.ts registration surface (21, no tool_help)', () => {
    // 21 个文档工具:与 tools.ts 的 checkedTool 注册集一致(含 reassign_task,
    // 不含 respond_approval——那是 approval-bridge.ts 的另一注册面)。
    expect(TOOL_NAMES).toHaveLength(21)
    expect(TOOL_NAMES).toContain('reassign_task')
    expect(TOOL_NAMES).toContain('create_member')
    expect(TOOL_NAMES).toContain('archive_task')
    expect(TOOL_NAMES).toContain('archive_flow')
    expect(TOOL_NAMES).not.toContain('tool_help')
    expect(TOOL_NAMES).not.toContain('respond_approval')
  })
})

describe('USAGE_OVERVIEW (short resident overview)', () => {
  it('is bounded well below the former 8.6KB USAGE_TEXT and keeps the routing + tool_help guidance', () => {
    expect(USAGE_OVERVIEW.length).toBeLessThan(3200)
    expect(USAGE_OVERVIEW).toContain('ROUTE BY SCOPE')
    expect(USAGE_OVERVIEW).toContain('tool_help')
    expect(USAGE_OVERVIEW).toContain('TOOLS')
  })

  it('lists every documented tool name', () => {
    for (const name of TOOL_NAMES) {
      expect(USAGE_OVERVIEW, name).toContain(name)
    }
  })
})
