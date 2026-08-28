/**
 * The pending-question registry shared by the question bridge (registers an
 * ask while waiting) and the `answer_question` tool (resolves one).
 *
 * Extracted from `question-bridge.ts` so the bridge (host-side around-wrapper)
 * and the tool surface can each `import` the registry value without pulling in
 * the bridge's `tools/execute` wiring. Not durable by design — a restart fails
 * the in-flight ask closed and the task resumes `working`.
 *
 * @module dsh-agent-bus/bridges/question-registry
 */

import type { TaskId, QuestionAnswer } from '../domain/types.ts'

/** One registered, still-pending question ask, awaiting the initiator's
 * answer. The promise pair belongs to the bridge's waiting wrapper. */
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
 * carries at most one pending question batch.
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
