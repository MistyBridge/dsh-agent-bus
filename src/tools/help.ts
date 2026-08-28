/** Help tools (registered under the output-schema gate). */

import { checkedTool } from './checked-tool.ts'
import { TOOL_DOCS, TOOL_NAMES, type ToolName } from './tool-docs.ts'
import { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID, view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds, assertFlowName, randomTaskId, isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry, ToolsConfig, ToolsDeps, TaskView, TaskDetailView } from './common.ts'

export function registerHelpTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

ctx.tools.register(checkedTool({
    name: 'tool_help',
    description:
      'Return the FULL manual of one agent-bus tool as a tool result. The system '
      + 'prompt carries only a short routing overview; call this before executing '
      + 'a tool whose exact contract you want to confirm — it discloses the '
      + 'complete parameter, semantic, and authorization details of that one tool '
      + 'on demand.',
    parameters: {
      tool: {
        type: 'string',
        required: true,
        enum: [...TOOL_NAMES],
        description: 'The agent-bus tool name to document.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: { type: 'string', required: true },
          doc: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{ type: 'text', text: result.doc }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:工具说明书', kind: 'other', rawInput: { tool: args.tool } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:工具说明书', rawInput: result }),
    async execute(args, exec) {
      requireCaller(exec.agent, 'tool_help')
      const name = String(args.tool) as ToolName
      const doc = TOOL_DOCS[name]
      if (doc === undefined) throw new Error(`no manual for tool "${name}"`)
      return { tool: name, doc }
    },
  }))
}
