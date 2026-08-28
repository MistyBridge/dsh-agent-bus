/**
 * Decision 6: PM-delegated approval for authorization-requiring operations.
 *
 * When a sub-agent executes an operation that needs permission elevation
 * (a sandbox escalation, a privileged tool call), the harness routes the
 * request through the `approval/request` waterfall. The default answerer
 * chain asks the global human approver. This bridge claims the request and
 * forwards it to the task's initiator (the PM) instead — the durable
 * `assignedBy` relationship, never a stored role.
 *
 * The claim rules follow the approved decision:
 * - An agent executing a `working` ledger task → the request goes to that
 *   task's `assignedBy` (the PM). The task row keeps working; the approval
 *   is a side channel that does not pause the state machine.
 * - An agent with no matching task (session-level operation) → the request
 *   goes to the configured `fullAccessSessions` fallback, when present.
 * - No PM resolvable at all → the bridge defers with `next()`, so the
 *   harness's own chain (human approver) answers as if the bridge were not
 *   installed. The bridge never swallows a request it cannot route.
 *
 * The PM answers through the `respond_approval` tool. A rejection MUST carry
 * a reason and a suggested remedy; the harness `ApprovalOutcome` has no
 * reason field, so the reason+suggestion ride a separate agent-bus notice to
 * the worker. A PM that never answers fails closed after
 * `approvalTimeoutMs` (`'unavailable'`), so no approval promise dangles
 * forever.
 *
 * @module dsh-agent-bus/approval-bridge
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { checkedTool } from './checked-tool.ts'
import { notifySession } from './delivery.ts'
import type { TaskLedger } from './ledger/ledger.ts'
import type { TaskId } from './domain/types.ts'
import type { ApprovalOutcome, ApprovalRequestLike } from './domain/types.ts'

/** Tunables the approval bridge reads. */
export interface ApprovalBridgeConfig {
  /** How long a PM may take to answer before the bridge fails closed (default `600000`, 10 min). */
  readonly approvalTimeoutMs: number
  /** Fallback approvers for session-level operations with no task (decision 6 §5). */
  readonly fullAccessSessions: readonly SessionId[]
}

/** One pending approval awaiting the PM's verdict. */
interface PendingApproval {
  readonly id: string
  readonly requester: SessionId
  readonly taskId?: TaskId
  readonly toolName: string
  readonly reason?: string
  readonly approver: SessionId
  readonly createdAt: number
  readonly settle: (outcome: ApprovalOutcome) => void
  readonly timer: NodeJS.Timeout
}

/** What `respond_approval` accepted and applied. */
export interface ApprovalAnswer {
  readonly approvalId: string
  readonly outcome: ApprovalOutcome
}

/**
 * Resolve the PM for one approval request: the `assignedBy` of the
 * requester's latest `working` task, else the first configured full-access
 * session, else `undefined` (defer to the harness chain).
 *
 * @param ledger - the task ledger.
 * @param requester - the agent that needs approval.
 * @param fullAccess - configured fallback approvers.
 * @returns the approver session id, or `undefined` when none is reachable.
 */
export function resolveApprover(
  ledger: TaskLedger,
  requester: SessionId,
  fullAccess: readonly SessionId[],
): SessionId | undefined {
  const task = ledger.findWorkingFor(requester)
  if (task !== undefined) return task.assignedBy
  if (fullAccess.length > 0) return fullAccess[0]
  return undefined
}

/**
 * Install the PM-delegated approval bridge.
 *
 * Registers the `approval/request` waterfall listener (host level, prepended
 * so it claims before the harness's web answerer) and the `respond_approval`
 * tool the PM uses to answer. Returns a disposer that settles every still
 * pending approval as `'cancelled'`.
 *
 * @param ctx - the plugin context (host scope).
 * @param ledger - the task ledger.
 * @param config - bridge tunables.
 * @returns a disposer removing the listener, tool, and pending approvals.
 */
export function installApprovalBridge(
  ctx: Context,
  ledger: TaskLedger,
  config: ApprovalBridgeConfig,
): () => void {
  const pending = new Map<string, PendingApproval>()

  const settle = (id: string, outcome: ApprovalOutcome): void => {
    const entry = pending.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.settle(outcome)
  }

  const failClosed = (id: string, approver: SessionId, taskId: TaskId | undefined): void => {
    const entry = pending.get(id)
    if (entry === undefined) return
    // A timed-out approval fails closed: the worker gets a clear error, and
    // the notice tells it the PM did not answer and it may ask the PM or
    // adjust its plan — never a silent hang (decision 6 §6).
    notifySession(
      ctx,
      entry.requester,
      taskId ?? entry.taskId ?? id as TaskId,
      `审批请求 ${id.slice(0, 8)}…(操作:${entry.toolName})已超时未获 ${approver.slice(0, 8)} 回应,按 fail-closed 处理为「不可用」。`
        + `如需继续,请直接联系任务发起方或调整方案后重试。`,
      'reminder',
    )
    settle(id, 'unavailable')
  }

  // The `approval/request` event type lives in the official user-approval
  // package, which an out-of-repo plugin must not depend on (type or
  // runtime). The event name and listener signature are therefore asserted
  // against the local minimal shape; the runtime contract is the Cordis
  // waterfall (return an outcome to claim, call `next()` to delegate).
  const disposer = ctx.on('approval/request' as never, (async (
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')
    const requester = req.agent?.id
    if (requester === undefined) return next()
    const task = ledger.findWorkingFor(requester)
    const approver = task !== undefined
      ? task.assignedBy
      : config.fullAccessSessions[0]
    if (approver === undefined) return next() // no PM: harness chain answers

    const id = randomUUID()
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingApproval = {
        id,
        requester,
        ...(task !== undefined ? { taskId: task.id } : {}),
        toolName: req.toolName,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
        approver,
        createdAt: Date.now(),
        settle: resolve,
        timer: setTimeout(() => failClosed(id, approver, task?.id), config.approvalTimeoutMs),
      }
      entry.timer.unref?.()
      pending.set(id, entry)
      // Auto-reminder with full context (decision 6 §3): who, what, why,
      // task context, and how to answer.
      const taskContext = task !== undefined
        ? `任务 ${task.id}「${task.title ?? '无标题'}」(${task.status})`
        : '会话级操作(无任务上下文)'
      const why = req.reason !== undefined ? `\n原因:${req.reason}` : ''
      notifySession(
        ctx,
        approver,
        task?.id ?? id as TaskId,
        `【审批请求】${requester.slice(0, 8)} 需要你(任务发起方)代为审批。`
          + `\n操作:${req.toolName}`
          + `${why}`
          + `\n上下文:${taskContext}`
          + `\n请调用 respond_approval 工具回答:approval_id = ${id},decision = allow|reject`
          + `(拒绝必须附 reason 理由与 suggestion 解决方案建议)。`,
        'reminder',
      )
    })
  }) as never, { prepend: true })

  // respond_approval: the PM's answer surface. Only the recorded approver
  // may answer; a rejection must carry reason + suggestion, which ride a
  // separate notice to the worker because ApprovalOutcome has no reason.
  ctx.tools.register(checkedTool({
    name: 'respond_approval',
    description:
      'Answer one PM-delegated approval request (decision 6). Only the task initiator '
      + '(the recorded approver) may answer; anyone else is refused. A rejection MUST '
      + 'carry reason (why) and suggestion (a concrete remedy — a lower-privilege '
      + 'alternative, a task-scope change, or a permission adjustment); on reject they '
      + 'are returned together with the outcome (reason/suggestion fields), so the '
      + 'worker reads them synchronously. Approval ids come from the approval notice '
      + 'the bridge sent you.',
    parameters: {
      approval_id: { type: 'string', required: true, description: 'The approval id from the notice.' },
      decision: { type: 'string', required: true, enum: ['allow', 'reject'], description: 'Allow the operation, or reject it.' },
      reason: { type: 'string', description: 'Required when decision=reject: why it is refused.' },
      suggestion: { type: 'string', description: 'Required when decision=reject: a concrete remedy for the worker.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approvalId: { type: 'string', required: true },
          outcome: { type: 'string', required: true, enum: ['allowed-once', 'rejected'] },
          reason: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `approval ${String(result.approvalId).slice(0, 8)}… → ${result.outcome}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:审批应答', kind: 'other', rawInput: { approval_id: args.approval_id, decision: args.decision } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:审批应答', rawInput: result }),
    async execute(args, exec) {
      const callerId = exec.agent?.id
      if (callerId === undefined) throw new Error('respond_approval requires a calling agent')
      const entry = pending.get(args.approval_id)
      if (entry === undefined) {
        throw new Error(`no pending approval "${args.approval_id}"`)
      }
      if (entry.approver !== callerId) {
        throw new Error('仅任务发起方可回答该审批请求')
      }
      if (args.decision === 'reject') {
        if (typeof args.reason !== 'string' || args.reason.trim() === '') {
          throw new Error('reject requires reason: state why the operation is refused')
        }
        if (typeof args.suggestion !== 'string' || args.suggestion.trim() === '') {
          throw new Error('reject requires suggestion: propose a concrete remedy (lower-privilege alternative, task-scope change, or permission adjustment)')
        }
        // The return value carries reason + suggestion synchronously (the
        // request's own channel, so the worker reads them together with the
        // outcome). The notice below stays as a redundant parallel delivery
        // guaranteeing the worker also sees them if the return is read first.
        notifySession(
          ctx,
          entry.requester,
          entry.taskId ?? entry.id as TaskId,
          `你的审批请求 ${entry.id.slice(0, 8)}…(操作:${entry.toolName})被任务发起方拒绝。`
            + `\n理由:${args.reason}`
            + `\n建议方案:${args.suggestion}`,
          'reminder',
        )
        settle(entry.id, 'rejected')
        return { approvalId: entry.id, outcome: 'rejected' as const, reason: args.reason, suggestion: args.suggestion }
      }
      settle(entry.id, 'allowed-once')
      return { approvalId: entry.id, outcome: 'allowed-once' as const }
    },
  }))

  return () => {
    for (const entry of [...pending.values()]) settle(entry.id, 'cancelled')
    disposer()
  }
}
