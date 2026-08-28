/** Flows tools (registered under the output-schema gate). */

import { checkedTool } from './checked-tool.ts'
import { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID, view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds, assertFlowName, randomTaskId, isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry, ToolsConfig, ToolsDeps, TaskView, TaskDetailView } from './common.ts'

export function registerFlowsTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

ctx.tools.register(checkedTool({
    name: 'create_flow',
    description:
      'LARGE scope: create a flow — the roadmap container for a multi-step effort. FIRST write out '
      + 'the full plan (what must happen, in what order, by whom, what "done" means for each step), '
      + 'THEN create the flow, then split the plan into tasks created with flow_id and dependencies '
      + 'so the DAG auto-schedules: each task delivers only after its predecessors settle, and a '
      + 'failure propagates down the chain automatically. Every dependency of a task must live in '
      + 'the same flow (add the task to the flow first with edit_task flow_id), so one flow is '
      + 'always one DAG and cross-flow references are impossible. The DAG view renders per flow; a '
      + 'flow whose tasks are all archived moves to the archived section automatically. The flow name '
      + 'must be ≤20 characters and concisely name the task group\'s core.',
    parameters: {
      name: { type: 'string', required: true, description: 'Flow display name, ≤20 characters (concise name for the task group\'s core content).' },
      description: { type: 'string', description: 'Optional note about the flow.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          suggestion: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `flow ${result.flowId} created: ${result.name}`
          + (result.suggestion !== undefined ? `\n${result.suggestion}` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建流程', kind: 'other', rawInput: { name: args.name } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建流程', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_flow')
      const name = String(args.name ?? '').trim()
      assertFlowName(name)
      const description = args.description !== undefined
        ? admitContent(String(args.description), 400)
        : undefined
      if (description !== undefined && !description.ok) throw new Error(description.message)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('create_flow: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) {
        throw new Error('create_flow: the calling session is not inside a registered workspace')
      }
      const flowId = randomUUID()
      const flow = await ledger.createFlow(
        flowId, name, description?.ok === true ? description.content : undefined,
        callerId, workspacePath,
      )
      // Decision 8: a meaningless name (no letter in any script — pure digits
      // or symbols) is allowed, but the model gets a naming suggestion.
      const suggestion = /\p{L}/u.test(name)
        ? undefined
        : '建议格式:目标 + 阶段,如『电商站上线:Phase 1 基建』'
      return {
        flowId: flow.id,
        name: flow.name,
        ...(suggestion !== undefined ? { suggestion } : {}),
      }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'create_batch',
    description:
      'BATCH scope: create a lightweight batch of related deliverables in one call — the middle '
      + 'ground between create_task (one deliverable) and create_flow (a full DAG). Each '
      + 'deliverable becomes a normal task (report → settle, per-item), all sharing one batch id '
      + 'so the whole set can be viewed with list_batch and each item settled individually with '
      + 'settle_task. A batch has NO dependency graph: every task delivers immediately, so there '
      + 'is no scheduling or DAG overhead. Pass one deliverables entry per peer (fan out to several '
      + 'peers) or several entries to one peer (group related work). Each entry needs target + '
      + 'content; title defaults to the content head, and an optional per-entry reviewer enables a '
      + 'different session to settle it. name is an optional batch label (≤20 chars); omit it to '
      + 'derive one from the first deliverable.',
      parameters: {
        name: {
          type: 'string',
          description: 'Optional batch label, ≤20 characters; omitted derives one from the first deliverable.',
        },
        deliverables: {
          type: 'array',
          required: true,
          description: 'One or more related deliverables to create as tasks in a lightweight batch (no DAG).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              target: { type: 'string', required: true, description: 'Session id or peer title of the executor, from list_peers.' },
              content: { type: 'string', required: true, description: 'The deliverable instruction.' },
              title: { type: 'string', description: 'Short display title (1–20 chars); defaults to the content head when omitted.' },
              acceptance_criteria: { type: 'string', description: 'The minimum acceptance requirement the reviewer settles against.' },
              reviewer: { type: 'string', description: 'Session id of the reviewer who settles this deliverable; defaults to you.' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            batchId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            created: { type: 'number', required: true },
            tasks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  taskId: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  to: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, result) => [{
          type: 'text',
          text: `batch ${result.batchId} created: ${result.name} (${String(result.created)} task(s))\n`
            + result.tasks.map(task =>
              `  ${task.taskId.slice(0, 8)}… → ${String(task.status)} (${task.to.slice(0, 8)}…) ${task.title}`,
            ).join('\n'),
        }],
      },
      presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建批次', kind: 'other', rawInput: { name: args.name } }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建批次', rawInput: result }),
      async execute(args, exec) {
        const callerId = requireCaller(exec.agent, 'create_batch')
        if (!limiter.admit(callerId, Date.now())) {
          throw new Error(
            `dispatch rate exceeded: at most ${config.maxSendsPerMinute} sends per minute`,
          )
        }
        const caller = ctx.agents.get(callerId)
        if (caller === undefined) throw new Error('create_batch: the calling session is not a live agent')
        const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
        if (callerWorkspace === undefined) {
          throw new Error('create_batch: the calling session is not inside a registered workspace')
        }
        const deliverables = args.deliverables as Array<Record<string, unknown>> | undefined
        if (deliverables === undefined || deliverables.length === 0) {
          throw new Error('create_batch needs at least one deliverable')
        }

        // Pre-flight every deliverable up front so a later item's refusal does
        // not leave a half-created batch: resolve the target, authorize it,
        // admit the content, derive the title, and resolve an optional reviewer.
        const items: {
          targetId: SessionId
          workspacePath: string
          content: string
          title: string
          criteria: string | undefined
          reviewer: SessionId | undefined
        }[] = []
        for (let i = 0; i < deliverables.length; i++) {
          const deliverable = deliverables[i]!
          const targetValue = deliverable.target === undefined ? '' : String(deliverable.target)
          if (targetValue === '') {
            throw new Error(`deliverable ${i + 1} is missing a target`)
          }
          const targetId = await resolvePeerTarget(ctx, workspaces, callerId, targetValue)
          const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, targetId)
          if (!decision.ok) throw new Error(`deliverable ${i + 1} (target ${targetValue}): ${decision.message}`)
          const content = admitContent(deliverable.content === undefined ? '' : String(deliverable.content), config.maxContentLength)
          if (!content.ok) throw new Error(`deliverable ${i + 1}: ${content.message}`)
          const rawTitle = (deliverable.title !== undefined && String(deliverable.title).trim() !== '')
            ? String(deliverable.title).trim()
            : content.content.slice(0, 20).trim()
          if (rawTitle.length === 0 || rawTitle.length > 20) {
            throw new Error(`deliverable ${i + 1} title must be 1-20 characters`)
          }
          let criteria: string | undefined
          if (deliverable.acceptance_criteria !== undefined) {
            const admitted = admitContent(String(deliverable.acceptance_criteria), 2000)
            if (!admitted.ok) throw new Error(`deliverable ${i + 1}: ${admitted.message}`)
            criteria = admitted.content
          }
          let reviewer: SessionId | undefined
          if (deliverable.reviewer !== undefined) {
            const reviewerId = await resolvePeerTarget(ctx, workspaces, callerId, String(deliverable.reviewer))
            const reviewerDecision = await authorizePeerOrDormant(ctx, workspaces, callerId, reviewerId)
            if (!reviewerDecision.ok) throw new Error(`deliverable ${i + 1} reviewer: ${reviewerDecision.message}`)
            reviewer = reviewerId
          }
          // Self-execution keeps accountability: when a deliverable targets the
          // caller, the reviewer must be a different session (same rule as
          // create_task).
          if (targetId === callerId && (reviewer === undefined || reviewer === callerId)) {
            throw new Error(
              `deliverable ${i + 1}: self-execution requires reviewer; name a different session`,
            )
          }
          items.push({
            targetId, workspacePath: decision.workspacePath, content: content.content,
            title: rawTitle, criteria, reviewer,
          })
        }

        // Pre-flight the per-recipient queue ceiling: the ledger refuses a row
        // when its recipient holds maxPendingPerAgent unfinished tasks, so a
        // batch that would push a recipient over the line must fail up front
        // rather than partially create.
        const batchAll = ledger.listAll()
        const newByTarget = new Map<string, number>()
        for (const item of items) {
          newByTarget.set(String(item.targetId), (newByTarget.get(String(item.targetId)) ?? 0) + 1)
        }
        for (const [targetId, newCount] of newByTarget) {
          const existing = batchAll.filter(row =>
            row.assignedTo === targetId
            && (row.status === 'submitted' || row.status === 'working' || row.status === 'input-required'),
          ).length
          if (existing + newCount > config.maxPendingPerAgent) {
            throw new Error(
              `session "${targetId}" already has ${existing} unfinished tasks; adding ${newCount} would exceed the ${config.maxPendingPerAgent} limit`,
            )
          }
        }

        // Batch label: explicit name, else derived from the first deliverable.
        const explicitName = args.name !== undefined ? String(args.name).trim() : ''
        const batchName = explicitName !== ''
          ? explicitName
          : items[0]!.title.slice(0, 20)
        if (batchName.length === 0 || batchName.length > 20) {
          throw new Error(`batch name is ${batchName.length} characters, over the 20 limit`)
        }

        const batchId = randomUUID()
        await ledger.createBatch(batchId, batchName, callerId, callerWorkspace)
        const tasks: Array<{ taskId: string; status: string; to: string; title: string }> = []
        for (const item of items) {
          const taskId = TaskId(randomTaskId())
          const message = buildTaskMessage(callerId, taskId, item.content)
          const tokensAtStart = snapshotTokensAtDispatch(ctx, callerId, item.targetId, item.reviewer)
          const recorded = await ledger.record({
            id: taskId,
            assignedBy: callerId,
            assignedTo: item.targetId,
            ...(item.reviewer !== undefined ? { assignedReviewer: item.reviewer } : {}),
            workspacePath: item.workspacePath,
            content: item.content,
            mode: 'steer',
            retries: 0,
            ...(tokensAtStart !== undefined ? { tokensAtStart } : {}),
            ...(item.criteria !== undefined ? { acceptanceCriteria: item.criteria } : {}),
            batchId,
            title: item.title,
          }, config.maxPendingPerAgent)
          if (!recorded.ok) throw new Error(`deliverable "${item.title}": ${recorded.message}`)
          // A batch has no dependencies, so every task delivers immediately
          // (wake-on-delivery); an unwakeable target falls back to queued,
          // which the backstop sweep later delivers.
          const target = await wakeSession(ctx, item.targetId)
          if (target !== undefined) {
            await ledger.recordDelivery(taskId, message.id)
            deliverTask(target, message, 'steer')
          } else {
            await ledger.transition(taskId, 'queued')
          }
          const fresh = ledger.get(taskId)
          tasks.push({
            taskId: String(taskId),
            status: fresh?.status ?? recorded.task.status,
            to: String(item.targetId),
            title: item.title,
          })
        }
        return { batchId, name: batchName, created: tasks.length, tasks }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'rename_flow',
    description:
      'Rename a flow, optionally replacing its description. The new name must be '
      + 'unique within the workspace — renaming onto an existing flow\'s name is refused with the '
      + 'existing names listed. Pass description to replace it, an empty string to clear it, or '
      + 'omit it to keep the current note. Any session in the flow\'s workspace may rename it. '
      + 'The new name must be ≤20 characters and concisely name the task group\'s core.',
    parameters: {
      flow_id: { type: 'string', required: true, description: 'The flow id to rename.' },
      name: { type: 'string', required: true, description: 'New flow display name, ≤20 characters (concise name for the task group\'s core content).' },
      description: { type: 'string', description: 'Replacement note; empty clears it, omit keeps it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          description: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `flow ${result.flowId} renamed to ${result.name}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:重命名流程', kind: 'other', rawInput: { flow_id: args.flow_id, name: args.name } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:重命名流程', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'rename_flow')
      const name = String(args.name ?? '').trim()
      assertFlowName(name)
      const flow = ledger.getFlow(args.flow_id)
      if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('rename_flow: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace !== flow.workspacePath) {
        throw new Error(`仅工作区成员可改名:flow "${flow.id}" is in a different workspace`)
      }
      const description = args.description !== undefined
        ? admitContent(String(args.description), 400)
        : undefined
      if (description !== undefined && !description.ok) throw new Error(description.message)
      const renamed = await ledger.renameFlow(
        flow.id,
        name,
        description?.ok === true ? description.content : undefined,
      )
      if (!renamed.ok) throw new Error(renamed.message)
      return {
        flowId: renamed.flow.id,
        name: renamed.flow.name,
        ...(renamed.flow.description !== undefined ? { description: renamed.flow.description } : {}),
      }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'list_flows',
    description:
      'List the flows in your workspace: each flow\'s name, task counts, and whether it is archived '
      + '(every task in it has settled and left the active set). Use create_task with flow_id to add '
      + 'tasks to a flow, and edit_task with flow_id to move a task between flows.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            description: { type: 'string' },
            taskCount: { type: 'number', required: true },
            unsettledCount: { type: 'number', required: true },
            archived: { type: 'boolean', required: true },
          },
        },
      },
      render: (_args, flows) => [{
        type: 'text',
        text: flows.length === 0
          ? '(no flows)'
          : flows.map(f =>
            `${f.name} [${f.archived ? '已归档' : '活跃'}] tasks=${String(f.taskCount)} unsettled=${String(f.unsettledCount)}${f.description !== undefined ? ` — ${f.description.slice(0, 60)}` : ''} (${f.id.slice(0, 8)})`,
          ).join('\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:流程列表', kind: 'other' }),
    presentResult: (_args, flows) => ({ card: 'generic', title: 'agent-bus:流程列表', rawInput: flows }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_flows')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_flows: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return []
      const all = ledger.listAll()
      const flows = ledger.listFlows()
        .filter(flow => flow.workspacePath === workspacePath)
        .map(flow => {
          const tasks = all.filter(row => row.flowId === flow.id)
          const unsettled = tasks.filter(row => !isSettledTask(row))
          return {
            id: flow.id,
            name: flow.name,
            ...(flow.description !== undefined ? { description: flow.description } : {}),
            taskCount: tasks.length,
            unsettledCount: unsettled.length,
            // Archive is a user action, never derived from task state.
            archived: flow.archived === true,
          }
        })
      return flows
    },
  }))

ctx.tools.register(checkedTool({
    name: 'list_batches',
    description:
      'List the lightweight batches in your workspace: each batch\'s name, task count, and how many '
      + 'of its tasks are still unsettled, in creation order. Batches come from create_batch — they '
      + 'group related deliverables sharing a batch id but build no DAG. Use list_batch with a '
      + 'batch_id to expand one batch into its full task rows.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            createdAt: { type: 'string', required: true },
            taskCount: { type: 'number', required: true },
            unsettledCount: { type: 'number', required: true },
          },
        },
      },
      render: (_args, batches) => [{
        type: 'text',
        text: batches.length === 0
          ? '(no batches)'
          : batches.map(batch =>
            `${batch.name} tasks=${String(batch.taskCount)} unsettled=${String(batch.unsettledCount)} (${batch.id.slice(0, 8)})`,
          ).join('\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:批次列表', kind: 'other' }),
    presentResult: (_args, batches) => ({ card: 'generic', title: 'agent-bus:批次列表', rawInput: batches }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_batches')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_batches: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return []
      const all = ledger.listAll()
      return ledger.listBatches(workspacePath).map(batch => {
        const tasks = all.filter(row => row.batchId === batch.id)
        const unsettled = tasks.filter(row => !isSettledTask(row))
        return {
          id: batch.id,
          name: batch.name,
          createdAt: batch.createdAt,
          taskCount: tasks.length,
          unsettledCount: unsettled.length,
        }
      })
    },
  }))

ctx.tools.register(checkedTool({
    name: 'list_batch',
    description:
      'Read one lightweight batch as a whole: the batch header (id, name, creator, creation time) '
      + 'plus every task row in it, in creation order. Each task still settles individually with '
      + 'settle_task; this just lets you see the whole grouped set at once. A live task is shown only '
      + 'to its participants (same read rule as get_task); completed and failed tasks are public. '
      + 'Only a session inside the batch\'s workspace may read it.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'The batch id (from create_batch or list_batches).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
          createdBy: { type: 'string', required: true },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                to: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string', required: true },
                report: { type: 'string' },
                outcome: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, batch) => [{
        type: 'text',
        text: `batch ${batch.id} — ${batch.name} (by ${batch.createdBy.slice(0, 8)}…, created ${batch.createdAt})\n`
          + (batch.tasks.length === 0
            ? '(no tasks)'
            : batch.tasks.map(task =>
              `  ${task.id.slice(0, 8)}… [${task.status}]${task.title !== undefined ? ` ${task.title}` : ''}${task.report !== undefined ? ` — ${task.report.slice(0, 60)}` : ''}`,
            ).join('\n')),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:读取批次', kind: 'other', rawInput: { batch_id: args.batch_id } }),
    presentResult: (_args, batch) => ({ card: 'generic', title: 'agent-bus:读取批次', rawInput: batch }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'list_batch')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_batch: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) {
        throw new Error('list_batch: the calling session is not inside a registered workspace')
      }
      const batch = ledger.getBatch(args.batch_id)
      if (batch === undefined) throw new Error(`no such batch "${args.batch_id}"`)
      if (batch.workspacePath !== workspacePath) {
        throw new Error(`batch "${args.batch_id}" is in a different workspace`)
      }
      const tasks = ledger.listAll()
        .filter(row => row.batchId === batch.id && canReadTask(row, callerId))
        .map(row => ({
          id: String(row.id),
          status: row.status,
          ...(row.assignedTo !== undefined ? { to: String(row.assignedTo) } : {}),
          ...(row.title !== undefined ? { title: row.title } : {}),
          content: row.content,
          ...(row.report !== undefined ? { report: row.report } : {}),
          ...(row.outcome !== undefined ? { outcome: row.outcome } : {}),
        }))
      return {
        id: batch.id,
        name: batch.name,
        createdAt: batch.createdAt,
        createdBy: String(batch.createdBy),
        tasks,
      }
    },
  }))
}
