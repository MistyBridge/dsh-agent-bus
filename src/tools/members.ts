/** Members tools (registered under the output-schema gate). */

import { checkedTool } from './checked-tool.ts'
import { TaskId, authorizeClaim, authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, authorizeTaskRead, resolveWorkspacePath, admitContent, buildMessageMessage, buildTaskMessage, deliverTask, notifySession, blockedByOf, isTokenBuckets, staffRoles, fallbackTitle, readTitlesFile, normalizeQuestionAnswers, DispatchRateLimiter, dispatchOne, wakeSession, onboardMember, parseCreateMemberInput, setMemberRole, parseReconfigureMemberInput, reconfigureMember, assertNever, APPROVAL_POLICIES, SANDBOX_MODES, dshHomePath, randomUUID, view, isSettledTask, detailView, requireCaller, resolvePeerTarget, snapshotTokensAtDispatch, peerTitleOf, subagentSessionIds, assertFlowName, randomTaskId, isActiveTask, renderTaskRow, canReadTask, renderTaskDetail, type DeliveryMode, TaskRecord, TokenBuckets, TaskStatus, TaskOutcome, Capability, PeerCard, FlowRecord, HandoffEntry, PendingQuestion, QuestionAnswer, QuestionAnswerItem, BatchRecord, Denial, PeerGrant, PeerDecision, NoteGrant, NoteDecision, DenialReason, ContentDecision, DeliverySource, NoticeSegment, TaskLedger, NewTask, LedgerResult, FlowResult, QuestionRegistry, PendingAsk, QuestionBridgeConfig, CreateMemberHost, PermissionPresetHost, PresetMountHost, OnboardPlan, OnboardResult, SkillSpec, WorkspaceLike, CreateMemberInput, ParseResult, ReconfigureMemberHost, ReconfigurePlan, ReconfigureResult, ReconfigureInput, ReconfigureParseResult, ReportStore, Context, Agent, Session, SessionId, WorkspaceRegistry, ToolsConfig, ToolsDeps, TaskView, TaskDetailView } from './common.ts'

export function registerMembersTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps
  const permissionPresets = typeof ctx.get === 'function'
    ? ctx.get('permissionPresets') as PermissionPresetHost | undefined
    : undefined
  const permissionPresetNamesHint = permissionPresets !== undefined && permissionPresets.names.length > 0
    ? permissionPresets.names.join(', ')
    : 'workspace-write, danger-full-access'

ctx.tools.register(checkedTool({
    name: 'create_member',
    description:
      'One-click onboarding: create a full team member bound to a workspace. Required: '
      + 'name (session title). workspace (path or id) is optional and defaults to the caller\'s '
      + 'current workspace when omitted. Optional: role (persona prose injected '
      + 'as a system-prompt section), skills (runtime skill definitions mounted in the member\'s '
      + 'scope), permissions (preset name, or {sandbox, approval} knobs), flow (flow id or name '
      + 'to join), and description (capability-card text, at most 200 characters). The member '
      + 'receives the deployment\'s default agent preset as its baseline composition when one '
      + 'exists. mcp and modules are accepted but not implemented this phase (mcp needs '
      + 'preset-file authoring; modules is a reserved extension point) — both surface as '
      + 'warnings, never errors. Any step failure rolls back the created session; no '
      + 'half-baked member survives. Use for real team members only — a member is a named '
      + 'session with its own skills, permissions, and card.',
    parameters: {
      workspace: { type: 'string', description: 'Workspace path or id the new member is bound to; omit to use the caller\'s current workspace.' },
      name: { type: 'string', required: true, description: 'Session name (title), 1–20 chars; whitespace-padded values are trimmed.' },
      role: { type: 'string', description: 'Role/persona prose injected as a system-prompt section.' },
      skills: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Kebab-case skill identifier.' },
            description: { type: 'string', description: 'Short routing description; omit to reference an existing skill by name.' },
            content: { type: 'string', description: 'Markdown instruction body; omit to reference an existing skill by name.' },
          },
        },
        description: 'Runtime skill definitions mounted into the member\'s scope: inline {name, description, content}, or {name} only to reference an already-discovered skill (its body is resolved at onboarding).',
      },
      mcp: { type: 'object', additionalProperties: true, description: 'MCP configuration; not injectable programmatically this phase, skipped with a warning.' },
      permissions: {
        oneOf: [
          {
            type: 'string',
            description:
              'Permission preset name. One of: ' + permissionPresetNamesHint
              + '. An unknown preset name is refused.',
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              sandbox: { type: 'string', enum: [...SANDBOX_MODES], required: true, description: `Sandbox mode; one of ${SANDBOX_MODES.join('|')}.` },
              approval: { type: 'string', enum: [...APPROVAL_POLICIES], required: true, description: `Approval policy; one of ${APPROVAL_POLICIES.join('|')}.` },
            },
          },
        ],
        description:
          'Preset name, or explicit {sandbox, approval} knobs (sandbox ∈ ['
          + SANDBOX_MODES.join(', ') + '], approval ∈ [' + APPROVAL_POLICIES.join(', ')
          + ']); omitted keeps the workspace default.',
      },
      flow: { type: 'string', description: 'Flow id or name to join, resolved within the target workspace.' },
      description: { type: 'string', description: 'Capability-card description (at most 200 characters).' },
      modules: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Reserved extension point; ignored this phase.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          workspaceId: { type: 'string', required: true },
          workspacePath: { type: 'string', required: true },
          steps: { type: 'array', items: { type: 'string' }, required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          flow: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `member ${result.name} onboarded (${result.sessionId.slice(0, 8)}…; steps: ${result.steps.join(' → ')}; workspace: ${result.workspacePath})`
          + (result.flow !== undefined ? `; joined flow "${result.flow.name}"` : '')
          + (result.warnings.length > 0 ? `; warnings: ${result.warnings.join('; ')}` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建成员', kind: 'other', rawInput: { name: args.name, ...(args.workspace !== undefined ? { workspace: args.workspace } : {}), ...(args.role !== undefined ? { role: args.role } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_member')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('create_member: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace === undefined) {
        throw new Error('create_member: the calling session is not inside a registered workspace')
      }
      const parsed = parseCreateMemberInput(args, callerWorkspace)
      if (!parsed.ok) throw new Error(parsed.error)
      const host: CreateMemberHost = {
        workspaceRegistry: workspaces,
        agents: ctx.agents,
        sessionTitle: ctx.sessionTitle,
        permissionPresets: ctx.get('permissionPresets') as PermissionPresetHost | undefined,
        agentPresets: ctx.get('agentPresets') as PresetMountHost | undefined,
        skills: ctx.get('skills') as {
          get(name: string): Promise<{ description: string; content: string } | undefined>
        } | undefined,
        ledger,
      }
      // The new agent renders `{{model}}` from options.model and the request
      // build needs a provider route; default both from the caller so the
      // member session can assemble its persona and resolve the model adapter.
      const callerRoute = (caller as { options?: { provider?: string; model?: string } }).options
      const routeForMember = callerRoute !== undefined
        && (callerRoute.provider !== undefined || callerRoute.model !== undefined)
        ? {
            ...parsed.plan,
            ...(callerRoute.provider !== undefined ? { provider: callerRoute.provider } : {}),
            ...(callerRoute.model !== undefined ? { model: callerRoute.model } : {}),
          }
        : parsed.plan
      const result = await onboardMember(host, routeForMember)
      // The output schema infers mutable string arrays; copy the readonly
      // result fields so the return is assignable under any inference variant.
      return { ...result, steps: [...result.steps], warnings: [...result.warnings] }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'reconfigure_member',
    description:
      'Reconfigure an existing member (a peer in your workspace) without rebuilding the session: '
      + 'replace its role and/or its permissions in place. member_id is the member session id from '
      + 'list_peers. role is the persona-style prose injected as the member\'s system-prompt section; '
      + 'permissions is a preset name or an explicit {sandbox, approval} knob pair, exactly as in '
      + 'create_member. The change takes effect on the member\'s next turn (a dormant member is '
      + 'woken first, then configured). Skill reconfiguration is not supported yet — cancel and '
      + 'recreate the member to change skills. Use this instead of cancel/recreate when you built the '
      + 'wrong role or permissions.',
    parameters: {
      member_id: { type: 'string', required: true, description: 'The member session id (peer id from list_peers) to reconfigure.' },
      role: { type: 'string', description: 'Replacement role/persona prose injected as a system-prompt section; takes effect on the member\'s next turn.' },
      permissions: {
        oneOf: [
          {
            type: 'string',
            description:
              'Permission preset name. One of: ' + permissionPresetNamesHint
              + '. An unknown preset name is refused.',
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              sandbox: { type: 'string', enum: [...SANDBOX_MODES], required: true, description: `Sandbox mode; one of ${SANDBOX_MODES.join('|')}.` },
              approval: { type: 'string', enum: [...APPROVAL_POLICIES], required: true, description: `Approval policy; one of ${APPROVAL_POLICIES.join('|')}.` },
            },
          },
        ],
        description:
          'Preset name, or explicit {sandbox, approval} knobs (sandbox ∈ ['
          + SANDBOX_MODES.join(', ') + '], approval ∈ [' + APPROVAL_POLICIES.join(', ')
          + ']); omitted keeps the current permission pin.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberId: { type: 'string', required: true },
          steps: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `member ${result.memberId.slice(0, 8)} reconfigured (${result.steps.join(' → ')})`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:改配成员', kind: 'other', rawInput: { member_id: args.member_id, ...(args.role !== undefined ? { role: args.role } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:改配成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'reconfigure_member')
      const memberId = String(args.member_id) as SessionId
      // A member's role/permissions are set by a peer, never by itself: a
      // worker could otherwise grant itself danger-full-access. The target must
      // still be a real same-workspace peer (live or dormant) to reach here.
      if (memberId === callerId) {
        throw new Error('reconfigure_member: cannot reconfigure the calling session itself')
      }
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('reconfigure_member: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace === undefined) {
        throw new Error('reconfigure_member: the calling session is not inside a registered workspace')
      }
      const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, memberId)
      if (!decision.ok) throw new Error(decision.message)
      const parsed = parseReconfigureMemberInput(args)
      if (!parsed.ok) throw new Error(parsed.error)
      const host: ReconfigureMemberHost = {
        agents: {
          get: id => ctx.agents.get(id),
          resume: async id => wakeSession(ctx, id),
        },
        permissionPresets: ctx.get('permissionPresets') as PermissionPresetHost | undefined,
        setRole: (member, text) => setMemberRole(String(member.id), member.ctx, text),
      }
      const result = await reconfigureMember(host, parsed.plan)
      // The output schema infers mutable string arrays; copy the readonly
      // result fields so the return is assignable under any inference variant.
      return { ...result, steps: [...result.steps] }
    },
  }))

ctx.tools.register(checkedTool({
    name: 'archive_member',
    description:
      'Archive one member session (a peer in your workspace). Archiving is a visibility and '
      + 'recognition choice: an archived member is hidden from list_peers and is no longer a '
      + 'deliverable target, so it stops being a peer. The change is one-way (the harness session '
      + 'archive set is append-only — no unarchive path), so only archive sessions you no longer '
      + 'want to recognize as peers. It only affects workspace recognition; the session\'s own log is '
      + 'untouched.',
    parameters: {
      member_id: { type: 'string', required: true, description: 'The member session id (peer id from list_peers) to archive.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberId: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `成员 ${result.memberId} 已归档`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:归档成员', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:归档成员', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'archive_member')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('archive_member: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (callerWorkspace === undefined) {
        throw new Error('archive_member: the calling session is not inside a registered workspace')
      }
      // The member must belong to the caller's workspace account: only a real
      // same-workspace session can be hidden from these peers (so a caller
      // cannot archive an unrelated/other-workspace session).
      const memberId = String(args.member_id)
      const inWorkspace = workspaces.list().some(workspace =>
        workspace.path === callerWorkspace
        && workspace.sessionIds.some(id => String(id) === memberId))
      if (!inWorkspace) {
        throw new Error(`archive_member: session "${memberId}" is not a session of your workspace`)
      }
      await workspaces.archiveSession(memberId as SessionId)
      return { memberId, archived: true }
    },
  }))
}
