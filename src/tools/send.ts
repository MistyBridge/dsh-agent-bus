/** Send tools (registered under the output-schema gate). */

import { checkedTool } from './checked-tool.ts'
import { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID, view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds, assertFlowName, randomTaskId, isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry, ToolsConfig, ToolsDeps, TaskView, TaskDetailView } from './common.ts'

export function registerSendTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

ctx.tools.register(checkedTool({
    name: 'wake_member',
    description:
      'Wake one dormant member session (a non-archived peer in your workspace) so it becomes a '
      + 'live agent you can send_note / create_task to immediately. A dormant peer is a real '
      + 'same-workspace member that is persisted but not currently loaded; waking resumes it with '
      + 'its recorded composition and model route. The member stays live for the process lifetime '
      + 'after a wake. Use this to activate a peer before dispatching work to it — list_peers shows '
      + 'which peers are dormant.',
    parameters: {
      member_id: { type: 'string', required: true, description: 'The member session id (peer id from list_peers) to wake.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberId: { type: 'string', required: true },
          title: { type: 'string' },
          status: { type: 'string', required: true, enum: ['running', 'idle'] },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `成员 ${result.memberId} 已激活 (${result.status}${result.title !== undefined ? ` — ${result.title}` : ''})`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:唤醒成员', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:唤醒成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'wake_member')
      // Authorize the target as a same-workspace peer (live or dormant,
      // non-archived, non-subagent) before waking — the same gate create_task /
      // reassign use, so only a real reachable member can be activated.
      const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, String(args.member_id) as SessionId)
      if (!decision.ok) throw new Error(decision.message)
      const target = await wakeSession(ctx, String(args.member_id) as SessionId)
      if (target === undefined) {
        throw new Error(`wake_member: session "${String(args.member_id)}" could not be woken (no model route or resume failed)`)
      }
      const title = ctx.sessionTitle.get(target.session)?.title
      return {
        memberId: String(args.member_id),
        ...(title !== undefined && title !== '' ? { title } : {}),
        status: target.status === 'running' ? 'running' : 'idle',
      }
    },
  }))

ctx.tools.register(checkedTool({
    // Named send_note, NOT send_message: the harness bundle reserves
    // send_message globally for subagent conversation (dsh-tool-subagent-
    // control), so the peer channel must not collide with it.
    name: 'send_note',
    description:
      'SMALL scope: send a lightweight note to a live peer in your workspace — a message, a '
      + 'question, a confirmation, a coordination ping; anything that is NOT work the peer must '
      + 'deliver a verifiable result for. The note lands in the peer\'s inbox like an ordinary '
      + 'message; there is NO task record, no acceptance, and nothing to report or settle. The '
      + 'peer simply replies in prose (with send_note back to you, if it replies at all). Use '
      + 'create_task instead when the peer must produce a result you will verify — a note channel '
      + 'needs no lifecycle, and a task channel whose work was really a chat is how tasks get '
      + 'stuck forever in working.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id or peer title of the recipient, from list_peers.' },
      content: { type: 'string', required: true, description: 'The note text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          queued: { type: 'boolean', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.delivered
          ? `note delivered (${String(result.messageId).slice(0, 8)}…)`
          : result.queued === true
            ? `recipient offline — note queued, delivered when they are live (${String(result.messageId).slice(0, 8)}…)`
            : 'note not delivered',
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:发送消息', kind: 'other', rawInput: { target: args.target } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:发送消息', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'send_note')
      if (!deps.messageLimiter.admit(callerId, Date.now())) {
        throw new Error(
          `message rate exceeded: at most ${config.maxMessagesPerMinute} messages per minute`,
        )
      }
      const targetId = await resolvePeerTarget(ctx, workspaces, callerId, String(args.target))
      // Notes are durable (v1.5): the recipient may be offline — the note is
      // queued and delivered when the recipient is live again. The looser
      // authorization still confines recipients to the caller's workspace.
      const decision = await authorizeNoteRecipient(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)
      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const messageId = randomUUID()
      // Wake-on-delivery: a dormant recipient is resumed so the note lands
      // immediately; only a session that cannot be woken falls back to the
      // durable queue.
      const recipient = await wakeSession(ctx, targetId)
      if (recipient !== undefined) {
        const message = buildMessageMessage(callerId, messageId, admitted.content)
        deliverTask(recipient, message, 'followup')
        return { delivered: true, queued: false, messageId }
      }
      // Unwakeable offline recipient: hold durably, bounded per sender.
      const queued = ledger.listPendingNotes()
        .filter(note => note.sender === callerId)
      if (queued.length >= 50) {
        throw new Error('your offline note queue is full (50); wait for deliveries or drop old notes')
      }
      await ledger.queueNote({
        id: messageId,
        sender: callerId,
        recipient: targetId,
        content: admitted.content,
        sentAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        attempts: 0,
      })
      return { delivered: false, queued: true, messageId }
    },
  }))
}
