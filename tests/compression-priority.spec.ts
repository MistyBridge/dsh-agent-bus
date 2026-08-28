/**
 * 决策 3「消息压缩」单测：投递优先级（任务消息走 next-step 优先级通道，
 * send_note 走 next-turn 普通通道）+ 系统通知压缩（按接收者合并、同接收者
 * +同任务+同主题去重、3s 窗口、flush/clear 钩子）。
 *
 * 覆盖面（对应 blockers-and-optimization.md 决策 3）：
 * - 优先级：create_task 默认走 steer（next-step）通道，先于任何 next-turn
 *   消息被认领（claimOrder 断言）；send_note 保持 followup 实时投递；
 *   显式 mode=followup 退出优先级（FIFO）；cancel_task 摘要 / settle 返工 /
 *   reassign 重投递 / request_input 回答路径均走优先级通道；
 * - 压缩：同接收者多通知合并为一条投递（每段自带 relay header）；同接收者
 *   +同任务+同主题窗口内去重；不同主题不去重；同一任务不同接收者各收各的
 *   （回归：旧实现按 taskId 合并会把通知投给第一个接收者）；离线接收者跳过；
 *   flush 立即投递；clear 丢弃；单通知保持单 header 格式。
 *
 * 核心逻辑全部真实实现（ledger、delivery 消息构造、notifySession 压缩器）；
 * 仅 agent/workspace 为协作方桩（tests/helpers/tool-harness.ts）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNoticeBatchMessage,
  buildTaskMessage,
  clearNoticeMerges,
  flushNoticeMerges,
  notifySession,
} from '../src/delivery.ts'
import { TaskId } from '../src/domain/types.ts'
import {
  makeNewTask,
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
} from './helpers/memory-ctx.ts'
import {
  createToolHarness,
  makeAgent,
  type ToolHarness,
  type ToolHarnessOptions,
} from './helpers/tool-harness.ts'

/** 收件箱消息的 model 可见文本。 */
function textOf(message: unknown): string {
  const block = (message as { content: { type: string; text: string }[] }).content[0]
  if (block === undefined) throw new Error('message has no text block')
  return block.text
}

let harnesses: ToolHarness[] = []

afterEach(async () => {
  clearNoticeMerges()
  const pending = harnesses
  harnesses = []
  await Promise.all(pending.map(harness => harness.dispose()))
})

async function newHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  const harness = await createToolHarness(options)
  harnesses.push(harness)
  return harness
}

describe('delivery priority (task channel ahead of notes)', () => {
  it('create_task default delivers on the priority channel (steer), with no normal-channel delivery', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    const result = await harness.run(
      'create_task', { target: SESSION_B, content: 'do it', title: 'Do it' }, SESSION_A,
    ) as { taskId: string }

    const worker = harness.agents.get(SESSION_B)!
    expect(worker.steers).toHaveLength(1)
    expect(worker.followups).toHaveLength(0)
    expect(textOf(worker.steers[0])).toContain(`<dsh-agent-bus task="${result.taskId}" tool="create_task"`)
  })

  it('send_note keeps the normal channel and delivers immediately', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('send_note', { target: SESSION_B, content: 'ping' }, SESSION_A)

    const worker = harness.agents.get(SESSION_B)!
    expect(worker.followups).toHaveLength(1)
    expect(worker.steers).toHaveLength(0)
    expect(textOf(worker.followups[0])).toContain('<dsh-agent-bus-message tool="send_note"')
  })

  it('a task dispatched after queued notes is claimed before them', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('send_note', { target: SESSION_B, content: 'note one' }, SESSION_A)
    await harness.run('send_note', { target: SESSION_B, content: 'note two' }, SESSION_A)
    await harness.run('create_task', { target: SESSION_B, content: 'the task', title: 'Task' }, SESSION_A)

    const worker = harness.agents.get(SESSION_B)!
    // claimOrder 镜像 Inbox.claim 语义：next-step（steer）全部先于 next-turn（followup）。
    const order = worker.claimOrder()
    expect(order).toHaveLength(3)
    expect(textOf(order[0])).toContain('<dsh-agent-bus task="')
    expect(textOf(order[0])).not.toContain('<dsh-agent-bus-message')
    expect(textOf(order[1])).toContain('<dsh-agent-bus-message')
    expect(textOf(order[2])).toContain('<dsh-agent-bus-message')
  })

  it('explicit mode=followup opts out of priority and joins the normal FIFO', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('send_note', { target: SESSION_B, content: 'note' }, SESSION_A)
    await harness.run(
      'create_task', { target: SESSION_B, content: 'queued task', title: 'Q', mode: 'followup' }, SESSION_A,
    )

    const worker = harness.agents.get(SESSION_B)!
    expect(worker.steers).toHaveLength(0)
    expect(worker.followups).toHaveLength(2)
    expect(textOf(worker.followups[0])).toContain('<dsh-agent-bus-message')
    expect(textOf(worker.followups[1])).toContain('<dsh-agent-bus task="')
  })

  it('cancel_task summary rides the priority channel', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const taskId = TaskId('cancel-1')
    await harness.ledger.record(makeNewTask({ id: taskId }), 8)
    await harness.ledger.transition(taskId, 'working')

    await harness.run('cancel_task', { task_id: String(taskId) }, SESSION_A)

    const worker = harness.agents.get(SESSION_B)!
    expect(worker.steers).toHaveLength(1)
    expect(worker.followups).toHaveLength(0)
    expect(textOf(worker.steers[0])).toContain('已取消')
  })

  it('settle_task failure rework notice rides the priority channel', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const taskId = TaskId('rework-1')
    await harness.ledger.record(makeNewTask({ id: taskId }), 8)
    await harness.ledger.transition(taskId, 'working')
    await harness.ledger.transition(taskId, 'completed', { report: 'done' })

    await harness.run(
      'settle_task', { task_id: String(taskId), outcome: 'failure', feedback: 'redo it' }, SESSION_A,
    )

    const worker = harness.agents.get(SESSION_B)!
    expect(worker.steers).toHaveLength(1)
    expect(worker.followups).toHaveLength(0)
    expect(textOf(worker.steers[0])).toContain('验收未通过')
  })

  it('reassign_task re-delivery rides the priority channel and the old executor notice is compressed', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    harness.agents.add(makeAgent(SESSION_REVIEWER))
    const taskId = TaskId('reassign-1')
    await harness.ledger.record(makeNewTask({ id: taskId }), 8)
    await harness.ledger.transition(taskId, 'working')

    await harness.run(
      'reassign_task', { task_id: String(taskId), new_executor: SESSION_REVIEWER }, SESSION_A,
    )

    // 新执行方：重投递走优先级通道。
    const newWorker = harness.agents.get(SESSION_REVIEWER)!
    expect(newWorker.steers).toHaveLength(1)
    expect(textOf(newWorker.steers[0])).toContain('转派')
    // 旧执行方：通知进入压缩窗口，flush 前不投递。
    const oldWorker = harness.agents.get(SESSION_B)!
    expect(oldWorker.followups).toHaveLength(0)
    flushNoticeMerges(harness.ctx)
    expect(oldWorker.followups).toHaveLength(1)
    expect(textOf(oldWorker.followups[0])).toContain('已转派')
  })

  it('the request_input answer path rides the priority channel', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const taskId = TaskId('answer-1')
    await harness.ledger.record(makeNewTask({ id: taskId }), 8)
    await harness.ledger.transition(taskId, 'working')
    await harness.ledger.transition(taskId, 'input-required', { question: 'which color?' })

    const result = await harness.run(
      'create_task', { target: SESSION_B, task_id: String(taskId), content: 'blue', title: 'Answer' }, SESSION_A,
    )

    const worker = harness.agents.get(SESSION_B)!
    expect(worker.steers).toHaveLength(1)
    expect(worker.followups).toHaveLength(0)
    expect(textOf(worker.steers[0])).toContain('\nblue')
    // The answer transitions the row back to working immediately, so a
    // steer-spliced delivery that never hits an inbox-claim boundary cannot
    // leave the task stuck in input-required (state-machine bug).
    expect(result).toMatchObject({ status: 'working' })
    expect(harness.ledger.get(taskId)?.status).toBe('working')
  })
})

describe('notice compression (merge, dedupe, per-recipient)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('two notices for the same recipient merge into one delivery, each with its own header', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_B))

    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'notice one', 'reminder')
    notifySession(harness.ctx, SESSION_B, TaskId('t-2'), 'notice two', 'timeout')
    flushNoticeMerges(harness.ctx)

    const worker = harness.agents.get(SESSION_B)!
    expect(worker.followups).toHaveLength(1)
    const body = textOf(worker.followups[0])
    expect(body).toContain('<dsh-agent-bus task="t-1" tool="reminder"')
    expect(body).toContain('<dsh-agent-bus task="t-2" tool="timeout"')
    expect(body).toContain('notice one')
    expect(body).toContain('notice two')
  })

  it('a same recipient+task+topic repeat inside the window is deduped', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_B))

    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'first', 'reminder')
    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'first again', 'reminder')
    notifySession(harness.ctx, SESSION_B, TaskId('t-2'), 'other', 'reminder')
    flushNoticeMerges(harness.ctx)

    const body = textOf(harness.agents.get(SESSION_B)!.followups[0])
    expect(body).toContain('first')
    expect(body).not.toContain('first again')
    expect(body).toContain('other')
  })

  it('different topics for the same task are not deduped', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_B))

    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'please report', 'reminder')
    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'task timed out', 'timeout')
    flushNoticeMerges(harness.ctx)

    const body = textOf(harness.agents.get(SESSION_B)!.followups[0])
    expect(body).toContain('please report')
    expect(body).toContain('task timed out')
    expect(body).toContain('tool="timeout"')
  })

  it('notices for the same task go to their own recipients (regression: old key-by-task merge)', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_B))
    harness.agents.add(makeAgent(SESSION_REVIEWER))

    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'for the worker', 'reminder')
    notifySession(harness.ctx, SESSION_REVIEWER, TaskId('t-1'), 'for the reviewer', 'timeout')
    flushNoticeMerges(harness.ctx)

    const workerBody = textOf(harness.agents.get(SESSION_B)!.followups[0])
    const reviewerBody = textOf(harness.agents.get(SESSION_REVIEWER)!.followups[0])
    expect(workerBody).toContain('for the worker')
    expect(workerBody).not.toContain('for the reviewer')
    expect(reviewerBody).toContain('for the reviewer')
    expect(reviewerBody).not.toContain('for the worker')
  })

  it('a notice for a session that is not live is dropped', async () => {
    const harness = await newHarness()
    // SESSION_REVIEWER 未加入 agents 注册表（不在线）。
    notifySession(harness.ctx, SESSION_REVIEWER, TaskId('t-1'), 'ghost', 'reminder')
    flushNoticeMerges(harness.ctx)
    expect(harness.agents.get(SESSION_REVIEWER)).toBeUndefined()
  })

  it('flushNoticeMerges delivers pending batches immediately without waiting for the window', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_B))

    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'now', 'reminder')
    flushNoticeMerges(harness.ctx)

    expect(harness.agents.get(SESSION_B)!.followups).toHaveLength(1)
  })

  it('a single notice keeps the single-header format', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_B))

    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'plain notice', 'reminder')
    flushNoticeMerges(harness.ctx)

    expect(textOf(harness.agents.get(SESSION_B)!.followups[0])).toBe(
      '<dsh-agent-bus task="t-1" tool="reminder" sender="session-b">\nplain notice',
    )
  })

  it('clearNoticeMerges drops pending batches without delivering', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_B))

    notifySession(harness.ctx, SESSION_B, TaskId('t-1'), 'gone', 'reminder')
    clearNoticeMerges()
    flushNoticeMerges(harness.ctx)

    expect(harness.agents.get(SESSION_B)!.followups).toHaveLength(0)
  })

  it('report_task notifies the reviewer through the compressor (real tool path)', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))
    const taskId = TaskId('report-1')
    await harness.ledger.record(makeNewTask({ id: taskId }), 8)
    await harness.ledger.transition(taskId, 'working')

    await harness.run('report_task', { task_id: String(taskId), result: 'all done' }, SESSION_B)

    // 压缩窗口内不立即投递。
    expect(harness.agents.get(SESSION_A)!.followups).toHaveLength(0)
    flushNoticeMerges(harness.ctx)
    expect(textOf(harness.agents.get(SESSION_A)!.followups[0])).toContain('已完成')
  })

  it('a one-segment batch matches the plain single delivery format', () => {
    const plain = textOf(buildTaskMessage(SESSION_A, 't-1', 'hello', 'reminder'))
    const batch = textOf(buildNoticeBatchMessage([{
      sessionId: SESSION_A,
      taskId: TaskId('t-1'),
      tool: 'reminder',
      text: 'hello',
    }]))
    expect(batch).toBe(plain)
  })
})
