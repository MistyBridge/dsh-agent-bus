/**
 * 消息通道单测：send_note 与 create_task 双通道的区分、限流隔离、
 * 配置默认值与上限、离线消息入队/补投语义（v1.5）。
 *
 * 覆盖面（对应 docs/verification.md §1「message-channel」行）：
 * - 双通道 header/消息体：任务头带 ledger 行 id 与 tool，消息头带 message id
 *   且无 ledger 行；source kind 分 agent-bus-task / agent-bus-message；
 * - 消息不落台账、任务落台账：走真实 send_note / create_task execute 体；
 * - 限流隔离：DispatchRateLimiter 滑动窗口（窗口内拒绝/滑出放行/逐发送方
 *   独立/双实例独立），以及工具面上的任务/消息额度互不挤占；
 * - 配置默认值与上限：Config schema 默认值、maxContentLength /
 *   maxPendingPerAgent / maxSendsPerMinute / maxMessagesPerMinute 的拒绝路径，
 *   超限拒绝且不截断；
 * - 离线消息：离线收件人入 pending_messages（attempts 计数、按时间排序、
 *   送达删除、每发送方 50 条上限）。
 *
 * 核心逻辑全部真实实现：ledger（in-memory 域）、DispatchRateLimiter、
 * admitContent、authorize*、delivery 消息构造；仅 agent/workspace 为协作方桩
 * （见 tests/helpers/tool-harness.ts）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as AgentBusConfig } from '../src/index.ts'
import {
  admitContent,
  buildDelayedMessage,
  buildMessageMessage,
  buildTaskMessage,
  deliverTask,
} from '../src/delivery.ts'
import { DispatchRateLimiter } from '../src/rate-limit.ts'
import { TaskId } from '../src/types.ts'
import {
  makeNewTask,
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
  WORKSPACE,
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

/** 一个 send_note 调用的返回面。 */
interface NoteResult {
  readonly delivered: boolean
  readonly queued: boolean
  readonly messageId: string
}

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

describe('delivery message builders (pure)', () => {
  it('buildTaskMessage pins the ledger task id, the tool, and the sender in the relay header', () => {
    const message = buildTaskMessage(SESSION_A, 'task-1', 'do the thing')
    expect(textOf(message)).toBe('<dsh-agent-bus task="task-1" tool="create_task" sender="session-a">\ndo the thing')
  })

  it('buildTaskMessage defaults tool to create_task and lets a mechanism override it', () => {
    const message = buildTaskMessage(SESSION_A, 'task-1', 'body', 'scheduler')
    expect(textOf(message)).toBe('<dsh-agent-bus task="task-1" tool="scheduler" sender="session-a">\nbody')
  })

  it('buildTaskMessage attributes the source as an agent-bus-task relay', () => {
    const message = buildTaskMessage(SESSION_A, 'task-1', 'body')
    expect(message.source).toEqual({ kind: 'agent-bus-task', form: 'relay', senderSessionId: SESSION_A })
    expect(message.role).toBe('user')
    expect(String(message.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('buildMessageMessage pins the message id and send_note tool, with no ledger task id', () => {
    const message = buildMessageMessage(SESSION_A, 'msg-1', 'hello')
    expect(textOf(message)).toBe('<dsh-agent-bus-message tool="send_note" sender="session-a" id="msg-1">\nhello')
    expect(message.source).toEqual({ kind: 'agent-bus-message', form: 'relay', senderSessionId: SESSION_A })
  })

  it('the two channels use distinct headers: task carries the ledger row, message carries only its own id', () => {
    const task = textOf(buildTaskMessage(SESSION_A, 'task-9', 'x'))
    const note = textOf(buildMessageMessage(SESSION_A, 'msg-9', 'x'))
    expect(task).toContain('<dsh-agent-bus task="task-9"')
    expect(task).not.toContain('<dsh-agent-bus-message')
    expect(note).toContain('<dsh-agent-bus-message tool="send_note"')
    expect(note).not.toContain('task=')
  })

  it('buildDelayedMessage stamps the original send time and flags the delayed delivery', () => {
    const sentAt = '2026-08-01T00:00:00.000Z'
    const message = buildDelayedMessage(SESSION_A, 'msg-1', 'hello', sentAt)
    expect(textOf(message)).toBe(
      `<dsh-agent-bus-message tool="send_note" sender="session-a" id="msg-1" delayed="${sentAt}">\n`
      + `[延迟送达,原发送时间 ${sentAt}]\nhello`,
    )
    expect(message.source.kind).toBe('agent-bus-message')
  })

  it('deliverTask routes followup to target.followup and steer to target.steer', () => {
    const target = makeAgent(SESSION_B)
    const followupMessage = buildTaskMessage(SESSION_A, 'task-1', 'x')
    deliverTask(target as unknown as Agent, followupMessage, 'followup')
    expect(target.followups).toHaveLength(1)
    expect(target.followups[0]).toBe(followupMessage)
    expect(target.steers).toHaveLength(0)

    const steerMessage = buildMessageMessage(SESSION_A, 'msg-1', 'y')
    deliverTask(target as unknown as Agent, steerMessage, 'steer')
    expect(target.steers).toHaveLength(1)
    expect(target.steers[0]).toBe(steerMessage)
    expect(target.followups).toHaveLength(1)
  })
})

describe('two-channel distinction through the real tools', () => {
  it('send_note to a live peer delivers a message and records nothing in the ledger', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    const result = await harness.run('send_note', { target: SESSION_B, content: 'ping' }, SESSION_A) as NoteResult
    expect(result.delivered).toBe(true)
    expect(result.queued).toBe(false)
    expect(result.messageId).toMatch(/^[0-9a-f]{8}-/)

    // 消息不落台账：无任务行、无离线消息。
    expect(harness.ledger.listAll()).toHaveLength(0)
    expect(harness.ledger.listPendingNotes()).toHaveLength(0)

    const delivered = harness.agents.get(SESSION_B)!.followups[0]
    expect(textOf(delivered)).toBe(
      `<dsh-agent-bus-message tool="send_note" sender="session-a" id="${result.messageId}">\nping`,
    )
  })

  it('create_task to a live peer records one ledger row and delivers the task on the priority channel', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    const result = await harness.run(
      'create_task', { target: SESSION_B, content: 'do the thing', title: 'Do the thing' }, SESSION_A,
    ) as { taskId: string; status: string }

    const rows = harness.ledger.listAll()
    expect(rows).toHaveLength(1)
    expect(result.taskId).toBe(String(rows[0]!.id))
    expect(result.status).toBe('submitted')
    expect(rows[0]!.assignedBy).toBe(SESSION_A)
    expect(rows[0]!.assignedTo).toBe(SESSION_B)

    // 任务投递默认走优先级通道（steer / next-step），先于任何 next-turn 消息被认领。
    const delivered = harness.agents.get(SESSION_B)!.steers[0]
    expect(textOf(delivered)).toBe(
      `<dsh-agent-bus task="${result.taskId}" tool="create_task" sender="session-a">\ndo the thing`,
    )
  })

  it('the delivered task carries the ledger row identity while the message carries none', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('create_task', { target: SESSION_B, content: 'work', title: 'Work' }, SESSION_A)
    await harness.run('send_note', { target: SESSION_B, content: 'note' }, SESSION_A)

    // 任务在优先级通道（steers），消息在普通通道（followups）。
    const taskDelivery = harness.agents.get(SESSION_B)!.steers[0]
    const noteDelivery = harness.agents.get(SESSION_B)!.followups[0]
    expect(textOf(taskDelivery)).toContain('<dsh-agent-bus task="')
    expect(textOf(taskDelivery)).not.toContain('<dsh-agent-bus-message')
    expect(textOf(noteDelivery)).toContain('<dsh-agent-bus-message')
    expect(textOf(noteDelivery)).not.toContain('task="')
  })

  it('send_note sanitizes control sequences before delivery', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('send_note', { target: SESSION_B, content: 'say \u001b[31mhi\u001b[0m' }, SESSION_A)

    const delivered = harness.agents.get(SESSION_B)!.followups[0]
    expect(textOf(delivered)).toContain('\nsay hi')
    expect(textOf(delivered)).not.toContain('\u001b')
  })

  it('send_note refuses self-delivery', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('send_note', { target: SESSION_A, content: 'to myself' }, SESSION_A),
    ).rejects.toThrow('a session cannot send a note to itself')
  })

  it('send_note refuses a recipient outside the caller workspace', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('send_note', { target: SessionId('stranger'), content: 'hi' }, SESSION_A),
    ).rejects.toThrow('is not a session of your workspace')
  })

  it('send_note refuses an archived recipient', async () => {
    const harness = await newHarness({ archived: [SESSION_REVIEWER] })
    harness.agents.add(makeAgent(SESSION_A))
    await expect(
      harness.run('send_note', { target: SESSION_REVIEWER, content: 'hi' }, SESSION_A),
    ).rejects.toThrow('is archived; unarchive it in the workspace before sending notes')
  })
})

describe('DispatchRateLimiter sliding window (unit)', () => {
  it('admits up to maxPerWindow dispatches inside the window', () => {
    const limiter = new DispatchRateLimiter(2, 1000)
    expect(limiter.admit(SESSION_A, 0)).toBe(true)
    expect(limiter.admit(SESSION_A, 500)).toBe(true)
  })

  it('refuses the dispatch that would exceed the window ceiling', () => {
    const limiter = new DispatchRateLimiter(2, 1000)
    expect(limiter.admit(SESSION_A, 0)).toBe(true)
    expect(limiter.admit(SESSION_A, 1)).toBe(true)
    expect(limiter.admit(SESSION_A, 2)).toBe(false)
  })

  it('re-admits once entries slide out at the exact window boundary', () => {
    const limiter = new DispatchRateLimiter(2, 1000)
    expect(limiter.admit(SESSION_A, 0)).toBe(true)
    expect(limiter.admit(SESSION_A, 1)).toBe(true)
    expect(limiter.admit(SESSION_A, 2)).toBe(false)
    // 恰好一个窗口之后：t=0 与 t=1 都已滑出，窗口腾空。
    expect(limiter.admit(SESSION_A, 1002)).toBe(true)
  })

  it('an entry exactly one window old is already outside the window', () => {
    const limiter = new DispatchRateLimiter(2, 1000)
    expect(limiter.admit(SESSION_A, 0)).toBe(true)
    // t=1000 时 cutoff=0，t=0 恰好等于 cutoff，被滑出。
    expect(limiter.admit(SESSION_A, 1000)).toBe(true)
  })

  it('keeps one sliding window per sender', () => {
    const limiter = new DispatchRateLimiter(1, 1000)
    expect(limiter.admit(SESSION_A, 0)).toBe(true)
    expect(limiter.admit(SESSION_A, 1)).toBe(false)
    expect(limiter.admit(SESSION_B, 1)).toBe(true)
    expect(limiter.admit(SESSION_B, 2)).toBe(false)
  })

  it('two limiter instances are independent (task vs message windows)', () => {
    const taskLimiter = new DispatchRateLimiter(1, 1000)
    const messageLimiter = new DispatchRateLimiter(1, 1000)
    expect(taskLimiter.admit(SESSION_A, 0)).toBe(true)
    expect(taskLimiter.admit(SESSION_A, 1)).toBe(false)
    // 任务额度耗尽不影响消息额度：同一发送方、同一时刻。
    expect(messageLimiter.admit(SESSION_A, 1)).toBe(true)
  })
})

describe('channel rate limits at the tool surface', () => {
  it('create_task refuses the dispatch over maxSendsPerMinute and records nothing', async () => {
    const harness = await newHarness({ config: { maxSendsPerMinute: 2 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('create_task', { target: SESSION_B, content: 'one', title: 'One' }, SESSION_A)
    await harness.run('create_task', { target: SESSION_B, content: 'two', title: 'Two' }, SESSION_A)
    await expect(
      harness.run('create_task', { target: SESSION_B, content: 'three', title: 'Three' }, SESSION_A),
    ).rejects.toThrow('dispatch rate exceeded: at most 2 sends per minute')

    expect(harness.ledger.listAll()).toHaveLength(2)
  })

  it('send_note refuses the message over maxMessagesPerMinute and delivers nothing', async () => {
    const harness = await newHarness({ config: { maxMessagesPerMinute: 2 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('send_note', { target: SESSION_B, content: 'one' }, SESSION_A)
    await harness.run('send_note', { target: SESSION_B, content: 'two' }, SESSION_A)
    await expect(
      harness.run('send_note', { target: SESSION_B, content: 'three' }, SESSION_A),
    ).rejects.toThrow('message rate exceeded: at most 2 messages per minute')

    expect(harness.agents.get(SESSION_B)!.followups).toHaveLength(2)
    expect(harness.ledger.listPendingNotes()).toHaveLength(0)
  })

  it('exhausting the task quota does not exhaust the message quota', async () => {
    const harness = await newHarness({ config: { maxSendsPerMinute: 2 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('create_task', { target: SESSION_B, content: 'one', title: 'One' }, SESSION_A)
    await harness.run('create_task', { target: SESSION_B, content: 'two', title: 'Two' }, SESSION_A)
    await expect(
      harness.run('create_task', { target: SESSION_B, content: 'three', title: 'Three' }, SESSION_A),
    ).rejects.toThrow('dispatch rate exceeded')

    // 任务额度满了，消息额度仍是满的：send_note 照常送达。
    const note = await harness.run('send_note', { target: SESSION_B, content: 'still works' }, SESSION_A) as NoteResult
    expect(note.delivered).toBe(true)
  })

  it('exhausting the message quota does not exhaust the task quota', async () => {
    const harness = await newHarness({ config: { maxMessagesPerMinute: 2 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('send_note', { target: SESSION_B, content: 'one' }, SESSION_A)
    await harness.run('send_note', { target: SESSION_B, content: 'two' }, SESSION_A)
    await expect(
      harness.run('send_note', { target: SESSION_B, content: 'three' }, SESSION_A),
    ).rejects.toThrow('message rate exceeded')

    const task = await harness.run(
      'create_task', { target: SESSION_B, content: 'task still works', title: 'Task' }, SESSION_A,
    ) as { status: string }
    expect(task.status).toBe('submitted')
  })
})

describe('config defaults and ceilings', () => {
  it('the Config schema defaults match the documented channel ceilings', () => {
    const parsed = AgentBusConfig({}) as Record<string, number>
    expect(parsed.maxContentLength).toBe(16000)
    expect(parsed.maxPendingPerAgent).toBe(20)
    expect(parsed.maxSendsPerMinute).toBe(10)
    expect(parsed.maxMessagesPerMinute).toBe(20)
    expect(parsed.maxInlineReport).toBe(400)
  })

  it('admitContent admits content exactly at the limit, whole and untrimmed beyond whitespace', () => {
    const admitted = admitContent('a'.repeat(5), 5)
    expect(admitted.ok).toBe(true)
    if (admitted.ok) expect(admitted.content).toBe('a'.repeat(5))
  })

  it('admitContent refuses content one over the limit and names both counts, without truncating', () => {
    const refused = admitContent('a'.repeat(6), 5)
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.message).toContain('6 characters')
      expect(refused.message).toContain('5 limit')
    }
  })

  it('create_task refuses over-limit content at the tool surface instead of truncating it', async () => {
    const harness = await newHarness({ config: { maxContentLength: 5 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await expect(
      harness.run('create_task', { target: SESSION_B, content: 'a'.repeat(6), title: 'T' }, SESSION_A),
    ).rejects.toThrow('content is 6 characters, over the 5 limit')
    expect(harness.ledger.listAll()).toHaveLength(0)
    expect(harness.agents.get(SESSION_B)!.followups).toHaveLength(0)
  })

  it('send_note refuses over-limit content at the tool surface instead of truncating it', async () => {
    const harness = await newHarness({ config: { maxContentLength: 5 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await expect(
      harness.run('send_note', { target: SESSION_B, content: 'a'.repeat(6) }, SESSION_A),
    ).rejects.toThrow('content is 6 characters, over the 5 limit')
    expect(harness.agents.get(SESSION_B)!.followups).toHaveLength(0)
  })

  it('maxPendingPerAgent admits exactly the cap and refuses one more (ledger level)', async () => {
    const harness = await newHarness({ config: { maxPendingPerAgent: 2 } })
    const first = await harness.ledger.record(makeNewTask({ id: TaskId('p-1') }), 2)
    const second = await harness.ledger.record(makeNewTask({ id: TaskId('p-2') }), 2)
    const third = await harness.ledger.record(makeNewTask({ id: TaskId('p-3') }), 2)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.message).toContain('2 limit')
  })

  it('create_task refuses when the recipient queue is at maxPendingPerAgent (tool level)', async () => {
    const harness = await newHarness({ config: { maxPendingPerAgent: 1 } })
    harness.agents.add(makeAgent(SESSION_A))
    harness.agents.add(makeAgent(SESSION_B))

    await harness.run('create_task', { target: SESSION_B, content: 'one', title: 'One' }, SESSION_A)
    await expect(
      harness.run('create_task', { target: SESSION_B, content: 'two', title: 'Two' }, SESSION_A),
    ).rejects.toThrow('already has 1 unfinished tasks, at the 1 limit')
    expect(harness.ledger.listAll()).toHaveLength(1)
  })
})

describe('offline notes (durable queue, v1.5)', () => {
  it('send_note to an offline workspace session queues the note durably and reports queued', async () => {
    const harness = await newHarness()
    harness.agents.add(makeAgent(SESSION_A))
    // SESSION_REVIEWER 在工作区注册表里但不在线（未加入 agents 注册表）。

    const result = await harness.run(
      'send_note', { target: SESSION_REVIEWER, content: 'see you later' }, SESSION_A,
    ) as NoteResult
    expect(result.delivered).toBe(false)
    expect(result.queued).toBe(true)

    const notes = harness.ledger.listPendingNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.id).toBe(result.messageId)
    expect(notes[0]!.sender).toBe(SESSION_A)
    expect(notes[0]!.recipient).toBe(SESSION_REVIEWER)
    expect(notes[0]!.content).toBe('see you later')
    expect(notes[0]!.attempts).toBe(0)
    expect(new Date(notes[0]!.sentAt).toISOString()).toBe(notes[0]!.sentAt)
    expect(new Date(notes[0]!.createdAt).toISOString()).toBe(notes[0]!.createdAt)
    // 任务台账仍然为空：离线消息不产生任务行。
    expect(harness.ledger.listAll()).toHaveLength(0)
  })

  it('listPendingNotes returns queued notes oldest first by createdAt', async () => {
    const harness = await newHarness()
    await harness.ledger.queueNote({
      id: 'n-1', sender: SESSION_A, recipient: SESSION_B, content: 'older',
      sentAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', attempts: 0,
    })
    await harness.ledger.queueNote({
      id: 'n-2', sender: SESSION_A, recipient: SESSION_B, content: 'newer',
      sentAt: '2026-08-01T00:10:00.000Z', createdAt: '2026-08-01T00:10:00.000Z', attempts: 0,
    })
    const notes = harness.ledger.listPendingNotes()
    expect(notes.map(note => note.id)).toEqual(['n-1', 'n-2'])
  })

  it('markNoteAttempt persists the attempt count (sweep retry semantics)', async () => {
    const harness = await newHarness()
    await harness.ledger.queueNote({
      id: 'n-1', sender: SESSION_A, recipient: SESSION_B, content: 'hi',
      sentAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', attempts: 0,
    })
    await harness.ledger.markNoteAttempt('n-1', 1)
    await harness.ledger.markNoteAttempt('n-1', 3)
    expect(harness.ledger.listPendingNotes()[0]!.attempts).toBe(3)
  })

  it('deleteNote removes a delivered note from the queue', async () => {
    const harness = await newHarness()
    await harness.ledger.queueNote({
      id: 'n-1', sender: SESSION_A, recipient: SESSION_B, content: 'hi',
      sentAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', attempts: 0,
    })
    await harness.ledger.queueNote({
      id: 'n-2', sender: SESSION_A, recipient: SESSION_B, content: 'bye',
      sentAt: '2026-08-01T00:01:00.000Z', createdAt: '2026-08-01T00:01:00.000Z', attempts: 0,
    })
    await harness.ledger.deleteNote('n-1')
    expect(harness.ledger.listPendingNotes().map(note => note.id)).toEqual(['n-2'])
  })

  it('the offline queue caps at 50 notes per sender', async () => {
    const harness = await newHarness({ config: { maxMessagesPerMinute: 100 } })
    harness.agents.add(makeAgent(SESSION_A))

    for (let index = 0; index < 50; index += 1) {
      const result = await harness.run(
        'send_note', { target: SESSION_REVIEWER, content: `note ${index}` }, SESSION_A,
      ) as NoteResult
      expect(result.queued).toBe(true)
    }
    await expect(
      harness.run('send_note', { target: SESSION_REVIEWER, content: 'overflow' }, SESSION_A),
    ).rejects.toThrow('your offline note queue is full (50)')
    expect(harness.ledger.listPendingNotes()).toHaveLength(50)
  })
})
