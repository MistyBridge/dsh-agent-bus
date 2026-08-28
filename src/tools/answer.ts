/** Answer tools (registered under the output-schema gate). */

import { checkedTool } from './checked-tool.ts'
import { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID, view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds, assertFlowName, randomTaskId, isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry, ToolsConfig, ToolsDeps, TaskView, TaskDetailView } from './common.ts'

export function registerAnswerTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

ctx.tools.register(checkedTool({
    name: 'answer_question',
    description:
      'Answer a structured question the worker asked via the dsh ask_user_question tool while executing '
      + 'YOUR task: the task paused as input-required and the question (with its options) was forwarded to '
      + 'you. Provide one answer item per pending question — the question id, the selected option label(s), '
      + 'and optional custom text. Only the task initiator (the session that dispatched the task) may answer.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The input-required task id carrying the worker\'s pending questions.' },
      answers: {
        type: 'array',
        required: true,
        description: 'One answer per pending question, each with the question id, selected option label(s), and optional custom text.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'The pending question id (echoed from the forwarded question).' },
            selected: { type: 'array', required: true, items: { type: 'string' }, description: 'Selected option label(s).' },
            custom: { type: 'string', description: 'Optional free-text answer.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          answered: { type: 'number', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} answered ${result.answered} question(s); status ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:回答问题', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:回答问题', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'answer_question')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedBy !== callerId) throw new Error('仅任务发起方可回答')
      if (task.status !== 'input-required' || task.pendingQuestions === undefined || task.pendingQuestions.length === 0) {
        throw new Error(`task "${taskId}" has no pending question to answer`)
      }
      const normalized = normalizeQuestionAnswers(args.answers, task.pendingQuestions)
      const resolved = deps.questions.resolve(taskId, { answers: normalized })
      if (!resolved) {
        throw new Error(`task "${taskId}" question is no longer pending (it may have timed out)`)
      }
      const resumed = await ledger.transition(taskId, 'working', { pendingQuestions: undefined, question: undefined })
      if (!resumed.ok) throw new Error(resumed.message)
      return { taskId: String(taskId), status: resumed.task.status, answered: normalized.length }
    },
  }))
}
