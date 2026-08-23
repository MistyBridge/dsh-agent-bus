/**
 * 决策 8 单测:流程命名管理。
 *
 * 覆盖:
 * - create_flow:同工作区重名创建被拒(报错含已有流程名)、无意义名(纯数字/纯符号)
 *   放行但返回命名建议、有意义名不附建议、空名仍拒绝;
 * - rename_flow:创建者可改名并更新 description、重名改名被拒、非创建者被拒
 *   (「仅流程创建者可改名」)、未知流程 id 被拒;
 * - ledger.renameFlow:description 传空串清除、缺省保留;
 * - panel-model 的 flowsOfWorkspace 投影保留 description(供 DAG 列表截断展示)。
 *
 * @module tests/flow-naming
 */

import { afterEach, describe, expect, it } from 'vitest'
import { flowsOfWorkspace, type FlowView } from '../src/client/panel-model.ts'
import {
  createToolHarness,
  makeAgent,
  type ToolHarness,
} from './helpers/tool-harness.ts'
import {
  openLedger,
  SESSION_A,
  SESSION_B,
  WORKSPACE,
} from './helpers/memory-ctx.ts'

let harnesses: ToolHarness[] = []

afterEach(async () => {
  const pending = harnesses
  harnesses = []
  await Promise.all(pending.map(harness => harness.dispose()))
})

async function newHarness(): Promise<ToolHarness> {
  const harness = await createToolHarness()
  for (const id of [SESSION_A, SESSION_B]) harness.agents.add(makeAgent(id))
  harnesses.push(harness)
  return harness
}

describe('create_flow 命名(决策 8)', () => {
  it('同工作区重名创建被拒,报错含已有流程名', async () => {
    const harness = await newHarness()
    await harness.run('create_flow', { name: '电商站上线' }, SESSION_A)
    await expect(
      harness.run('create_flow', { name: '电商站上线' }, SESSION_A),
    ).rejects.toThrow(/该工作区已有同名流程『电商站上线』/)
    // 另一会话(不同创建者、同工作区)同样被拒,并列出已有流程名。
    await expect(
      harness.run('create_flow', { name: '电商站上线' }, SESSION_B),
    ).rejects.toThrow(/『电商站上线』/)
  })

  it('无意义名(纯数字)放行,但返回携带命名建议', async () => {
    const harness = await newHarness()
    const result = await harness.run('create_flow', { name: '12345' }, SESSION_A) as {
      flowId: string
      name: string
      suggestion?: string
    }
    expect(result.name).toBe('12345')
    expect(result.suggestion).toContain('建议格式')
  })

  it('有意义名不附建议', async () => {
    const harness = await newHarness()
    const result = await harness.run(
      'create_flow',
      { name: '电商站上线:Phase 1 基建' },
      SESSION_A,
    ) as { flowId: string; name: string; suggestion?: string }
    expect(result.suggestion).toBeUndefined()
  })

  it('空名仍拒绝', async () => {
    const harness = await newHarness()
    await expect(
      harness.run('create_flow', { name: '   ' }, SESSION_A),
    ).rejects.toThrow(/不超过 20 字/)
  })

  it('超过 20 字(21 字)拒绝,20 字通过(决策 8 命名上限)', async () => {
    const harness = await newHarness()
    // 21 字 → 拒绝。
    await expect(
      harness.run('create_flow', { name: 'a'.repeat(21) }, SESSION_A),
    ).rejects.toThrow(/不超过 20 字/)
    // 恰好 20 字 → 通过。
    const ok = await harness.run('create_flow', { name: 'a'.repeat(20) }, SESSION_A) as {
      flowId: string
      name: string
    }
    expect(ok.name).toBe('a'.repeat(20))
  })
})

describe('rename_flow(决策 8)', () => {
  async function createFlow(harness: ToolHarness, name: string): Promise<string> {
    const result = await harness.run('create_flow', { name }, SESSION_A) as { flowId: string }
    return result.flowId
  }

  it('创建者可改名并更新 description', async () => {
    const harness = await newHarness()
    const flowId = await createFlow(harness, '旧名')
    const result = await harness.run(
      'rename_flow',
      { flow_id: flowId, name: '新名', description: '新备注' },
      SESSION_A,
    )
    expect(result).toEqual({ flowId, name: '新名', description: '新备注' })
    expect(harness.ledger.getFlow(flowId)?.name).toBe('新名')
    expect(harness.ledger.getFlow(flowId)?.description).toBe('新备注')
  })

  it('重名改名被拒,报错含已有流程名', async () => {
    const harness = await newHarness()
    const flowId = await createFlow(harness, 'A 流程')
    await createFlow(harness, 'B 流程')
    await expect(
      harness.run('rename_flow', { flow_id: flowId, name: 'B 流程' }, SESSION_A),
    ).rejects.toThrow(/该工作区已有同名流程『B 流程』/)
  })

  it('非创建者改名被拒「仅流程创建者可改名」', async () => {
    const harness = await newHarness()
    const flowId = await createFlow(harness, 'A 流程')
    await expect(
      harness.run('rename_flow', { flow_id: flowId, name: 'X 流程' }, SESSION_B),
    ).rejects.toThrow(/仅流程创建者可改名/)
  })

  it('未知流程 id 被拒', async () => {
    const harness = await newHarness()
    await expect(
      harness.run('rename_flow', { flow_id: 'ghost', name: 'X 流程' }, SESSION_A),
    ).rejects.toThrow(/no such flow/)
  })

  it('超过 20 字(21 字)拒绝,20 字通过(决策 8 命名上限)', async () => {
    const harness = await newHarness()
    const flowId = await createFlow(harness, '旧名')
    await expect(
      harness.run('rename_flow', { flow_id: flowId, name: 'a'.repeat(21) }, SESSION_A),
    ).rejects.toThrow(/不超过 20 字/)
    const ok = await harness.run('rename_flow', { flow_id: flowId, name: 'a'.repeat(20) }, SESSION_A) as {
      flowId: string
      name: string
    }
    expect(ok.name).toBe('a'.repeat(20))
  })
})

describe('renameFlow ledger 语义', () => {
  it('description 传空串清除、缺省保留', async () => {
    const ledger = await openLedger()
    await ledger.createFlow('f1', '名称', '备注', SESSION_A, WORKSPACE)
    const cleared = await ledger.renameFlow('f1', '名称二', '')
    if (!cleared.ok) throw new Error(cleared.message)
    expect(cleared.flow.description).toBeUndefined()
    const kept = await ledger.renameFlow('f1', '名称三', undefined)
    if (!kept.ok) throw new Error(kept.message)
    expect(kept.flow.description).toBeUndefined()
  })
})

describe('panel-model 流投影携带 description(决策 8)', () => {
  it('flowsOfWorkspace 保留 description 字段', () => {
    const flows: FlowView[] = [{
      id: 'f1',
      name: 'A 流程',
      description: '这是一段较长的流程说明,用于验证投影是否携带 description',
      workspacePath: WORKSPACE,
      taskCount: 3,
      unsettledCount: 1,
      archived: false,
    }]
    const projected = flowsOfWorkspace(flows, WORKSPACE)
    expect(projected[0]?.description).toBe('这是一段较长的流程说明,用于验证投影是否携带 description')
  })
})
