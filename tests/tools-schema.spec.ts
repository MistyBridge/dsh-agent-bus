/**
 * 工具输出 schema 一致性回归。
 *
 * 教训来源：v1.6 给任务加了 title，view()/detailView() 返回带 title，
 * 但 list_tasks/get_task 的 output.schema 未同步声明；运行时
 * additionalProperties: false 直接拒绝工具输出（"value[0].title is
 * not a declared property"）。设计笔记明示：返回面必须精确等于输出 schema。
 *
 * 本套件把 15 个工具的 output.schema 与其真实返回面（所有可选字段齐备的
 * 最大返回值）对齐：键集双向相等（声明面 ⊆ 返回面 且 返回面 ⊆ 声明面），
 * 且用 dsh-tools 的 validateJsonSchemaValue（运行时校验同一把尺子）
 * 验证最大返回值零违规。任何一边漂移都会让本套件失败。
 *
 * checkedTool 的运行时防线（execute 返回即校验、漂移抛结构化可读报错）由
 * 底部「报错信息可读性」describe 覆盖：构造返回值与 schema 不一致的工具，
 * 断言错误消息含字段名、不一致提示与修复方向。
 *
 * 运行实例的工具 schema 是旧构建（lib/），本套件以 src 为准、在单测中
 * 校验，不依赖运行实例的工具返回。
 */

import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue, type JsonSchemaNode, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { checkedTool, ToolOutputMismatchError } from '../src/checked-tool.ts'
import { TOOL_NAMES as DOC_NAMES } from '../src/tool-docs.ts'
import { registerAgentBusTools, type ToolsConfig, type ToolsDeps } from '../src/tools.ts'
import { TaskId, type TaskRecord } from '../src/types.ts'
import {
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
  WORKSPACE,
} from './helpers/memory-ctx.ts'

/** 注册时捕获的工具定义（不执行 execute）。 */
interface CapturedTool {
  name: string
  output: { schema: JsonSchemaNode }
  parameters: Record<string, unknown>
}

const CONFIG: ToolsConfig = {
  maxContentLength: 1000,
  maxPendingPerAgent: 4,
  maxSendsPerMinute: 8,
  maxInlineReport: 400,
  maxMessagesPerMinute: 20,
}

/** 工具面全集：数量与名字的漂移本身就是回归信号。19 个文档工具来自 tool-docs 的单一事实源，加披露加载器 tool_help。 */
const TOOL_NAMES = [...DOC_NAMES, 'tool_help'] as const

function captureTools(): Map<string, CapturedTool> {
  const defs = new Map<string, CapturedTool>()
  const stub = {
    tools: {
      register: (def: CapturedTool) => {
        defs.set(def.name, def)
      },
    },
  } as unknown as Context
  registerAgentBusTools(stub, CONFIG, {} as ToolsDeps)
  return defs
}

/** 所有可选字段齐备的任务行：view/detailView 的最大返回面。 */
function maxTask(): TaskRecord {
  return {
    id: TaskId('t-max'),
    assignedBy: SESSION_A,
    assignedTo: SESSION_B,
    assignedReviewer: SESSION_REVIEWER,
    workspacePath: WORKSPACE,
    content: 'full content',
    title: 'Full title',
    status: 'completed',
    mode: 'followup',
    messageId: 'msg-1',
    turn: 1,
    report: 'the report',
    question: 'a question',
    outcome: 'success',
    feedback: 'review feedback',
    reason: 'a reason',
    retries: 2,
    tokensAtStart: {
      [SESSION_B]: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    },
    dependencies: [TaskId('dep-1'), TaskId('dep-2')],
    auto: true,
    acceptanceCriteria: 'acceptance criteria',
    flowId: 'flow-1',
    handoffs: [{ fromTask: TaskId('dep-1'), document: 'handoff doc', at: '2026-08-01T00:00:00.000Z' }],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

/** list_tasks 的 view(maxTask) 返回面（所有可选键都在）。 */
function maxListView(): Record<string, unknown> {
  const task = maxTask()
  return {
    id: task.id,
    status: task.status,
    from: task.assignedBy,
    to: task.assignedTo,
    content: task.content,
    title: task.title,
    report: task.report,
    outcome: task.outcome,
    reason: task.reason,
    dependencies: task.dependencies?.map(String),
    acceptanceCriteria: task.acceptanceCriteria,
    retries: task.retries,
  }
}

/** get_task 的 detailView(maxTask) 返回面（所有可选键都在）。 */
function maxDetailView(): Record<string, unknown> {
  const task = maxTask()
  return {
    id: task.id,
    status: task.status,
    from: task.assignedBy,
    to: task.assignedTo,
    content: task.content,
    title: task.title,
    acceptanceCriteria: task.acceptanceCriteria,
    handoffs: task.handoffs?.map(handoff => ({
      fromTask: String(handoff.fromTask),
      document: handoff.document,
      at: handoff.at,
    })),
    report: task.report,
    question: task.question,
    outcome: task.outcome,
    feedback: task.feedback,
    reason: task.reason,
    reviewer: task.assignedReviewer,
    retries: task.retries,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * 每个工具的最大返回值：execute() 在全部可选分支齐备时产出的字段集。
 * 键的顺序不重要，集合相等即可。
 */
function maximalValueOf(name: string): unknown {
  switch (name) {
    case 'list_peers':
      return {
        workspace: { path: '/workspace', id: 'ws-1' },
        peers: [{
          id: 's1',
          title: 'Peer',
          status: 'running',
          pendingTasks: 2,
          description: 'desc',
          capabilities: [{ id: 'code', label: 'Coding' }],
        }],
      }
    case 'send_note':
      return { delivered: true, queued: false, messageId: 'm1' }
    case 'create_flow':
      return { flowId: 'f1', name: 'Flow', suggestion: '建议格式:目标 + 阶段,如『电商站上线:Phase 1 基建』' }
    case 'rename_flow':
      return { flowId: 'f1', name: 'Flow', description: 'desc' }
    case 'reassign_task':
      return { taskId: 't1', status: 'submitted', executor: 's2', reviewer: 's3' }
    case 'submit_handoff':
      return { taskId: 't1', handoffCount: 1 }
    case 'list_flows':
      return [{
        id: 'f1',
        name: 'Flow',
        description: 'desc',
        taskCount: 2,
        unsettledCount: 1,
        archived: false,
      }]
    case 'create_task':
      return { taskId: 't1', status: 'submitted', queuePosition: 1, blockedBy: ['dep-1'] }
    case 'edit_task':
      return { taskId: 't1', status: 'queued', blockedBy: ['dep-1'] }
    case 'list_tasks':
      return [maxListView()]
    case 'get_task':
      return maxDetailView()
    case 'report_task':
      return { taskId: 't1', status: 'completed' }
    case 'settle_task':
      return { taskId: 't1', status: 'completed', outcome: 'success' }
    case 'cancel_task':
      return { taskId: 't1', status: 'canceled' }
    case 'request_input':
      return { taskId: 't1', status: 'input-required' }
    case 'claim_task':
      return { taskId: 't1', status: 'working' }
    case 'answer_question':
      return { taskId: 't1', status: 'working', answered: 1 }
    case 'create_member':
      return {
        sessionId: 's1',
        name: 'Member',
        workspaceId: 'ws-1',
        workspacePath: '/workspace',
        steps: ['create-session', 'attach-workspace', 'rename', 'permissions', 'capability-card', 'flow'],
        warnings: ['a warning'],
        flow: { id: 'f1', name: 'Flow' },
      }
    case 'archive_task':
      return { taskId: 't1', status: 'completed', archived: true }
    case 'archive_flow':
      return { flowId: 'f1', name: 'Flow', archived: true }
    case 'archive_member':
      return { memberId: 's1', archived: true }
    case 'wake_member':
      return { memberId: 's1', title: 'Wake', status: 'idle' }
    case 'update_card':
      return { description: 'desc', capabilities: [{ id: 'code', label: 'Coding' }] }
    case 'tool_help':
      return { tool: 'send_note', doc: 'manual text' }
    default:
      throw new Error(`no maximal value fixture for tool "${name}"`)
  }
}

/** 取 object 根（array 根取 items）；非 object 根或缺 properties 视为测试设置错误。 */
function objectRootOf(schema: JsonSchemaNode) {
  const root = schema.type === 'array' ? schema.items : schema
  if (root === undefined || root.type !== 'object' || root.properties === undefined) {
    const why = root === undefined
      ? 'no items'
      : root.type !== 'object'
        ? `type "${root.type}"`
        : 'no properties'
    throw new Error(`expected an object-rooted output schema, got ${why}`)
  }
  return root as {
    type: 'object'
    additionalProperties?: boolean
    properties: Record<string, JsonSchemaNode>
  }
}

/** 取 object 根的 properties 键集（array 根取 items）。 */
function declaredKeys(schema: JsonSchemaNode): Set<string> {
  return new Set(Object.keys(objectRootOf(schema).properties))
}

describe('agent-bus tool surface', () => {
  it('registers exactly the declared tools', () => {
    const tools = captureTools()
    expect([...tools.keys()].sort()).toEqual([...TOOL_NAMES].sort())
  })

  it('every tool output schema is object-rooted with additionalProperties false', () => {
    const tools = captureTools()
    for (const name of TOOL_NAMES) {
      expect(objectRootOf(tools.get(name)!.output.schema).additionalProperties, name).toBe(false)
    }
  })

  it('list_tasks and get_task schemas declare title (v1.6 drift anchor)', () => {
    const tools = captureTools()
    for (const name of ['list_tasks', 'get_task']) {
      expect(objectRootOf(tools.get(name)!.output.schema).properties, name).toHaveProperty('title')
    }
  })
})

describe.each(TOOL_NAMES)('tool %s output schema ↔ return surface', (name) => {
  it('declares exactly the fields its maximal return value carries, and validates it', () => {
    const tools = captureTools()
    const def = tools.get(name)!
    const schema = def.output.schema
    const value = maximalValueOf(name)

    // 双向相等：schema 声明的键 == 返回面携带的键。任一方向漂移都失败。
    // 数组根工具的返回面是数组，键集取自首元素（与 schema 的 items 对应）。
    const declared = declaredKeys(schema)
    const valueRoot = Array.isArray(value) ? (value as unknown[])[0] : value
    const carried = new Set(Object.keys(valueRoot as Record<string, unknown>))
    expect([...declared].sort(), name).toEqual([...carried].sort())

    // 用运行时同一把尺子校验最大返回值：任何未声明键都会被拒绝。
    const violations = validateJsonSchemaValue(schema, value, 'value')
    expect(violations, `${name}: ${violations.join('; ')}`).toEqual([])
  })
})

describe('checkedTool output-mismatch diagnostics', () => {
  /** 构造一个 execute 返回与自身 output.schema 不一致的工具。 */
  function driftTool(returns: () => unknown): ToolDefinition {
    return checkedTool({
      name: 'test_drift',
      description: 'a tool whose execute return drifts from its output.schema',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
          },
        },
        render: () => [],
      },
      async execute() {
        // 类型面把多余字段挡在编译期；这里故意绕过类型面，测运行时 schema 防线。
        return returns() as unknown as never
      },
    })
  }

  /** 执行一次并断言被拒绝，返回捕获到的结构化错误。 */
  async function expectRejected(tool: ToolDefinition, args: unknown): Promise<ToolOutputMismatchError> {
    const outcome = await tool.execute(args, {} as never).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(outcome).toBeInstanceOf(ToolOutputMismatchError)
    return outcome as ToolOutputMismatchError
  }

  it('新增字段：错误消息含字段名、不一致提示、建议声明与修复方向', async () => {
    const tool = driftTool(() => ({ taskId: 't1', title: 'drift' }))
    const error = await expectRejected(tool, {})
    expect(error.message).toContain('title')
    expect(error.message).toContain('工具返回面与说明书不一致')
    expect(error.message).toContain('output.schema')
    expect(error.message).toContain('title: {"type":"string"}')
    expect(error.violations).toEqual([
      '"value.title" is not a declared property (additionalProperties: false)',
    ])
    expect(error.diff).toEqual([
      expect.objectContaining({ path: 'value.title', kind: 'added', key: 'title', type: 'string' }),
    ])
  })

  it('缺失必填字段：错误消息含字段名与缺失提示', async () => {
    const tool = driftTool(() => ({}))
    const error = await expectRejected(tool, {})
    expect(error.message).toContain('taskId')
    expect(error.message).toContain('缺失必填字段')
    expect(error.violations).toEqual(['missing required property "value.taskId"'])
    expect(error.diff).toEqual([
      expect.objectContaining({ path: 'value.taskId', kind: 'missing', key: 'taskId' }),
    ])
  })

  it('类型不符：错误消息含字段名与类型提示', async () => {
    const tool = driftTool(() => ({ taskId: 42 }))
    const error = await expectRejected(tool, {})
    expect(error.message).toContain('taskId')
    expect(error.message).toContain('must be a string')
    expect(error.message).toContain('类型不符')
  })

  it('schema 合规的返回值原样通过', async () => {
    const tool = driftTool(() => ({ taskId: 't1' }))
    await expect(tool.execute({}, {} as never)).resolves.toEqual({ taskId: 't1' })
  })
})

describe('create_member parameter drift (workspace optional, permissions hint)', () => {
  /** 编译后的参数 schema：`required` 为顶层数组，`properties` 为各字段 schema。 */
  function parameterRoot(): { required?: string[]; properties: Record<string, { enum?: unknown[]; oneOf?: unknown[] }> } {
    const tools = captureTools()
    return tools.get('create_member')!.parameters as unknown as {
      required?: string[]; properties: Record<string, { enum?: unknown[]; oneOf?: unknown[] }>
    }
  }

  it('makes workspace optional (not in required) and keeps name required', () => {
    const root = parameterRoot()
    expect(root.required).not.toContain('workspace')
    expect(root.required).toContain('name')
    expect(root.properties.workspace).toBeDefined()
  })

  it('declares sandbox/approval knob enums so the model sees legal values', () => {
    const root = parameterRoot()
    const oneOf = root.properties.permissions?.oneOf
    expect(oneOf).toBeDefined()
    const knobBranch = (oneOf ?? []).find((branch: { type?: string }) => branch.type === 'object')
    expect(knobBranch).toBeDefined()
    const knob = knobBranch as { properties: Record<string, { enum?: unknown[] }> }
    expect(knob.properties.sandbox.enum).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(knob.properties.approval.enum).toEqual(['ask', 'never'])
  })
})
