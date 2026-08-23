/**
 * 决策 2 单测:claim_task 工具(执行方主动领取 submitted 任务)与
 * 心跳重投的活跃态冷却(shouldHeartbeatRedeliver)。
 *
 * claim_task 走真实工具执行(createToolHarness):submitted → working 转移、
 * 仅 assignedTo 可领、已 working 本人幂等、非可领状态/未知 id 报错。
 * 心跳冷却走 scheduler.ts 的纯函数判定:执行者活跃(冷却期内)→ 不重投,
 * 不活跃/无记录 → 重投,另覆盖非 idle、行未超时、执行者离线。
 *
 * @module tests/claim-task
 */

import { afterEach, describe, expect, it } from 'vitest'
import { shouldHeartbeatRedeliver } from '../src/scheduler.ts'
import type { NewTask } from '../src/ledger.ts'
import { TaskId } from '../src/types.ts'
import {
  createToolHarness,
  makeAgent,
  type ToolHarness,
} from './helpers/tool-harness.ts'
import {
  makeNewTask,
  makeTask,
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
} from './helpers/memory-ctx.ts'

let harnesses: ToolHarness[] = []

afterEach(async () => {
  const pending = harnesses
  harnesses = []
  await Promise.all(pending.map(harness => harness.dispose()))
})

async function newHarness(): Promise<ToolHarness> {
  const harness = await createToolHarness()
  // 工具 execute 要求 caller 是 live agent;A/B/REVIEWER 均在默认工作区。
  for (const id of [SESSION_A, SESSION_B, SESSION_REVIEWER]) harness.agents.add(makeAgent(id))
  harnesses.push(harness)
  return harness
}

/** 记一条 submitted 任务(无依赖即 submitted)并返回其 id。 */
async function recordTask(harness: ToolHarness, overrides: Partial<NewTask> = {}): Promise<TaskId> {
  const result = await harness.ledger.record(makeNewTask(overrides), harness.config.maxPendingPerAgent)
  if (!result.ok) throw new Error(result.message)
  return result.task.id
}

describe('claim_task 工具', () => {
  it('submitted 任务由执行方领取后进入 working', async () => {
    const harness = await newHarness()
    const taskId = await recordTask(harness, { assignedTo: SESSION_B })
    expect(harness.ledger.get(taskId)?.status).toBe('submitted')
    const result = await harness.run('claim_task', { task_id: String(taskId) }, SESSION_B)
    expect(result).toEqual({ taskId: String(taskId), status: 'working' })
    expect(harness.ledger.get(taskId)?.status).toBe('working')
  })

  it('非执行方(发起方)领取被拒,报错含「该任务不属于你」', async () => {
    const harness = await newHarness()
    const taskId = await recordTask(harness, { assignedTo: SESSION_B })
    await expect(
      harness.run('claim_task', { task_id: String(taskId) }, SESSION_A),
    ).rejects.toThrow(/该任务不属于你/)
    expect(harness.ledger.get(taskId)?.status).toBe('submitted')
  })

  it('已 working 且为本人领取是幂等 no-op,返回当前状态', async () => {
    const harness = await newHarness()
    const taskId = await recordTask(harness, { assignedTo: SESSION_B })
    const advanced = await harness.ledger.transition(taskId, 'working')
    expect(advanced.ok).toBe(true)
    const result = await harness.run('claim_task', { task_id: String(taskId) }, SESSION_B)
    expect(result).toEqual({ taskId: String(taskId), status: 'working' })
    expect(harness.ledger.get(taskId)?.status).toBe('working')
  })

  it('非 submitted/working 状态领取报错', async () => {
    const harness = await newHarness()
    const taskId = await recordTask(harness, { assignedTo: SESSION_B })
    const advanced = await harness.ledger.transition(taskId, 'working')
    expect(advanced.ok).toBe(true)
    const completed = await harness.ledger.transition(taskId, 'completed')
    expect(completed.ok).toBe(true)
    await expect(
      harness.run('claim_task', { task_id: String(taskId) }, SESSION_B),
    ).rejects.toThrow(/only a submitted task can be claimed/)
  })

  it('未知任务 id 报错', async () => {
    const harness = await newHarness()
    await expect(
      harness.run('claim_task', { task_id: 'no-such-task' }, SESSION_B),
    ).rejects.toThrow(/no such task/)
  })
})

describe('shouldHeartbeatRedeliver 活跃态冷却', () => {
  // 行 5 分钟前最后变更:超时窗(retryIdleMs=300000)刚过。
  const UPDATED_AT = '2026-08-01T00:00:00.000Z'
  const now = Date.parse(UPDATED_AT) + 300_001
  const row = makeTask({ updatedAt: UPDATED_AT })

  it('执行者最近活跃(冷却期内)→ 不重投,即使 idle 且行已超时', () => {
    expect(shouldHeartbeatRedeliver(row, { status: 'idle' }, now, 300_000, now - 1, 300_000)).toBe(false)
  })

  it('执行者无活跃记录 + idle + 行超时 → 重投', () => {
    expect(shouldHeartbeatRedeliver(row, { status: 'idle' }, now, 300_000, undefined, 300_000)).toBe(true)
  })

  it('执行者活跃但早于冷却窗 → 重投', () => {
    expect(shouldHeartbeatRedeliver(row, { status: 'idle' }, now, 300_000, now - 300_001, 300_000)).toBe(true)
  })

  it('执行者 running(非 idle)→ 不重投', () => {
    expect(shouldHeartbeatRedeliver(row, { status: 'running' }, now, 300_000, undefined, 300_000)).toBe(false)
  })

  it('行未超时 → 不重投', () => {
    // 行变更距今 299999ms,仍在 retryIdleMs(300000)窗内。
    const insideWindow = Date.parse(UPDATED_AT) + 299_999
    expect(shouldHeartbeatRedeliver(row, { status: 'idle' }, insideWindow, 300_000, undefined, 300_000)).toBe(false)
  })

  it('执行者离线(undefined)→ 不重投(offlineGrace 另管)', () => {
    expect(shouldHeartbeatRedeliver(row, undefined, now, 300_000, undefined, 300_000)).toBe(false)
  })
})
