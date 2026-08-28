/**
 * Decision 9: route `ask_user_question` tool calls from a worker executing an
 * agent-bus task to the task initiator (PM), instead of the human.
 *
 * A `tools/execute` around-wrapper claims the call (does not call `next()`)
 * only when the calling agent is currently executing a `working` agent-bus
 * task: the questions are persisted on the row, the task pauses
 * (`input-required`), the initiator is notified, and the wrapper resolves
 * with the initiator's structured answer. Every other call — a different
 * tool, an agent-less execution, or a caller with no working task (a
 * human-agent conversation) — delegates to `next()` untouched, so the dsh
 * original chain (the human answerer) serves it exactly as before.
 *
 * The pending ask registry is shared with the `answer_question` tool: the
 * bridge registers while waiting, the tool resolves.
 *
 * @module dsh-agent-bus/question-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { notifySession } from './delivery.ts'
import type { TaskLedger } from './ledger.ts'
import { TaskId, type PendingQuestion, type PendingQuestionOption, type QuestionAnswer, type QuestionAnswerItem } from './domain/types.ts'

/**
 * The user message that claimed the current open turn, or `undefined`.
 *
 * The A2A judge answers "is the caller mid-a-task?" from the injected context
 * rather than the ledger's `findWorkingFor`: a session can hold a `working`
 * task row yet be chatting (a plain user turn) — only the turn's first
 * `user/message` tells the two apart. The first message is the queued input
 * that opened the turn; injected contexts (`agent.inject()` file notices,
 * skill content, AGENTS.md) are appended afterwards, so a task-triggered turn
 * starts with the `<dsh-agent-bus ...>` relay.
 *
 * @param session - the calling agent's session log.
 * @returns the turn's first user message, or `undefined` when no turn is open.
 */
export function currentTurnTaskMessage(session: Session): UserMessage | undefined {
  const events: readonly SessionEvent[] = session.events ?? []
  // The latest turn boundary decides open/closed: a trailing turn/end closes
  // the turn (no open turn); a trailing turn/start leaves one open.
  let openFrom = -1
  for (let index = events.length - 1; index >= 0; index--) {
    const type = events[index]?.type
    if (type === 'turn/end') return undefined
    if (type === 'turn/start') {
      openFrom = index
      break
    }
  }
  if (openFrom === -1) return undefined
  for (let index = openFrom + 1; index < events.length; index++) {
    const event = events[index]
    if (event?.type === 'user/message') return event.data
  }
  return undefined
}

/**
 * One registered, still-pending question ask, awaiting the initiator's
 * answer. The promise pair belongs to the bridge's waiting wrapper.
 */
export interface PendingAsk {
  readonly taskId: TaskId
  /** The worker session that asked. */
  readonly worker: string
  /** The initiator session that must answer. */
  readonly pm: string
  readonly resolve: (answer: QuestionAnswer) => void
  readonly reject: (error: Error) => void
}

/**
 * In-process registry of pending question asks, shared by the question bridge
 * (registers an ask while waiting) and the `answer_question` tool (resolves
 * one). Keyed by task id: a worker runs one task at a time, so one task
 * carries at most one pending question batch. Not durable by design — a
 * restart fails the in-flight ask closed and the task resumes `working`; the
 * worker re-asks if it still needs the answer.
 */
export class QuestionRegistry {
  private readonly pending = new Map<string, PendingAsk>()

  /** Register one pending ask; an earlier ask for the same task is rejected. */
  register(ask: PendingAsk): void {
    const key = String(ask.taskId)
    const previous = this.pending.get(key)
    if (previous !== undefined) {
      previous.reject(new Error(`task ${key} asked again before the previous question was answered`))
    }
    this.pending.set(key, ask)
  }

  /** The pending ask for one task, or `undefined` when none is pending. */
  get(taskId: TaskId): PendingAsk | undefined {
    return this.pending.get(String(taskId))
  }

  /**
   * Resolve the pending ask with the initiator's answer.
   * @returns whether an ask was pending (the worker's wrapper settles with it).
   */
  resolve(taskId: TaskId, answer: QuestionAnswer): boolean {
    const ask = this.pending.get(String(taskId))
    if (ask === undefined) return false
    this.pending.delete(String(taskId))
    ask.resolve(answer)
    return true
  }

  /**
   * Reject the pending ask (timeout, cancellation, task death).
   * @returns whether an ask was pending.
   */
  reject(taskId: TaskId, error: Error): boolean {
    const ask = this.pending.get(String(taskId))
    if (ask === undefined) return false
    this.pending.delete(String(taskId))
    ask.reject(error)
    return true
  }

  /** Reject every pending ask; plugin teardown and test isolation. */
  clear(reason = 'question registry cleared'): void {
    for (const ask of [...this.pending.values()]) ask.reject(new Error(reason))
    this.pending.clear()
  }

  /** Number of still-pending asks. */
  get size(): number {
    return this.pending.size
  }
}

/** The fail-closed settlement when the initiator did not answer in time. */
export class QuestionTimeoutError extends Error {
  override readonly name = 'QuestionTimeoutError'

  constructor(taskId: TaskId) {
    super(`task ${taskId}: question awaiting the initiator's answer timed out; the task has resumed working`)
  }
}

/** Configuration the question bridge reads. */
export interface QuestionBridgeConfig {
  /** How long the wrapper waits for the initiator's answer before failing closed (ms). */
  readonly questionTimeoutMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the official `ask_user_question` arguments (`{ questions: [...] }`)
 * into the plugin's structured shape. Returns `null` when the argument is
 * malformed — the bridge treats that as "not our question" and delegates.
 * @param argument - `exec.arguments` of the intercepted call.
 * @returns the parsed questions, or `null` when unparseable.
 */
export function parseQuestions(argument: unknown): PendingQuestion[] | null {
  if (!isRecord(argument)) return null
  const raw = argument['questions']
  if (!Array.isArray(raw) || raw.length === 0) return null
  const parsed: PendingQuestion[] = []
  for (const item of raw) {
    if (!isRecord(item)) return null
    if (typeof item['id'] !== 'string' || item['id'] === '') return null
    if (typeof item['question'] !== 'string' || item['question'] === '') return null
    const header = item['header']
    if (header !== undefined && typeof header !== 'string') return null
    const options: PendingQuestionOption[] = []
    const optionsRaw = item['options']
    if (optionsRaw !== undefined) {
      if (!Array.isArray(optionsRaw)) return null
      for (const option of optionsRaw) {
        if (!isRecord(option) || typeof option['label'] !== 'string' || option['label'] === '') return null
        const description = option['description']
        if (description !== undefined && typeof description !== 'string') return null
        options.push({ label: option['label'], ...(description !== undefined ? { description } : {}) })
      }
    }
    const multi = item['multi_select']
    if (multi !== undefined && typeof multi !== 'boolean') return null
    parsed.push({
      id: item['id'],
      question: item['question'],
      ...(header !== undefined ? { header } : {}),
      options,
      multiSelect: multi === true,
    })
  }
  return parsed
}

/**
 * Validate one answer batch against the task's pending questions, returning
 * the normalized answer items in the official `AskUserQuestionAnswerItem`
 * shape. Every violation names the question id it blames.
 * @param rawAnswers - the raw `answers` tool argument.
 * @param questions - the pending questions the batch must answer.
 * @returns the normalized answer items.
 * @throws with a naming message when the batch is malformed or mismatched.
 */
export function normalizeQuestionAnswers(rawAnswers: unknown, questions: readonly PendingQuestion[]): QuestionAnswerItem[] {
  if (!Array.isArray(rawAnswers)) throw new Error('answers must be an array')
  if (rawAnswers.length === 0) throw new Error('answers must not be empty')
  const byId = new Map(questions.map(question => [question.id, question]))
  const normalized: QuestionAnswerItem[] = []
  for (const raw of rawAnswers) {
    if (!isRecord(raw)) throw new Error('each answer must be an object')
    const id = raw['id']
    if (typeof id !== 'string' || id === '') throw new Error('each answer requires a question id')
    const question = byId.get(id)
    if (question === undefined) throw new Error(`answer "${id}" does not match any pending question`)
    const selectedRaw = raw['selected']
    if (!Array.isArray(selectedRaw)) throw new Error(`answer "${id}" requires a selected array`)
    const selected: string[] = []
    for (const label of selectedRaw) {
      if (typeof label !== 'string') throw new Error(`answer "${id}" selected items must be strings`)
      if (question.options.length > 0 && !question.options.some(option => option.label === label)) {
        throw new Error(`answer "${id}" selected "${label}" which is not an offered option`)
      }
      selected.push(label)
    }
    if (!question.multiSelect && selected.length > 1) {
      throw new Error(`answer "${id}" selects ${selected.length} options but the question allows one`)
    }
    const custom = raw['custom']
    if (custom !== undefined && typeof custom !== 'string') throw new Error(`answer "${id}" custom must be a string`)
    normalized.push({ id, selected, ...(custom !== undefined ? { custom } : {}) })
  }
  return normalized
}

/** The initiator-facing notice for one forwarded question batch. */
function buildPmNotice(taskId: TaskId, worker: string, questions: readonly PendingQuestion[]): string {
  const lines = [
    `任务 ${taskId} 的执行方(${worker.slice(0, 8)})在任务中调用了 ask_user_question,请用 answer_question 工具回答:`,
    `answer_question(task_id=${JSON.stringify(String(taskId))}, answers=[{id, selected, custom?}, ...])`,
  ]
  for (const question of questions) {
    const heading = question.header !== undefined ? `${question.header}: ${question.question}` : question.question
    lines.push(`- [${question.id}] ${heading}${question.multiSelect ? '(可多选)' : ''}`)
    for (const option of question.options) {
      lines.push(`    - ${option.label}${option.description !== undefined ? ` — ${option.description}` : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * Register the `tools/execute` around-wrapper implementing decision 9.
 *
 * Registered on the host context (agent-bus is a host plugin), so it observes
 * every agent's tool calls; a scope-filtered registration would restrict it
 * to one agent. The listener returns the outcome itself when it claims an
 * A2A ask and delegates to `next()` otherwise — the two directions the
 * product decision pins.
 *
 * @param ctx - plugin context (host scope).
 * @param ledger - the task ledger.
 * @param questions - the shared pending-question registry.
 * @param config - timeout tuning.
 */
export function registerQuestionBridge(
  ctx: Context,
  ledger: TaskLedger,
  questions: QuestionRegistry,
  config: QuestionBridgeConfig,
): void {
  // Reject a pending ask when its task dies another way (cancel, the 2h
  // timeout sweep, a failure verdict): the worker's wrapper settles with a
  // clear error instead of hanging past the task's life.
  ctx.on('agent-bus/task-changed', (change: { taskId: string; to: string }) => {
    if (change.to !== 'failed' && change.to !== 'canceled') return
    questions.reject(TaskId(change.taskId), new Error(`task ${change.taskId} is no longer pending (${change.to})`))
  })

  ctx.on('tools/execute', async (exec, next) => {
    // Not the tool we forward — delegate unconditionally.
    if (exec.name !== 'ask_user_question') return next()
    // Agent-less calls have no session to judge and no task to attribute.
    if (exec.agent === undefined) return next()
    // user↔A vs A2A, judged from the injected context (decision: replace
    // findWorkingFor): the caller is A2A only when the CURRENT open turn's
    // first user/message is an agent-bus-task relay that owns a ledger row
    // assigned to the caller. Every other shape — no open turn, a non-task
    // source (a direct human prompt, an inject() context), a notification
    // message carrying the same source kind but no ledger row, or a task
    // assigned to someone else — delegates to next() (the original chain
    // would not forward anyway). `findWorkingFor` is retained on the ledger
    // for its documented semantics but no longer drives the bridge.
    const caller = exec.agent
    const msg = currentTurnTaskMessage(caller.session)
    if (msg === undefined) return next()
    if (msg.source.kind !== 'agent-bus-task') return next()
    const task = ledger.findByMessage(msg.id)
    if (task === undefined) return next()
    if (task.assignedTo !== caller.id) return next()
    const parsed = parseQuestions(exec.arguments)
    // Malformed arguments are not ours to interpret; the original tool owns
    // the schema error surface.
    if (parsed === null) return next()

    // A2A: claim the call. Persist the questions, pause the task, tell the
    // initiator, and wait.
    const taskId = task.id
    // An already-aborted signal never fires its abort listener, so check it
    // before claiming: no state change, no notification, fail closed at once.
    if (exec.signal.aborted) {
      return {
        isError: true,
        error: { message: 'the worker cancelled the ask_user_question call' },
        content: [{ type: 'text', text: 'the worker cancelled the ask_user_question call' }],
      }
    }
    const summary = parsed
      .map(question => question.header !== undefined ? `${question.header}: ${question.question}` : question.question)
      .join('\n')
    const paused = await ledger.transition(taskId, 'input-required', {
      pendingQuestions: parsed,
      question: summary,
    })
    // The task left `working` underneath us (cancel, timeout, rework) — do
    // not claim a question on a task we no longer own.
    if (!paused.ok) return next()
    notifySession(ctx, task.assignedBy, taskId, buildPmNotice(taskId, caller.id, parsed), 'question')

    try {
      const answer = await new Promise<QuestionAnswer>((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          exec.signal.removeEventListener('abort', onAbort)
          fn()
        }
        const timer = setTimeout(() => {
          // Remove the registry entry first (its reject settles the promise
          // through the ask), then settle again as the guard in case the
          // entry was already gone — exactly one path wins.
          questions.reject(taskId, new QuestionTimeoutError(taskId))
          settle(() => reject(new QuestionTimeoutError(taskId)))
        }, config.questionTimeoutMs)
        timer.unref?.()
        const onAbort = (): void => {
          questions.reject(taskId, new Error('the worker cancelled the ask_user_question call'))
          settle(() => reject(new Error('the worker cancelled the ask_user_question call')))
        }
        exec.signal.addEventListener('abort', onAbort, { once: true })
        questions.register({
          taskId,
          worker: caller.id,
          pm: task.assignedBy,
          resolve: answer => settle(() => resolve(answer)),
          reject: error => settle(() => reject(error)),
        })
      })
      return {
        isError: false,
        value: {
          answers: answer.answers.map(item => ({
            id: item.id,
            selected: [...item.selected],
            ...(item.custom !== undefined ? { custom: item.custom } : {}),
          })),
        },
        content: [{ type: 'text', text: JSON.stringify(answer) }],
      }
    } catch (error) {
      // Fail closed: resume the task and tell the worker why. The transition
      // is best-effort — a task already moved on (canceled, failed, resumed
      // by another path) simply refuses the move.
      await ledger.transition(taskId, 'working', { pendingQuestions: undefined, question: undefined })
      const message = error instanceof Error ? error.message : String(error)
      return { isError: true, error: { message }, content: [{ type: 'text', text: message }] }
    }
  })
}
