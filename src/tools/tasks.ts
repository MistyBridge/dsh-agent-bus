/** Tasks tools (registered under the output-schema gate). */

import { checkedTool } from './checked-tool.ts'
import { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID, view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds, assertFlowName, randomTaskId, isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry, ToolsConfig, ToolsDeps, TaskView, TaskDetailView } from './common.ts'

export function registerTasksTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

ctx.tools.register(checkedTool({
    name: 'reassign_task',
    description:
      'As the initiator, reassign an unsettled task without recreating it: move the executor '
      + '(new_executor) and/or the reviewer (new_reviewer). The task id, history, dependencies, '
      + 'flow membership, and acceptance criteria all stay — only who works and who reviews '
      + 'changes. A new executor receives the task re-delivered (a working old executor\'s report '
      + 'is rejected automatically); a queued task simply gets the new owner and still waits for '
      + 'its dependencies. Use this when a worker dropped out or responsibilities shift — cancel '
      + 'and recreate is the fallback only for settled tasks.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The unsettled task to reassign.' },
      new_executor: {
        type: 'string',
        description: 'Session id or peer title of the new executor, from list_peers; omit to keep the current one.',
      },
      new_reviewer: {
        type: 'string',
        description: 'Session id or peer title of the new reviewer, from list_peers; omit to keep the current one.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          executor: { type: 'string' },
          reviewer: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} reassigned → ${String(result.status)}`
          + (result.executor !== undefined ? `, executor: ${result.executor.slice(0, 8)}` : '')
          + (result.reviewer !== undefined ? `, reviewer: ${result.reviewer.slice(0, 8)}` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:转派任务', kind: 'other', rawInput: { task_id: args.task_id, ...(args.new_executor !== undefined ? { new_executor: args.new_executor } : {}), ...(args.new_reviewer !== undefined ? { new_reviewer: args.new_reviewer } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:转派任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'reassign_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedBy !== callerId) {
        throw new Error(`only the session that created task "${taskId}" may reassign it`)
      }
      if (args.new_executor === undefined && args.new_reviewer === undefined) {
        throw new Error('reassign_task needs new_executor and/or new_reviewer')
      }
      let newExecutor: SessionId | undefined
      if (args.new_executor !== undefined) {
        const executorId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.new_executor))
        const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, executorId)
        if (!decision.ok) throw new Error(decision.message)
        newExecutor = executorId
        // Self-execution keeps an independent reviewer, same rule as create_task.
        const effectiveReviewer = args.new_reviewer !== undefined
          ? await resolvePeerTarget(ctx, workspaces, callerId, String(args.new_reviewer))
          : task.assignedReviewer
        if (newExecutor === callerId
          && (effectiveReviewer === undefined || effectiveReviewer === callerId)) {
          throw new Error(
            'self-execution requires reviewer: when the executor is yourself, name a different session as reviewer',
          )
        }
      }
      let newReviewer: SessionId | undefined
      if (args.new_reviewer !== undefined) {
        const reviewerId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.new_reviewer))
        const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, reviewerId)
        if (!decision.ok) throw new Error(decision.message)
        newReviewer = reviewerId
      }
      const oldExecutor = task.assignedTo
      const wasWorking = task.status === 'working' || task.status === 'input-required'
      const wasQueued = task.status === 'queued'
      // Work-state detection: with the one-task-per-turn delivery model, a
      // working task IS the task the executor is currently on. Reassigning
      // while it runs must interrupt that turn so the old worker cannot
      // keep grinding on work that was taken from it.
      const executorOnThisTask = task.status === 'working' && oldExecutor !== undefined
        && ctx.agents.get(oldExecutor) !== undefined
      const reassigned = await ledger.reassign(taskId, {
        ...(newExecutor !== undefined ? { executor: newExecutor } : {}),
        ...(newReviewer !== undefined ? { reviewer: newReviewer } : {}),
      })
      if (!reassigned.ok) throw new Error(reassigned.message)

      // Re-deliver to the new executor: the old delivery was voided by the
      // reassign. A queued task is not delivered — the scheduler owns it. A
      // dormant new executor is woken; an unwakeable one falls back to queued
      // and the sweep retries.
      if (newExecutor !== undefined && !wasQueued) {
        const message = buildTaskMessage(callerId, taskId,
          `${reassigned.task.content}\n\n[任务已由 ${oldExecutor ?? '原执行方'} 转派给你执行,请按原要求完成并调用 report_task。]`,
          'reassign_task')
        const worker = await wakeSession(ctx, newExecutor)
        if (worker !== undefined) {
          await ledger.recordDelivery(taskId, message.id)
          deliverTask(worker, message, 'steer')
        } else {
          await ledger.transition(taskId, 'queued')
        }
      }
      // The old executor's in-flight turn is interrupted and told the task
      // moved (if it was mid-flight) — the reclaimed work is voided so it
      // cannot keep executing a task that no longer belongs to it.
      if (oldExecutor !== undefined && newExecutor !== undefined && oldExecutor !== newExecutor && executorOnThisTask) {
        const oldWorker = ctx.agents.get(oldExecutor)
        if (oldWorker !== undefined) {
          try {
            oldWorker.cancel({ kind: 'user' }, { keepInbox: true })
          } catch {
            // The interrupt is advisory; a worker that already settled its
            // turn needs no interruption.
          }
        }
        notifySession(ctx, oldExecutor, taskId,
          `任务 ${taskId} 已转派给 ${newExecutor.slice(0, 8)},你不再负责该任务,当前工作已作废。`,
          'reassign_task')
      }
      return {
        taskId: String(taskId),
        status: reassigned.task.status,
        ...(reassigned.task.assignedTo !== undefined ? { executor: String(reassigned.task.assignedTo) } : {}),
        ...(reassigned.task.assignedReviewer !== undefined ? { reviewer: String(reassigned.task.assignedReviewer) } : {}),
      }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'submit_handoff',
    description:
      'As the executor of a settled task, deliver the handoff document to ONE task that depends on '
      + 'it (a task listing this one in its dependencies). The document is attached to the '
      + 'downstream task and is concatenated into its delivered content when it dispatches — this '
      + 'is how a chain passes structured context (computed values, decisions, caveats) instead of '
      + 'free-text archaeology. Call it once per downstream task.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task you executed and completed (its id).' },
      to_task_id: { type: 'string', required: true, description: 'The downstream task that depends on task_id.' },
      document: { type: 'string', required: true, description: 'The handoff content the downstream task needs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          handoffCount: { type: 'number', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `handoff attached to ${result.taskId} (${String(result.handoffCount)} total)`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:提交交接文档', kind: 'other', rawInput: { task_id: args.task_id, to_task_id: args.to_task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:提交交接文档', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'submit_handoff')
      const taskId = TaskId(args.task_id)
      const toTaskId = TaskId(args.to_task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const downstream = ledger.get(toTaskId)
      if (downstream === undefined) throw new Error(`no such task "${toTaskId}"`)
      if (!(downstream.dependencies ?? []).includes(taskId)) {
        throw new Error(`task "${toTaskId}" does not depend on "${taskId}"; handoffs go to downstream tasks only`)
      }
      const admitted = admitContent(args.document, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const attached = await ledger.appendHandoff(toTaskId, {
        fromTask: taskId,
        document: admitted.content,
        at: new Date().toISOString(),
      })
      if (!attached.ok) throw new Error(attached.message)
      return {
        taskId: String(toTaskId),
        handoffCount: (attached.task.handoffs ?? []).length,
      }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'create_task',
    description:
      'MEDIUM scope: create one task node for a live peer in your workspace — a single deliverable '
      + 'the peer must produce and you will review. The task is recorded in the ledger; a task whose '
      + 'dependencies are already settled is delivered to the peer\'s queue in one step, and a task '
      + 'with unsettled dependencies is created as 待投递(queued) and delivered automatically by the '
      + 'scheduler once every dependency settles — no pacing needed. The peer works delivered tasks '
      + 'one at a time, each as its own turn. You become the task\'s initiator. By default you also '
      + 'review its result; pass reviewer to name a different session as the one that settles it. '
      + 'acceptance_criteria is the minimum requirement the reviewer settles against. A rejected '
      + 'result sends the SAME task back to the worker for rework — the task id never changes across '
      + 'attempts. To answer a peer\'s request_input, pass task_id — your message becomes the answer '
      + 'and the task resumes. Delivery defaults to steer, which puts the task ahead of any queued '
      + 'notes (priority channel); pass mode=followup to queue FIFO behind everything already pending. '
      + 'For a multi-step effort, use create_flow instead and build the DAG.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id or peer title of the executor, from list_peers.' },
      content: { type: 'string', required: true, description: 'The task instruction or answer.' },
      title: { type: 'string', required: true, description: 'Short display title (1–20 chars); lists and DAG nodes display it.' },
      mode: {
        type: 'string',
        enum: ['followup', 'steer'],
        description: 'steer (default) delivers with priority ahead of queued notes; followup queues FIFO behind them.',
      },
      reviewer: {
        type: 'string',
        description: 'Session id of the reviewer who settles this task; defaults to you.',
      },
      task_id: {
        type: 'string',
        description: 'Answering a request_input: the input-required task id. The message answers its question.',
      },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'DAG predecessors: task ids that must settle before this one is delivered. '
          + 'While any predecessor is unsettled the task stays 待投递(queued) — the scheduler delivers '
          + 'it automatically once every dependency settles. Edit with edit_task before it dispatches.',
      },
      acceptance_criteria: {
        type: 'string',
        description: 'The minimum acceptance requirement the reviewer settles against; the worker can '
          + 'read it to know what "done" means.',
      },
      flow_id: {
        type: 'string',
        description: 'Flow to join (from create_flow). When set, every dependency must belong to the '
          + 'same flow — add a target task to the flow first if it is not there.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          queuePosition: { type: 'number', required: true },
          blockedBy: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} → ${String(result.status)}, `
          + `${String(result.queuePosition)} unfinished task(s) in that queue`
          + (result.blockedBy.length > 0
            ? `, awaiting dependencies: ${result.blockedBy.join(', ')}`
            : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建任务', kind: 'other', rawInput: { target: args.target, ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}), ...(args.task_id !== undefined ? { task_id: args.task_id } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_task')
      if (!limiter.admit(callerId, Date.now())) {
        throw new Error(
          `dispatch rate exceeded: at most ${config.maxSendsPerMinute} sends per minute`,
        )
      }
      const targetId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.target))
      const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)

      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const criteria = args.acceptance_criteria !== undefined
        ? admitContent(args.acceptance_criteria, 2000)
        : undefined
      if (criteria !== undefined && !criteria.ok) throw new Error(criteria.message)
      const title = admitContent(String(args.title ?? ''), 80)
      if (!title.ok) throw new Error(title.message)

      // Priority delivery: the default 'steer' channel (next-step) is claimed
      // before any queued next-turn messages at every boundary, so a
      // dispatched task never waits behind a pile of send_note turns. An
      // explicit 'followup' opts into FIFO queueing behind everything already
      // pending.
      const mode: DeliveryMode = args.mode === 'followup' ? 'followup' : 'steer'

      // Answer path: the initiator replies to a worker's request_input. The
      // answer is a new delivery; the task transitions back to working HERE
      // rather than waiting for an inbox-claimed event — a steer-spliced
      // answer may enter the worker's current turn without a claim boundary,
      // which would otherwise leave the row stuck in input-required forever.
      if (args.task_id !== undefined) {
        const taskId = TaskId(args.task_id)
        const task = ledger.get(taskId)
        if (task === undefined) throw new Error(`no such task "${taskId}"`)
        if (task.status !== 'input-required') {
          throw new Error(`task "${taskId}" is ${task.status}, not awaiting input`)
        }
        if (task.assignedBy !== callerId) {
          throw new Error(`only the dispatching session may answer task "${taskId}"`)
        }
        const message = buildTaskMessage(callerId, taskId, admitted.content)
        const resumed = await ledger.transition(taskId, 'working')
        if (!resumed.ok) throw new Error(resumed.message)
        await ledger.recordDelivery(taskId, message.id)
        deliverTask(decision.target, message, mode)
        const pending = ledger.listFor(targetId).filter(
          row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
        )
        return { taskId: String(taskId), status: resumed.task.status, queuePosition: pending.length, blockedBy: [] as string[] }
      }

      // Create path: a fresh task node. Reviewer defaults to the initiator.
      const taskId = TaskId(randomTaskId())
      let reviewer: SessionId | undefined
      if (args.reviewer !== undefined) {
        const reviewerId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.reviewer))
        const reviewerDecision = await authorizePeerOrDormant(ctx, workspaces, callerId, reviewerId)
        if (!reviewerDecision.ok) throw new Error(reviewerDecision.message)
        reviewer = reviewerId
      }
      // Self-execution keeps accountability: when the caller is also the
      // executor, the reviewer MUST be a different session — nobody approves
      // their own work.
      if (targetId === callerId) {
        if (reviewer === undefined || reviewer === callerId) {
          throw new Error(
            'self-execution requires reviewer: when target is yourself, name a different session as reviewer',
          )
        }
      }
      const dependencies = (args.dependencies as string[] | undefined)?.map(id => TaskId(id))
      // Flow membership: the flow must exist in the caller's workspace. The
      // same-flow dependency rule is enforced by the ledger at write time.
      let flowId: string | undefined
      if (args.flow_id !== undefined) {
        const flow = ledger.getFlow(args.flow_id)
        if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
        if (flow.workspacePath !== decision.workspacePath) {
          throw new Error(`flow "${args.flow_id}" belongs to another workspace`)
        }
        flowId = flow.id
      }
      const message = buildTaskMessage(callerId, taskId, admitted.content)
      const tokensAtStart = snapshotTokensAtDispatch(ctx, callerId, targetId, reviewer)
      const recorded = await ledger.record({
        id: taskId,
        assignedBy: callerId,
        assignedTo: targetId,
        ...(reviewer !== undefined ? { assignedReviewer: reviewer } : {}),
        workspacePath: decision.workspacePath,
        content: admitted.content,
        mode,
        retries: 0,
        ...(tokensAtStart !== undefined ? { tokensAtStart } : {}),
        ...(dependencies !== undefined ? { dependencies } : {}),
        ...(criteria?.ok === true ? { acceptanceCriteria: criteria.content } : {}),
        ...(flowId !== undefined ? { flowId } : {}),
        title: title.content,
      }, config.maxPendingPerAgent)
      if (!recorded.ok) throw new Error(recorded.message)

      // A task with dependencies is created queued(待投递) without delivery
      // until every predecessor settles; the scheduler delivers it then. A
      // task whose dependencies are already settled delivers immediately,
      // recording the message id before the inbox can claim it. A dormant
      // target is WOKEN (v1.5): the harness resumes the persisted session,
      // so the dispatch never fails on a closed tab; if the session cannot
      // be woken the task falls back to queued and the sweep retries.
      const blocked: string[] = dependencies === undefined
        ? []
        : [...blockedByOf(recorded.task, ledger.listAll()).map(String)]
      if (blocked.length === 0) {
        const target = await wakeSession(ctx, targetId)
        if (target !== undefined) {
          await ledger.recordDelivery(taskId, message.id)
          deliverTask(target, message, mode)
        } else {
          await ledger.transition(taskId, 'queued')
        }
      }
      const pending = ledger.listFor(targetId).filter(
        row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
      )
      return { taskId: String(taskId), status: recorded.task.status, queuePosition: pending.length, blockedBy: blocked }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'edit_task',
    description:
      'Edit a task you created that has not been dispatched yet: rewrite its requirement text, its '
      + 'DAG predecessors (dependencies), and/or its acceptance criteria. The DAG is program-driven — '
      + 'if you find your flow unreasonable, fix it here before the task dispatches. A dispatched or '
      + 'running task cannot be edited; cancel and recreate instead. After the edit, the task '
      + 'dispatches automatically if every dependency has settled.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The undispatched task to edit.' },
      content: { type: 'string', description: 'New requirement text; omit to keep the current one.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'New predecessor list; omit to keep the current one, pass [] to clear all dependencies.',
      },
      acceptance_criteria: {
        type: 'string',
        description: 'New minimum acceptance requirement; omit to keep the current one.',
      },
      title: {
        type: 'string',
        description: 'New display title (1–20 chars); omit to keep the current one.',
      },
      flow_id: {
        type: 'string',
        description: 'Move the task to another flow; the new flow must contain every dependency of '
          + 'the task (dependencies move with it, so add them to the new flow first if needed).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          blockedBy: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} updated → ${String(result.status)}`
          + (result.blockedBy.length > 0
            ? `, awaiting dependencies: ${result.blockedBy.join(', ')}`
            : ', dependencies satisfied'),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'agent-bus:编辑任务',
      kind: 'other',
      rawInput: { task_id: args.task_id, ...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}) },
    }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:编辑任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'edit_task')
      const taskId = TaskId(args.task_id)
      const existing = ledger.get(taskId)
      if (existing === undefined) throw new Error(`no such task "${taskId}"`)
      if (existing.assignedBy !== callerId) {
        throw new Error(`only the session that created task "${taskId}" may edit it`)
      }
      const patch: {
        content?: string
        title?: string
        dependencies?: TaskId[]
        acceptanceCriteria?: string
        flowId?: string
      } = {}
      if (args.content !== undefined) {
        const admitted = admitContent(args.content, config.maxContentLength)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.content = admitted.content
      }
      if (args.title !== undefined) {
        const admitted = admitContent(args.title, 80)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.title = admitted.content
      }
      if (args.dependencies !== undefined) {
        patch.dependencies = (args.dependencies as string[]).map(id => TaskId(id))
      }
      if (args.acceptance_criteria !== undefined) {
        const admitted = admitContent(args.acceptance_criteria, 2000)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.acceptanceCriteria = admitted.content
      }
      if (args.flow_id !== undefined) {
        const flow = ledger.getFlow(args.flow_id)
        if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
        patch.flowId = flow.id
      }
      const edited = await ledger.editTask(taskId, patch)
      if (!edited.ok) throw new Error(edited.message)

      // Recompute readiness: a dependency edit may have cleared the last
      // blocker, in which case the task dispatches immediately.
      const blocked: string[] = [...blockedByOf(edited.task, ledger.listAll()).map(String)]
      if (blocked.length === 0) {
        await dispatchOne(ctx, ledger, taskId)
      }
      return { taskId: String(taskId), status: edited.task.status, blockedBy: blocked }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'report_task',
    description:
      'As the worker, submit the result of a task assigned to you: a working task becomes completed '
      + 'and waits for the dispatcher\'s verdict; you cannot settle it yourself. If the task was '
      + 'canceled, calling this attaches a summary of the work you had done — the status stays '
      + 'canceled. You may not report tasks that are still submitted (not yet claimed) or that are '
      + 'awaiting input.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id.' },
      result: { type: 'string', required: true, description: 'Your result (or the cancel summary).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:提交结果', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:提交结果', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'report_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const admitted = admitContent(args.result, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      if (task.status === 'canceled') {
        const attached = await ledger.attachReport(taskId, admitted.content)
        if (!attached.ok) throw new Error(attached.message)
        deps.noteActivity(callerId)
        return { taskId, status: attached.task.status }
      }
      // Long reports are externalized: the ledger row carries a bounded
      // summary plus the reference, and get_task reads the full text back.
      let report = admitted.content
      let reportRef: string | undefined
      if (report.length > config.maxInlineReport) {
        reportRef = await deps.reports.save(taskId, admitted.content)
        report = `${admitted.content.slice(0, config.maxInlineReport)}…`
      }
      const completed = await ledger.transition(taskId, 'completed', {
        report,
        ...(reportRef !== undefined ? { reportRef } : {}),
      })
      if (!completed.ok) throw new Error(completed.message)
      // The reviewer is woken to settle; default reviewer is the initiator.
      const reviewer = task.assignedReviewer ?? task.assignedBy
      const excerpt = admitted.content.length > 200
        ? `${admitted.content.slice(0, 200)}…`
        : admitted.content
      notifySession(ctx, reviewer, taskId,
        `任务 ${taskId} 已完成,当前状态为「待验收」,请调用 settle_task 验收。提交结果摘要:${excerpt}`,
        'report_task')
      deps.noteActivity(callerId)
      return { taskId, status: completed.task.status }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'settle_task',
    description:
      'As the reviewer, settle a completed task: outcome=success accepts it and the task is done; '
      + 'outcome=failure sends the SAME task back to the worker for rework, with your feedback as the '
      + 'rework instruction — the task id never changes across attempts. The worker is notified to '
      + 'rework automatically, and the initiator is notified of the final result. Only the task\'s '
      + 'reviewer (the reviewer named at dispatch, or the initiator by default) may settle it.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The completed ledger task id.' },
      outcome: {
        type: 'string',
        required: true,
        enum: ['success', 'failure'],
        description: 'success accepts; failure sends the task back for rework.',
      },
      feedback: { type: 'string', description: 'On failure: the rework instruction. On success: optional note.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} verdict: ${result.outcome} (status: ${result.status})`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:验收', kind: 'other', rawInput: { task_id: args.task_id, outcome: args.outcome } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:验收', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'settle_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeSettlement(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      const outcome = args.outcome === 'failure' ? 'failure' : 'success'
      const settled = await ledger.settle(taskId, outcome, args.feedback)
      if (!settled.ok) throw new Error(settled.message)
      // A settled task is terminal: its report moves hot -> cold.
      await deps.reports.archive(taskId)
      // DAG release: a success verdict frees every dependent whose blockers
      // cleared. The scheduler listener dispatches them.
      if (outcome === 'success') {
        ctx.emit('agent-bus/settle', taskId)
        // Result returns to the initiator: the loop closes. The notice names
        // every downstream task this one feeds, and the executor is asked to
        // hand off structured context to each of them.
        const downstream = ledger.listAll()
          .filter(row => (row.dependencies ?? []).includes(taskId))
          .map(row => row.id)
        const handoffHint = downstream.length > 0
          ? `该任务为以下后向任务提供前向依赖:${downstream.join(', ')}。执行方请为每个后向任务调用 submit_handoff 提交交接文档。`
          : ''
        notifySession(ctx, task.assignedBy, taskId,
          `任务 ${taskId} 已验收通过,状态「已完成」(success)。${handoffHint}最终结果:${settled.task.report ?? '(无)'}`,
          'settle_task')
        if (task.assignedTo !== undefined && task.assignedTo !== task.assignedBy && downstream.length > 0) {
          notifySession(ctx, task.assignedTo, taskId,
            `任务 ${taskId} 已验收通过。它为以下后向任务提供前向依赖:${downstream.join(', ')}。`
              + `请为每个后向任务调用 submit_handoff(task_id=${taskId}, to_task_id=<后向任务id>, document=<交接文档>) 提交交接文档。`,
            'settle_task')
        }
        // End-of-flow summary: when the settled task closes out its whole
        // flow, the creator gets one aggregated notice instead of silence —
        // "the flow finished, here is every step's result".
        if (task.flowId !== undefined) {
          const flow = ledger.getFlow(task.flowId)
          const flowTasks = ledger.listAll().filter(row => row.flowId === task.flowId)
          const allDone = flowTasks.length > 0 && flowTasks.every(row =>
            (row.status === 'completed' && row.outcome === 'success')
            || row.status === 'failed' || row.status === 'canceled' || row.status === 'rejected')
          if (flow !== undefined && allDone) {
            const summary = flowTasks.map(row =>
              `${row.id.slice(0, 8)}: ${row.status === 'completed' ? `已完成(${row.outcome})` : row.status}`,
            ).join('\n')
            notifySession(ctx, flow.createdBy, taskId,
              `流程「${flow.name}」已全部结算,不再有进行中的任务。各任务结果:\n${summary}`,
              'settle_task')
          }
        }
      } else if (task.assignedTo !== undefined) {
        // Rework loop: the worker is woken to execute the SAME task again.
        // The rework notice is a new delivery of the task, so its message id
        // must be recorded on the row first — otherwise the claimed listener
        // cannot find the task and it never leaves `submitted`.
        const instruction = args.feedback !== undefined ? args.feedback : '请根据验收意见重新执行。'
        const reworkNotice = buildTaskMessage(callerId, taskId,
          `任务 ${taskId} 验收未通过,已返回「待执行」等待重新执行(failure)。修改意见:${instruction}。请重新执行后调用 report_task 再次提交。`,
          'settle_task')
        const recorded = await ledger.recordDelivery(taskId, reworkNotice.id)
        if (!recorded.ok) throw new Error(recorded.message)
        const worker = ctx.agents.get(task.assignedTo)
        if (worker !== undefined) deliverTask(worker, reworkNotice, 'steer')
      }
      return { taskId, status: settled.task.status, outcome }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'cancel_task',
    description:
      'As the dispatcher, cancel a task you dispatched while it is queued(待投递), submitted, '
      + 'working, or awaiting your input. The worker is interrupted, told the task is canceled, and '
      + 'asked to report a summary of what it had done; the summary lands on the task (read it with '
      + 'get_task). A task that was never delivered (待投递) is canceled without bothering the '
      + 'worker. Only the session that dispatched a task may cancel it; workers cannot cancel their '
      + 'own dispatched tasks.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id to cancel.' },
      reason: { type: 'string', description: 'Why the task is canceled, shown to the worker.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:取消任务', kind: 'other', rawInput: { task_id: args.task_id, ...(args.reason !== undefined ? { reason: args.reason } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:取消任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'cancel_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeSettlement(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      const reason = args.reason !== undefined ? admitContent(args.reason, 400) : undefined
      if (reason !== undefined && !reason.ok) throw new Error(reason.message)
      const canceled = await ledger.transition(taskId, 'canceled', {
        ...(reason?.ok === true ? { reason: reason.content } : {}),
      })
      if (!canceled.ok) throw new Error(canceled.message)
      // A canceled task is terminal: its report moves hot -> cold.
      await deps.reports.archive(taskId)

      // Interrupt the worker's in-flight turn, then ask for the summary. Both
      // are best-effort: an absent worker keeps the canceled row and the
      // summary request is skipped. A queued task was never delivered, so its
      // worker has nothing to summarize — cancel quietly.
      const worker = task.assignedTo !== undefined && task.status !== 'queued'
        ? ctx.agents.get(task.assignedTo)
        : undefined
      if (worker !== undefined) {
        try {
          worker.cancel({ kind: 'user' }, { keepInbox: true })
        } catch {
          // The cancel signal is advisory; a worker that already settled the
          // turn needs no interruption.
        }
        const note = `任务 ${taskId} 状态「已取消」,由派发方取消${reason?.ok === true ? `(${reason.content})` : ''}。`
          + '请用 report_task 提交你已完成部分的摘要。'
        const summary = buildTaskMessage(callerId, taskId, note, 'cancel_task')
        deliverTask(worker, summary, 'steer')
      }
      return { taskId, status: canceled.task.status }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'request_input',
    description:
      'As the worker, pause a task you are working on because you need information only the '
      + 'dispatcher has. The task enters input-required with your question; the dispatcher answers '
      + 'with create_task passing task_id, and the task resumes when the answer arrives. Keep the '
      + 'question specific so one round-trip suffices.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The working ledger task id.' },
      question: { type: 'string', required: true, description: 'What you need from the dispatcher.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:请求输入', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:请求输入', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'request_input')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const admitted = admitContent(args.question, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const paused = await ledger.transition(taskId, 'input-required', { question: admitted.content })
      if (!paused.ok) throw new Error(paused.message)
      deps.noteActivity(callerId)
      return { taskId, status: paused.task.status }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'claim_task',
    description:
      'As the executor, pull a task you were assigned back into working: a '
      + 'submitted task is delivered automatically, but a re-delivery can land '
      + 'while the previous delivery was lost (a rejected step, a restart) — '
      + 'claiming gives you the key to recover it yourself and then report. '
      + 'Only the assigned executor may claim. Claiming a task you already '
      + 'have in working is a no-op that returns the current status.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id to claim.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:领取任务', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:领取任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'claim_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeClaim(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      // Already working AND the executor is the caller: idempotent no-op.
      if (task.status === 'working') {
        deps.noteActivity(callerId)
        return { taskId: String(taskId), status: task.status }
      }
      if (task.status !== 'submitted') {
        throw new Error(`task "${taskId}" is ${task.status}; only a submitted task can be claimed`)
      }
      const claimed = await ledger.transition(taskId, 'working')
      if (!claimed.ok) throw new Error(claimed.message)
      deps.noteActivity(callerId)
      return { taskId: String(taskId), status: claimed.task.status }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'archive_task',
    description:
      'Mark one task archived or unarchived (manual, never automatic). Archiving is a visibility '
      + 'choice: it hides the row from list_tasks and the active listing; unarchiving restores it. '
      + 'A queued, working, or completed task may be archived, and the change is reversible. Nothing '
      + 'in the lifecycle machine archives a task on its own.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id to toggle.' },
      archived: {
        type: 'boolean',
        description: 'true archives (default), false unarchives.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `任务 ${result.taskId} [${result.status}] 已${result.archived ? '归档' : '取消归档'}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:归档任务', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:归档任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'archive_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (!canReadTask(task, callerId)) throw new Error(`task "${taskId}" is not visible to you`)
      const archived = args.archived !== false
      const archivedRes = await ledger.archiveTask(taskId, archived)
      if (!archivedRes.ok) throw new Error(archivedRes.message)
      return { taskId: String(taskId), status: archivedRes.task.status, archived }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'archive_flow',
    description:
      'Mark one flow archived or unarchived (manual, never automatic). A flow stays active until '
      + 'you archive it, and archiving is not derived from its tasks; unarchiving restores it. Only '
      + 'the flow creator may archive it.',
    parameters: {
      flow_id: { type: 'string', required: true, description: 'The flow id to toggle.' },
      archived: {
        type: 'boolean',
        description: 'true archives (default), false unarchives.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `流程 『${result.name}』 已${result.archived ? '归档' : '取消归档'}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:归档流程', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:归档流程', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'archive_flow')
      const flowId = String(args.flow_id)
      const flow = ledger.getFlow(flowId)
      if (flow === undefined) throw new Error(`no such flow "${flowId}"`)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('archive_flow: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace !== flow.workspacePath) {
        throw new Error(`flow "${flowId}" is in a different workspace`)
      }
      const archived = args.archived !== false
      const archivedRes = await ledger.archiveFlow(flowId, archived)
      if (!archivedRes.ok) throw new Error(archivedRes.message)
      return { flowId, name: archivedRes.flow.name, archived }
    },
  }))
}
