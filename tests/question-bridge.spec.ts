/**
 * 决策 9 单测：`ask_user_question` 提问转交任务发起方。
 *
 * 覆盖面（对应 docs/verification.md 决策 9 / acceptance criteria）：
 * - A2A 转发：worker 执行 working 任务中调 ask_user_question → 任务
 *   input-required、问题（含选项）序列化进任务记录、PM 被通知、
 *   answer_question 后 worker 收到结构化答案、任务回 working；
 * - user↔A 不转发：无 working 任务 / 非 ask_user_question / 无 agent →
 *   next() 被调用，agent-bus 不介入（无状态变更、无通知）；
 * - PM 越权拒绝：非 assignedBy 调 answer_question → 「仅任务发起方可回答」；
 * - 超时兜底：PM 不响应 → fail-closed，worker 收到 isError、任务回 working；
 * - 边界：PM 自己执行任务时提问转给它的发起方；任务死亡（failed/canceled）
 *   时挂起提问被 reject；答案校验（未知 id / 非选项 / 多选超限 / custom）。
 *
 * 核心逻辑全部真实实现：ledger（in-memory 域）、QuestionRegistry、
 * question-bridge wrapper、answer_question 工具体；仅 ctx 事件面
 * （on/emit/agents）为协作方桩。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { clearNoticeMerges, flushNoticeMerges } from '../src/delivery.ts'
import { TaskLedger } from '../src/ledger.ts'
import {
  QuestionRegistry,
  registerQuestionBridge,
  normalizeQuestionAnswers,
  type PendingAsk,
} from '../src/question-bridge.ts'
import { DispatchRateLimiter } from '../src/rate-limit.ts'
import { registerAgentBusTools, type ToolsConfig, type ToolsDeps } from '../src/tools.ts'
import { TaskId, type PendingQuestion, type QuestionAnswer } from '../src/domain/types.ts'
import {
  createMemoryCtx,
  makeNewTask,
  SESSION_A,
  SESSION_B,
  SESSION_REVIEWER,
  WORKSPACE,
} from './helpers/memory-ctx.ts'
import { FakeAgentRegistry, makeAgent, type FakeAgent } from './helpers/tool-harness.ts'

/** 收件箱消息的 model 可见文本。 */
function textOf(message: unknown): string {
  const block = (message as { content: { type: string; text: string }[] }).content[0]
  if (block === undefined) throw new Error('message has no text block')
  return block.text
}

/** 让 async 监听器的首个 await（ledger 写链）落地后再断言。 */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** 一个最小合法的 ask_user_question 调用。 */
function askExec(agent: FakeAgent | undefined, questions: unknown, signal = new AbortController().signal): unknown {
  return {
    name: 'ask_user_question',
    ...(agent !== undefined ? { agent } : {}),
    arguments: { questions },
    signal,
  }
}

/** 构造一个 user/message 事件(带 source)以拼装 session.events。 */
function messageEvent(message: UserMessage, seq = 1): SessionEvent {
  return { type: 'user/message', seq, time: 0, data: message }
}

/** 任务投递消息(agent-bus-task relay source)。 */
function taskMessage(messageId: string, sender: SessionId = SESSION_A): UserMessage {
  return {
    id: MessageId(messageId),
    role: 'user',
    content: [{ type: 'text', text: `<dsh-agent-bus task="t1" tool="create_task" sender="${sender}">\ndo the thing` }],
    source: { kind: 'agent-bus-task', form: 'relay', senderSessionId: sender },
  }
}

/** 直接人类提示消息(user source)。 */
function humanMessage(messageId: string): UserMessage {
  return {
    id: MessageId(messageId),
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }
}

/** 注入上下文消息(plugin source,agent.inject() 一类)。 */
function injectMessage(messageId: string): UserMessage {
  return {
    id: MessageId(messageId),
    role: 'user',
    content: [{ type: 'text', text: 'injected context' }],
    source: { kind: 'plugin', plugin: 'agent-instructions' },
  }
}

/** 打开 turn 的事件序列:turn/start + 后续 user/message(默认没有);可再加 turn/end 关闭。 */
function turns(...messages: UserMessage[]): SessionEvent[] {
  const events: SessionEvent[] = [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }]
  for (let index = 0; index < messages.length; index++) {
    events.push(messageEvent(messages[index]!, index + 1))
  }
  return events
}

/** 一个已关闭的 turn(open turn 不存在):turn/start 后紧跟 turn/end。 */
function closedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** 测试基座：真实 ledger + 捕获的 tools/execute 监听 + 已注册的 answer_question。 */
interface BridgeHarness {
  readonly ledger: TaskLedger
  readonly questions: QuestionRegistry
  readonly tools: Map<string, ToolDefinition>
  readonly agents: FakeAgentRegistry
  /** 按事件名捕获的监听器（tools/execute、agent-bus/task-changed）。 */
  readonly handlers: Map<string, (...args: unknown[]) => unknown>
  /** 调用 tools/execute 监听器（不 await），返回待决 promise 与 next spy。 */
  invoke(exec: unknown): { readonly promise: Promise<unknown>; readonly next: ReturnType<typeof vi.fn> }
  /** 以 caller 身份调用已注册工具的真实 execute 体。 */
  runTool(name: string, args: unknown, caller: FakeAgent): Promise<unknown>
  /** 立即投递合并窗口内的系统通知（decision 3 批处理）。 */
  notify(): void
  dispose(): Promise<void>
}

async function createBridgeHarness(questionTimeoutMs = 60_000): Promise<BridgeHarness> {
  const base = await createMemoryCtx()
  const ledger = await TaskLedger.open(base.ctx)
  const questions = new QuestionRegistry()
  const tools = new Map<string, ToolDefinition>()
  const agents = new FakeAgentRegistry()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const config: ToolsConfig = {
    maxContentLength: 16000,
    maxPendingPerAgent: 20,
    maxSendsPerMinute: 10,
    maxMessagesPerMinute: 20,
    maxInlineReport: 400,
  }
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    agents,
    sessionTitle: { get: () => undefined },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(event, listener)
      return () => handlers.delete(event)
    },
    emit: () => {},
    get: () => undefined,
    effect: () => () => {},
  } as unknown as Context
  const deps: ToolsDeps = {
    ledger,
    workspaces: {
      resolveByPath: async () => undefined,
      list: () => [],
      archivedSessionIds: [],
    } as never,
    limiter: new DispatchRateLimiter(10, 60_000),
    messageLimiter: new DispatchRateLimiter(20, 60_000),
    reports: {
      save: async () => '',
      read: async () => undefined,
      archive: async () => {},
      sweep: async () => 0,
    } as never,
    questions,
    // 心跳活跃态记录面(决策 2):本套件不驱动心跳,no-op。
    noteActivity: () => {},
  }
  registerAgentBusTools(ctx, config, deps)
  registerQuestionBridge(ctx, ledger, questions, { questionTimeoutMs })
  return {
    ledger,
    questions,
    tools,
    agents,
    handlers,
    invoke: (exec) => {
      const listener = handlers.get('tools/execute')
      if (listener === undefined) throw new Error('no tools/execute listener registered')
      const next = vi.fn(async () => ({
        isError: false,
        value: { answers: [] },
        content: [{ type: 'text', text: 'original-chain' }],
      }))
      const promise = Promise.resolve(
        (listener as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>)(exec, next),
      )
      return { promise, next }
    },
    runTool: async (name, args, caller) => {
      const def = tools.get(name)
      if (def === undefined) throw new Error(`tool "${name}" is not registered in the harness`)
      return def.execute(args, { agent: caller as unknown as Agent } as unknown as ToolRunContext)
    },
    notify: () => flushNoticeMerges(ctx),
    dispose: () => base.dispose(),
  }
}

/** 建立一个 A 派发给 B 且已进入 working 的任务;messageId 与 worker 的 turn 消息对应。 */
async function workingTask(h: BridgeHarness, id = 't1', messageId = 'msg-1'): Promise<void> {
  const created = await h.ledger.record(makeNewTask({
    id: TaskId(id),
    assignedBy: SESSION_A,
    assignedTo: SESSION_B,
    workspacePath: WORKSPACE,
    messageId,
  }), 20)
  expect(created.ok).toBe(true)
  const advanced = await h.ledger.transition(TaskId(id), 'working')
  expect(advanced.ok).toBe(true)
}

const ONE_QUESTION = [
  {
    id: 'q1',
    question: 'Which approach?',
    header: 'Choose',
    options: [{ label: 'Option A', description: 'fast' }, { label: 'Option B' }],
    multi_select: false,
  },
]

describe('决策9 question-bridge：A2A 转发', () => {
  afterEach(() => {
    clearNoticeMerges()
  })

  it('worker 任务中提问 → 任务 input-required、问题入记录、PM 被通知、回答后 worker 收到答案', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    await tick()

    // 任务暂停，问题（含选项）序列化进记录。
    const paused = h.ledger.get(TaskId('t1'))
    expect(paused?.status).toBe('input-required')
    expect(paused?.pendingQuestions?.[0]).toMatchObject({
      id: 'q1',
      question: 'Which approach?',
      header: 'Choose',
      multiSelect: false,
    })
    expect(paused?.pendingQuestions?.at(0)?.options.map(option => option.label)).toEqual(['Option A', 'Option B'])
    expect(next).not.toHaveBeenCalled()

    // PM 收到含问题与选项的通知。
    h.notify()
    expect(pm.followups).toHaveLength(1)
    const notice = textOf(pm.followups[0])
    expect(notice).toContain('q1')
    expect(notice).toContain('Which approach?')
    expect(notice).toContain('Option A')
    expect(notice).toContain('answer_question')

    // PM 回答 → worker 收到结构化答案，任务回 working。
    const answered = await h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: ['Option A'] }],
    }, pm)
    expect(answered).toEqual({ taskId: 't1', status: 'working', answered: 1 })

    const outcome = await promise
    expect(outcome).toMatchObject({
      isError: false,
      value: { answers: [{ id: 'q1', selected: ['Option A'] }] },
    })
    const resumed = h.ledger.get(TaskId('t1'))
    expect(resumed?.status).toBe('working')
    expect(resumed?.pendingQuestions).toBeUndefined()
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })

  it('PM 自己执行任务时提问 → 转给它的发起方，而不是自己', async () => {
    const h = await createBridgeHarness()
    const pm = makeAgent(SESSION_A, { events: turns(taskMessage('msg-1')) })
    const reviewer = makeAgent(SESSION_REVIEWER)
    h.agents.add(pm)
    h.agents.add(reviewer)
    const created = await h.ledger.record(makeNewTask({
      id: TaskId('pm-task'),
      assignedBy: SESSION_REVIEWER,
      assignedTo: SESSION_A,
      workspacePath: WORKSPACE,
      messageId: 'msg-1',
    }), 20)
    expect(created.ok).toBe(true)
    await h.ledger.transition(TaskId('pm-task'), 'working')

    const { promise, next } = h.invoke(askExec(pm, ONE_QUESTION))
    await tick()
    expect(next).not.toHaveBeenCalled()
    h.notify()
    // 通知发给发起方（reviewer），不是 PM 自己。
    expect(reviewer.followups).toHaveLength(1)
    expect(pm.followups).toHaveLength(0)
    // PM 不是该任务的发起方 → 不能自己回答。
    await expect(h.runTool('answer_question', {
      task_id: 'pm-task',
      answers: [{ id: 'q1', selected: ['Option A'] }],
    }, pm)).rejects.toThrow('仅任务发起方可回答')
    // 发起方回答。
    const answered = await h.runTool('answer_question', {
      task_id: 'pm-task',
      answers: [{ id: 'q1', selected: ['Option B'] }],
    }, reviewer)
    expect(answered).toEqual({ taskId: 'pm-task', status: 'working', answered: 1 })
    const outcome = await promise
    expect(outcome).toMatchObject({ isError: false, value: { answers: [{ id: 'q1', selected: ['Option B'] }] } })
    await h.dispose()
  })

  it('问题含 custom 自由文本时随答案返回', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise } = h.invoke(askExec(worker, [
      { id: 'q1', question: 'Any notes?', options: [] },
    ]))
    await tick()
    const answered = await h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: [], custom: 'free text' }],
    }, pm)
    expect(answered).toEqual({ taskId: 't1', status: 'working', answered: 1 })
    const outcome = await promise
    expect(outcome).toMatchObject({ isError: false, value: { answers: [{ id: 'q1', selected: [], custom: 'free text' }] } })
    await h.dispose()
  })
})

describe('决策9 question-bridge：user↔A 不转发(注入上下文判定)', () => {
  afterEach(() => {
    clearNoticeMerges()
  })

  it('无 open turn(无事件)→ next() 被调用,走原链路', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B)
    h.agents.add(worker)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    // 无状态变更、无挂起、无通知。
    expect(h.ledger.listAll()).toHaveLength(0)
    expect(h.questions.size).toBe(0)
    expect(worker.followups).toHaveLength(0)
    await h.dispose()
  })

  it('有 open turn 但首个 user/message 是直接人类提示 → next()(即使有 working 任务)', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(humanMessage('hi-1')) })
    h.agents.add(worker)
    await workingTask(h)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    // 任务保持 working,未被当作 A2A 暂停。
    expect(h.ledger.get(TaskId('t1'))?.status).toBe('working')
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })

  it('有 open turn 但首个 user/message 是注入上下文(plugin)→ next()', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(injectMessage('inj-1')) })
    h.agents.add(worker)
    await workingTask(h)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    expect(h.ledger.get(TaskId('t1'))?.status).toBe('working')
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })

  it('turn 已关闭(turn/end 紧跟 turn/start)→ next()', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: closedTurn() })
    h.agents.add(worker)
    await workingTask(h)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    await h.dispose()
  })

  it('通知消息同 source.kind 但 findByMessage 未命中 → next()', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('notif-1')) })
    h.agents.add(worker)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    // 无 ledger 行可断言——该消息不是投递。
    expect(h.ledger.listAll()).toHaveLength(0)
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })

  it('任务 assignedTo 不是调用者 → next()', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    h.agents.add(worker)
    const created = await h.ledger.record(makeNewTask({
      id: TaskId('t-other'),
      assignedBy: SESSION_A,
      assignedTo: SESSION_A,
      workspacePath: WORKSPACE,
      messageId: 'msg-1',
    }), 20)
    expect(created.ok).toBe(true)
    await h.ledger.transition(TaskId('t-other'), 'working')

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })

  it('非 ask_user_question 工具 → 即使有任务 turn 也不拦截', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    h.agents.add(worker)
    await workingTask(h)

    const { promise, next } = h.invoke({
      name: 'send_note',
      agent: worker,
      arguments: { target: 'x', content: 'hi' },
      signal: new AbortController().signal,
    })
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    const task = h.ledger.get(TaskId('t1'))
    expect(task?.status).toBe('working')
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })

  it('无 agent 的执行（agent-less）→ next() 被调用', async () => {
    const h = await createBridgeHarness()
    const { promise, next } = h.invoke(askExec(undefined, ONE_QUESTION))
    const outcome = await promise
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
    await h.dispose()
  })

  it('questions 参数畸形 → 保守放行 next()', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    h.agents.add(worker)
    await workingTask(h)

    for (const malformed of [{ questions: 'nope' }, { questions: [] }, { questions: [{ id: 1, question: 'x' }] }]) {
      const { promise, next } = h.invoke(askExec(worker, malformed))
      const outcome = await promise
      expect(next).toHaveBeenCalledTimes(1)
      expect(outcome).toMatchObject({ isError: false, value: { answers: [] } })
      expect(h.questions.size).toBe(0)
    }
    const task = h.ledger.get(TaskId('t1'))
    expect(task?.status).toBe('working')
    await h.dispose()
  })
})

describe('决策9 answer_question：鉴权与校验', () => {
  afterEach(() => {
    clearNoticeMerges()
  })

  it('仅 assignedBy（PM）可回答；worker 与第三方越权被拒', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    const pm = makeAgent(SESSION_A)
    const stranger = makeAgent(SESSION_REVIEWER)
    h.agents.add(worker)
    h.agents.add(pm)
    h.agents.add(stranger)
    await workingTask(h)
    h.invoke(askExec(worker, ONE_QUESTION))

    await expect(h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: ['Option A'] }],
    }, worker)).rejects.toThrow('仅任务发起方可回答')
    await expect(h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: ['Option A'] }],
    }, stranger)).rejects.toThrow('仅任务发起方可回答')
    await h.dispose()
  })

  it('未知任务 id / 无待答问题 → 明确报错', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B)
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    await expect(h.runTool('answer_question', {
      task_id: 'missing',
      answers: [{ id: 'q1', selected: [] }],
    }, pm)).rejects.toThrow('no such task "missing"')

    // 任务还在 working（无提问挂起）时回答 → 无待答问题。
    await expect(h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: [] }],
    }, pm)).rejects.toThrow('no pending question to answer')
    await h.dispose()
  })

  it('答案校验：未知问题 id、非选项选择、多选超限、custom 类型错误', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)
    h.invoke(askExec(worker, ONE_QUESTION))
    await tick()

    await expect(h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'nope', selected: [] }],
    }, pm)).rejects.toThrow('answer "nope" does not match any pending question')
    await expect(h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: ['Not An Option'] }],
    }, pm)).rejects.toThrow('answer "q1" selected "Not An Option" which is not an offered option')
    // 单选问题选两个 → 拒绝。
    await expect(h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: ['Option A', 'Option B'] }],
    }, pm)).rejects.toThrow('question allows one')
    // custom 类型错误由工具参数 schema 在 execute 前拒绝（harness 侧）。
    await expect(h.runTool('answer_question', {
      task_id: 't1',
      answers: [{ id: 'q1', selected: [], custom: 42 }],
    }, pm)).rejects.toThrow(/invalid arguments/)
    await h.dispose()
  })
})

describe('决策9 超时与任务死亡兜底', () => {
  afterEach(() => {
    clearNoticeMerges()
  })

  it('PM 不响应 → 超时 fail-closed，worker 收到 isError、任务回 working', async () => {
    const h = await createBridgeHarness(20)
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    expect(next).not.toHaveBeenCalled()
    const outcome = await promise
    expect(outcome).toMatchObject({ isError: true })
    expect((outcome as { error: { message: string } }).error.message).toContain('timed out')
    const task = h.ledger.get(TaskId('t1'))
    expect(task?.status).toBe('working')
    expect(task?.pendingQuestions).toBeUndefined()
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })

  it('任务死亡（failed/canceled）→ 挂起提问被 reject，worker 收到明确错误', async () => {
    const h = await createBridgeHarness()
    const worker = makeAgent(SESSION_B, { events: turns(taskMessage('msg-1')) })
    const pm = makeAgent(SESSION_A)
    h.agents.add(worker)
    h.agents.add(pm)
    await workingTask(h)

    const { promise, next } = h.invoke(askExec(worker, ONE_QUESTION))
    await tick()
    expect(next).not.toHaveBeenCalled()
    const taskChanged = h.handlers.get('agent-bus/task-changed')
    expect(taskChanged).toBeDefined()
    ;(taskChanged as (change: unknown) => void)({
      taskId: 't1', from: 'input-required', to: 'failed', at: new Date().toISOString(),
    })
    const outcome = await promise
    expect(outcome).toMatchObject({ isError: true })
    expect((outcome as { error: { message: string } }).error.message).toContain('no longer pending')
    expect(h.questions.size).toBe(0)
    await h.dispose()
  })
})

describe('决策9 纯函数：normalizeQuestionAnswers / parseQuestions', () => {
  const questions: PendingQuestion[] = [{
    id: 'q1',
    question: 'Which?',
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: false,
  }, {
    id: 'q2',
    question: 'Pick many',
    options: [{ label: 'X' }, { label: 'Y' }],
    multiSelect: true,
  }]

  it('合法答案归一化为官方 Answer item 结构', () => {
    expect(normalizeQuestionAnswers([
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['X', 'Y'], custom: 'extra' },
    ], questions)).toEqual([
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['X', 'Y'], custom: 'extra' },
    ])
  })

  it('空数组 / 非数组 / 缺少 selected → 报错', () => {
    expect(() => normalizeQuestionAnswers([], questions)).toThrow('answers must not be empty')
    expect(() => normalizeQuestionAnswers('nope', questions)).toThrow('answers must be an array')
    expect(() => normalizeQuestionAnswers([{ id: 'q1' }], questions)).toThrow('requires a selected array')
  })

  it('多选问题允许多个选择，单选超限报错', () => {
    expect(normalizeQuestionAnswers([{ id: 'q2', selected: ['X', 'Y'] }], questions)).toHaveLength(1)
    expect(() => normalizeQuestionAnswers([{ id: 'q1', selected: ['A', 'B'] }], questions))
      .toThrow('question allows one')
  })
})
