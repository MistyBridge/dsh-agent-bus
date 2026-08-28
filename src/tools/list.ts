/** List tools (registered under the output-schema gate). */

import { checkedTool } from './checked-tool.ts'
import { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID, view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds, assertFlowName, randomTaskId, isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry, ToolsConfig, ToolsDeps, TaskView, TaskDetailView } from './common.ts'

export function registerListTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

ctx.tools.register(checkedTool({
    name: 'list_peers',
    description:
      'List the other agent sessions in your workspace — live and dormant — which are the valid '
      + 'targets for create_task and send_note. Reachability is workspace membership: a session '
      + 'counts as a peer when its working directory is the same registered workspace as yours. '
      + 'Archived sessions never appear. A dormant peer is a real same-workspace member that is not '
      + 'currently live but can be woken for delivery. Status is running (busy now), idle (loaded, '
      + 'between turns), or dormant (not live, wakeable). A peer that wrote a card shows its '
      + 'self-description and machine-readable capabilities. This snapshot is not a delivery '
      + 'promise; create_task performs the authoritative check and may still refuse.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              id: { type: 'string' },
            },
          },
          peers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string' },
                status: { type: 'string', required: true, enum: ['running', 'idle', 'dormant'] },
                pendingTasks: { type: 'number', required: true },
                description: { type: 'string' },
                capabilities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, result) => {
        const workspace = result.workspace !== undefined
          ? `\ncurrent workspace: ${result.workspace.path}${result.workspace.id !== undefined ? ` (id ${result.workspace.id})` : ''}`
          : '\ncurrent workspace: (none — you are not inside a registered workspace)'
        const body = result.peers.length === 0
          ? 'no reachable peers — use create_member to create a peer session, or confirm your workspace.'
          : result.peers.map(p => {
            const name = p.title !== undefined && p.title !== '' ? p.title : p.id
            const caps = Array.isArray(p.capabilities) && p.capabilities.length > 0
              ? ` caps=${p.capabilities.map(c => c.id).join(',')}`
              : ''
            const desc = p.description !== undefined && p.description !== ''
              ? ` — ${p.description.slice(0, 60)}`
              : ''
            return `${name} [${p.status}] pending=${String(p.pendingTasks)}${caps}${desc} (${p.id})`
          }).join('\n')
            + '\n(target: use the id, not the title, for create_task/send_note — the id is unambiguous)'
        return [{ type: 'text', text: workspace + '\n' + body }]
      },
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:发现 peer', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:发现 peer', rawInput: result }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_peers')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_peers: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return { peers: [] }
      // Peers are the caller's workspace account, NOT just live agents: a
      // dormant (persisted but not currently live) same-workspace session is
      // still a valid, wakeable target and must appear. The registry account
      // is the sidebar's source, so whatever the sidebar shows is the peer set.
      const workspace = workspaces.list().find(entry => entry.path === workspacePath)
      if (workspace === undefined) return { peers: [] }
      const archived = new Set<string>(workspaces.archivedSessionIds as readonly string[])
      const live = new Map<string, Agent>()
      for (const agent of ctx.agents.list()) live.set(String(agent.id), agent)
      const subagents = await subagentSessionIds(ctx)
      const titles = await readTitlesFile(dshHomePath('storages', 'session_projcache.json'))
      const peers: {
        id: SessionId; title?: string; status: 'running' | 'idle' | 'dormant'; pendingTasks: number;
        description?: string; capabilities?: { id: string; label: string }[];
      }[] = []
      for (const sessionId of workspace.sessionIds) {
        if (String(sessionId) === String(callerId)) continue
        if (archived.has(String(sessionId))) continue
        // Subagents answer to their parent through the harness lineage, not
        // to workspace peers.
        if (subagents.has(String(sessionId))) continue
        const agent = live.get(String(sessionId))
        const pending = ledger.listFor(sessionId).filter(
          row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
        )
        const card = ledger.getCard(sessionId)
        peers.push({
          id: sessionId,
          title: peerTitleOf(ctx, titles, agent, sessionId),
          status: agent === undefined ? 'dormant' : agent.status === 'running' ? 'running' : 'idle',
          pendingTasks: pending.length,
          ...(card !== undefined ? { description: card.description } : {}),
          ...(card !== undefined && card.capabilities.length > 0
            ? { capabilities: card.capabilities.map(c => ({ id: c.id, label: c.label })) }
            : {}),
        })
      }
      // The caller's current workspace, read-only: `path` is always derivable
      // from resolveWorkspacePath; `id` comes from the registry entry when one
      // exists (the test/standalone registry stub may omit it).
      const workspaceId = (workspace as { id?: string }).id
      return {
        workspace: {
          path: workspacePath,
          ...(workspaceId !== undefined ? { id: workspaceId } : {}),
        },
        peers,
      }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'list_tasks',
    description:
      'List the ACTIVE tasks in the ledger. Scope inbox (default) shows work addressed to you, in the '
      + 'order you will do it; scope outbox shows what you dispatched and its current state. Archived '
      + 'tasks are invisible by design: a task leaves the listing once it failed, was canceled, or its '
      + 'settlement is more than 24 hours old — history lives in the panel and session logs. A completed '
      + 'task awaiting your verdict is still active and includes its report text, so read it before '
      + 'settling. Pass status to filter to one task state. Use get_task when a listing truncates a '
      + 'long report.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['inbox', 'outbox'],
        description: 'inbox (default) lists tasks assigned to you; outbox lists tasks you dispatched.',
      },
      status: {
        type: 'string',
        enum: [
          'queued', 'submitted', 'working', 'input-required', 'auth-required',
          'completed', 'failed', 'canceled', 'rejected',
        ],
        description: 'Optional: list only tasks in this state.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            from: { type: 'string', required: true },
            to: { type: 'string' },
            content: { type: 'string', required: true },
            title: { type: 'string' },
            report: { type: 'string' },
            outcome: { type: 'string' },
            reason: { type: 'string' },
            retries: { type: 'number', required: true },
            acceptanceCriteria: { type: 'string' },
            dependencies: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      render: (_args, tasks) => [{
        type: 'text',
        text: tasks.length === 0
          ? '(no tasks)'
          : tasks.map(renderTaskRow).join('\n'),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:任务列表', kind: 'other', rawInput: { scope: args.scope, ...(args.status !== undefined ? { status: args.status } : {}) } }),
    presentResult: (_args, tasks) => ({ card: 'generic', title: 'agent-bus:任务列表', rawInput: tasks }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'list_tasks')
      const scope = args.scope === 'outbox' ? 'outbox' : 'inbox'
      let rows: TaskRecord[]
      switch (scope) {
        case 'inbox':
          rows = ledger.listFor(callerId)
          break
        case 'outbox':
          rows = ledger.listBy(callerId)
          break
        /* v8 ignore next 2 -- the schema-validated closed enum is normalized before dispatch. */
        default:
          return assertNever(scope, 'list_tasks scope')
      }
      if (args.status !== undefined) {
        rows = rows.filter(row => row.status === args.status)
      }
      rows = rows.filter(row => isActiveTask(row, Date.now()))
      return rows.map(view)
    },
  }))

ctx.tools.register(checkedTool({
    name: 'get_task',
    description:
      'Read one task\'s full record: the complete task content and submitted result, without the '
      + 'truncation list_tasks applies. A live task is readable only by its participants (the '
      + 'dispatching session, the assigned session, and the reviewer); completed or terminally-failed '
      + 'tasks are history and publicly readable. Use it to review a long report before settling.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string' },
          content: { type: 'string', required: true },
          title: { type: 'string' },
          acceptanceCriteria: { type: 'string' },
          handoffs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fromTask: { type: 'string', required: true },
                document: { type: 'string', required: true },
                at: { type: 'string', required: true },
              },
            },
          },
          report: { type: 'string' },
          question: { type: 'string' },
          outcome: { type: 'string' },
          feedback: { type: 'string' },
          reason: { type: 'string' },
          reviewer: { type: 'string' },
          retries: { type: 'number', required: true },
          createdAt: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
      render: (_args, detail) => [{ type: 'text', text: renderTaskDetail(detail) }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:读取任务', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, detail) => ({ card: 'generic', title: 'agent-bus:读取任务', rawInput: detail }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'get_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('get_task: the calling session is not a live agent')
      // Decision 4: a live task is readable by its participants alone; a
      // non-participant gets "该任务与你无关" with no content. Completed and
      // terminally-failed tasks are history and public.
      const denial = authorizeTaskRead(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      // Externalized reports are read back so the reviewer sees the full
      // result; a missing file degrades to the inline summary.
      let fullReport: string | undefined
      if (task.reportRef !== undefined) {
        fullReport = await deps.reports.read(task.reportRef)
      }
      return fullReport !== undefined
        ? { ...detailView(task), report: fullReport }
        : detailView(task)
    },
  }))

ctx.tools.register(checkedTool({
    name: 'update_card',
    description:
      'Maintain your own capability card, which list_peers shows to the workspace. description is '
      + 'what you say about yourself, for other agents to read; capabilities are machine-readable '
      + 'labels — ids are lowercase kebab-case keys, at most 8, each with a short label. The update '
      + 'replaces the whole card. Keep the description honest and the capabilities narrow: peers '
      + 'route work by what you claim here.',
    parameters: {
      description: { type: 'string', description: 'One or two sentences about what you do well.' },
      capabilities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Lowercase kebab-case machine key.' },
            label: { type: 'string', required: true, description: 'Short human-readable label.' },
          },
        },
        description: 'Your machine-readable capability list, at most 8 entries.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
          capabilities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, card) => [{
        type: 'text',
        text: card.description === ''
          ? '(card cleared)'
          : `${card.description}\n${(card.capabilities ?? []).map(c => `${c.id}: ${c.label}`).join('\n')}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:更新卡片', kind: 'other', rawInput: { description: args.description, capabilities: args.capabilities } }),
    presentResult: (_args, card) => ({ card: 'generic', title: 'agent-bus:更新卡片', rawInput: card }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'update_card')
      const description = (args.description ?? '').trim()
      if (description.length > 200) {
        throw new Error(`description is ${description.length} characters, over the 200 limit`)
      }
      const capabilities = (args.capabilities ?? []).map(item => ({
        id: String(item.id).trim(),
        label: String(item.label).trim(),
      }))
      const seen = new Set<string>()
      for (const cap of capabilities) {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(cap.id)) {
          throw new Error(`capability id "${cap.id}" must be lowercase kebab-case`)
        }
        if (cap.label.length === 0 || cap.label.length > 50) {
          throw new Error(`capability label for "${cap.id}" must be 1-50 characters`)
        }
        if (seen.has(cap.id)) {
          throw new Error(`duplicate capability id "${cap.id}"`)
        }
        seen.add(cap.id)
      }
      const card = { description, capabilities, updatedAt: new Date().toISOString() }
      await ledger.putCard(callerId, card)
      // The durable record carries updatedAt; the tool result is the
      // model-facing projection, which must match the declared output schema.
      return { description, capabilities }
    },
  }))
}
