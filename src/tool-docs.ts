/**
 * agent-bus 工具说明书的单一事实源（progressive disclosure）。
 *
 * 渐进式披露（与 skill-system 的「catalog 短 + body 按需」同构）：
 * - {@link USAGE_OVERVIEW} 是常驻系统提示的**简短总览**（路由 + header 约定 +
 *   tool_help 指引），替代原先一次性注入的 8.6KB 长文；
 * - {@link TOOL_DOCS} 是 19 个工具的**完整说明书**，仅经 `tool_help({ tool })`
 *   工具在模型需要时披露（工具结果 = model-visible disclosure path）。
 *
 * 内容以 `src/tools.ts` 的 checkedTool 定义、`src/authorize.ts` 鉴权、ledger
 * 状态机为基准校正；对原先 USAGE_TEXT 的漂移（列入了并不存在于 tools.ts 的
 * respond_approval、遗漏了 reassign_task 的详述）已修正。
 *
 * @module dsh-agent-bus/tool-docs
 */

/** agent-bus 工具名全集（与 tools.ts 的 checkedTool 逐一对应）。 */
export const TOOL_NAMES = [
  'list_peers',
  'send_note',
  'create_flow',
  'rename_flow',
  'reassign_task',
  'submit_handoff',
  'list_flows',
  'create_task',
  'edit_task',
  'list_tasks',
  'get_task',
  'report_task',
  'settle_task',
  'cancel_task',
  'request_input',
  'update_card',
  'answer_question',
  'claim_task',
  'create_member',
] as const

/** 每个工具的完整说明书，键为 {@link TOOL_NAMES}。 */
export type ToolName = (typeof TOOL_NAMES)[number]

export const TOOL_DOCS: Record<ToolName, string> = {
  list_peers: `list_peers 列出你工作区里在线的 peer(独立会话,排除你自己、已归档、subagent 后代),供 create_task / send_note 选 target。
- 参数:无。
- 返回:每项 { id, title?, status('running'|'idle'), pendingTasks, description?, capabilities? }。pendingTasks = 该会话未完成任务数(submitted/working/input-required);description/capabilities 来自其能力卡。
- 鉴权:需 caller 在线、且能解析到注册工作区;仅返回同一 workspace 的会话。
- 典型用法:派发前 list_peers 确认谁在线、谁忙碌、谁堆积了未完成工作;按 description/capabilities 路由到合适的人。
- 注意:这是在线快照,不是投递承诺——create_task 仍做权威检查并可能拒绝。`,

  send_note: `send_note(SMALL 通道)发一条轻量消息给 peer:一句确认、一个提问、一次协调 ping。无任务记录、无验收、无待办,对方按需 prose 回复。
- 参数:target(必, peer session id, 源自 list_peers), content(必)。
- 语义:收件人在线则即时投递(header <dsh-agent-bus-message tool="send_note" sender id>),当作普通对话;离线则入 pending_messages 队列,对方上线后补投(补投可能延迟并有多次尝试,超限丢弃)。
- 鉴权:authorizeNoteRecipient——caller 须在线且有 workspace;不能发给自身;recipient 须是 caller workspace 的注册会话(可离线);已归档会话拒绝。
- 限流:messageLimiter(默认每分钟 20 条);content 受 maxContentLength;离线队列每发送方上限 50。
- 典型用法:轻量提问、确认收到、协调下一步。别把真正的工作塞进 send_note——那该用 create_task。
- 注意:send_note 不落台账、无生命周期;收到 <dsh-agent-bus-message> 是聊天,不需要 report/settle。`,

  create_flow: `create_flow(LARGE 容器)建一个流程——多步工作的路线图。先写完整计划(做什么、什么顺序、谁来做、每步"完成"标准),再建 flow,然后把计划拆成 create_task(带 flow_id + dependencies)让 DAG 自动调度。
- 参数:name(必, ≤20 字符, 简明概括任务组核心内容), description(可选, 流程说明 ≤400)。
- 语义:同 flow 内依赖自洽;跨 flow 引用非法(flow_id 约束全部 dependency 同 flow)。任务结算后自动释放其依赖者;失败沿链传播。
- 返回:{ flowId, name, suggestion? }。若 name 不含任何语言的字母(纯数字/符号),给命名建议(决策 8)。
- 鉴权:caller 须在线且在工作区。
- 注意:一个 flow 就是一个 DAG;流程内全部任务结算后该 flow 归档。`,

  rename_flow: `rename_flow 重命名你创建的 flow(可选替换其说明)。
- 参数:flow_id(必), name(必, ≤20 字符, 简明概括任务组核心内容), description(可选——传空串清空、省略保留现状)。
- 语义:新名须在该 workspace 唯一——撞已有 flow 名会被拒,并在报错里列出已有名。
- 鉴权:仅流程创建者(flow.createdBy === callerId);其他会话改不得。
- 典型用法:流程名不再贴切时改名;用 description 补齐/更新流程说明。`,

  reassign_task: `reassign_task 由 initiator 改派一个未结算任务,不重建任务:task id、历史、dependencies、flow 归属、验收标准都保留——只有执行方/验收方变化。
- 参数:task_id(必), new_executor(可选, 新执行方, 来自 list_peers), new_reviewer(可选, 新验收方)。
- 语义:新执行方收到任务重投递(旧执行方若仍在 working 会被中断,其 report 被自动拒收);queued 任务只换 owner,仍等待依赖结算。执行方改为自身时必须有独立 reviewer。
- 鉴权:仅任务派发方(assignedBy)。
- 典型用法:工人掉线/换人/职责变更时改派;比 cancel+create 保留历史。注意别用 reassign 把一个已结算的任务复活——它只适用于未结算任务。`,

  submit_handoff: `submit_handoff 沿 DAG 向下传递结构化上下文:你执行完一个已结算任务后,给每个「后向任务」(在 to_task_id 的 dependencies 里列出 task_id 的那个)交付一份交接文档。
- 参数:task_id(必, 你执行完的任务), to_task_id(必, 下游任务), document(必, 交接内容)。
- 语义:文档挂到 to_task_id 的 handoffs,该任务派发时自动拼进投递内容(「前置任务交接文档」段),下游工人读到链上状态而非考古旧报告。
- 鉴权:仅任务执行方(task.assignedTo === callerId);to_task_id 必须依赖 task_id(仅后向可收);document 受 maxContentLength。
- 注意:可为自身执行(但需另一会话验收);每任务调用一次 submit_handoff。`,

  list_flows: `list_flows 列出你工作区的流程。
- 参数:无。
- 返回:每项 { id, name, description?, taskCount, unsettledCount, archived }。archived = 无未结算任务(且该 flow 有任务)。
- 鉴权:caller 须在线且在工作区;仅返回同 workspace 的 flow。
- 典型用法:查看有哪些流程、各自有多少任务/未结算、是否已归档;配合 create_task(flow_id) 向流程加活。`,

  create_task: `create_task(MEDIUM)建一个任务节点给 live peer:一份必须产生可验收结果的工作。对方逐个执行其被派发的任务(每任务自己一轮),你无需控制节奏。
- 参数:target(必, 执行方, 来自 list_peers), content(必, 任务说明 ≤maxContentLength), title(必, 1–80), mode(可选 'followup'|'steer', 默认 'steer'=优先级通道,先于任何待认领 note;显式 'followup' 则 FIFO 排在已有消息后), reviewer(可选, 验收方, 默认 initiator), task_id(可选——回答对方 request_input 用), dependencies(可选数组, 前置任务 id), acceptance_criteria(可选, 最低验收线 ≤2000), flow_id(可选)。
- 语义:无依赖 → 立刻投递(有依赖且未结算 → 待投递 queued,依赖结算后自动派发)。target 可休眠(wake-on-delivery),否则排队。reviewer 显式指定则独立验收;self-execution(target=caller)必须指定第三方 reviewer。
- 鉴权:authorizePeerOrDormant——caller 在线且在工作区;target 须为同 workspace 会话(可休眠);subagent 不可派发。maxPendingPerAgent 上限超了拒绝。
- 典型用法:派一个可验收的交付物;用 task_id 回答对方的 request_input(任务从 input-required 恢复 working)。
- 注意:超限/依赖/排队都会在返回的 blockedBy/queuePosition 里体现;被拒时按报错调整。`,

  edit_task: `edit_task 编辑你创建、尚未派发的任务:改要求、改 DAG 前置(dependencies)、改验收标准、改标题、移动 flow。
- 参数:task_id(必), content/title/dependencies/acceptance_criteria/flow_id(可选, 省略保留现状;dependencies 传 [] 清空)。
- 语义:DAG 是程序驱动的——流程不合理就在派发前改。编辑后若最后一个依赖已结算,任务立即自动派发。已派发/运行中的任务不能编辑(cancel+重建)。
- 鉴权:仅任务创建者(assignedBy)。
- 注意:移动 flow 时目标 flow 必须已包含该任务的全部依赖(依赖随任务迁移)。`,

  list_tasks: `list_tasks 列台账里的活跃任务。
- 参数:scope(可选 'inbox'|'outbox', 默认 'inbox'), status(可选, 只列该状态)。
- 语义:inbox = 派发给你的任务(按你执行顺序);outbox = 你发起的任务。仅活跃任务可见:failed/canceled/rejected 立即离开列表;completed 待验收仍活跃(含报告文本);settled success 超过 24h 归档。历史在面板与日志。
- 鉴权:基于 caller 自身的 inbox/outbox,无需他人授权。
- 注意:completed 待验收任务带报告,读它再 settle。`,

  get_task: `get_task 读一个任务的完整记录(不受 list_tasks 截断)。
- 参数:task_id(必)。
- 语义:完整返回 content/report/acceptanceCriteria/handoffs/question/outcome/feedback/reason/reviewer/createdAt/updatedAt;reportRef 外部化报告会读回全文。
- 鉴权:authorizeTaskRead——活动任务(queued/submitted/working/input-required/auth-required)仅参与者可读(assignedBy/assignedTo/assignedReviewer),非参与者收到「该任务与你无关」且无内容;completed/终结任务是历史,公开可读。
- 典型用法:验收前读完整报告;审计历史任务。`,

  report_task: `report_task 是执行方的收尾:working 任务 → completed,并通知验收方来 settle。
- 参数:task_id(必), result(必, 结果/摘要)。
- 语义:completed 后 reviewer(显式 assignedReviewer 否则 initiator)收到待验收提醒。若任务已被 cancel,report_task 改为把你的摘要附着到 canceled 任务(不转 completed)。长报告(maxInlineReport)外部化。
- 鉴权:仅任务执行方(task.assignedTo === callerId)。
- 典型用法:工作做完调用 report_task 提交结果,进入待验收。
- 注意:别在没做完时 report;若收到的是 cancel,report 只是交摘要。`,

  settle_task: `settle_task 是验收方的裁决:success 接受任务(终态),failure 把同一任务送回执行方返工(任务 id 不变;worker 被通知,失败时 feedback 是返工指令)。
- 参数:task_id(必), outcome(必, 'success'|'failure'), feedback(可选——failure 时必须的返工指令;success 可选留痕)。
- 语义:success → 终态 + DAG 释放依赖者(其依赖结算后自动派发)+ 通知 initiator(及有下游时的 executor 提交交接文档);failure → 任务回 submitted,worker 重新执行。终局(flow 最后任务)给创建者汇总。
- 鉴权:authorizeSettlement——仅任务 reviewer(显式 assignedReviewer,否则 initiator);非 review 者拒。你不该验收自己的活。
- 注意:及时 settle 已完成的待验收任务,别卡住 worker;failure 务必给明确的修改意见。`,

  cancel_task: `cancel_task 由任务方取消一个尚未完成的任务(queued/submitted/working/input-required)。
- 参数:task_id(必), reason(可选, ≤400)。
- 语义:worker 被中断,并收到请求(用 report_task 附上已完成部分的摘要);queued 任务未投递,静默取消;取消后任务为终态。
- 鉴权:authorizeSettlement——仅任务 reviewer(显式 assignedReviewer,否则 initiator);worker 不能取消自己的任务。
- 典型用法:任务方向错了、对方不响应、不再需要该交付物时取消。
- 注意:已 completed/失败终态的任务不能 cancel。`,

  request_input: `request_input 在执行任务中途暂停,因为你需要只有任务发起方才知道的信息。
- 参数:task_id(必), question(必, 你要问的)。
- 语义:任务 working → input-required,记录问题;发起方经 create_task(task_id=...) 回答;你认领该回答后任务回到 working。
- 鉴权:仅任务执行方(task.assignedTo === callerId)。
- 典型用法:缺关键输入、需要发起方拍板、有歧义要澄清。比瞎猜好。
- 注意:问题要具体,一回合答完;别频繁请求输入(会进入 input-required,挂着等)。`,

  update_card: `update_card 维护你自己的能力卡(供 list_peers 路由)。
- 参数:description(可选, ≤200 字符), capabilities(可选数组, 每项 {id,label})。
- 语义:id 须小写 kebab-case(≤32 字符), label 1–50 字符, 最多 8 项, 去重;整体替换卡片。
- 鉴权:caller 在线即可。
- 注意:诚实、窄化——peers 按你宣称的能力路由;别虚报。`,

  answer_question: `answer_question 回答 worker 在执行你的任务时经 ask_user_question 提出的结构化问题。
- 参数:task_id(必, input-required 任务的 id), answers(必, 每项 {id, selected, custom?})。
- 语义:每个 pending question 给一项:id(来自转发的问题 id)、selected(所选选项 label, 单选/多选按声明)、custom(可选自由文本)。回答后任务回到 working,worker 收到答案。
- 鉴权:仅任务发起方(assignedBy);worker/第三方越权被拒;任务须确实 input-required 且有 pending question。
- 典型用法:worker 卡在需要你决策的岔路;给明确选项或自定义回答。
- 注意:答案要落在声明的选项里(多选/单选校验);超时未答任务会超时兜底。`,

  claim_task: `claim_task 让你把被指派(submitted)的任务拉回 working。
- 参数:task_id(必)。
- 语义:submitted → working。通常在「重投递到达但上次投递丢失(步骤被拒/重启)」时用:claim 后你就能 report。已是 working 时 is idempent no-op(返回当前状态)。
- 鉴权:仅任务执行方(authorizeClaim: assignedTo === callerId);非执行方拒。initiator 不能用 claim 抢回其派发的任务(那是 reassign)。
- 注意:只有 submitted(或 working)可 claim;其他状态报错。`,

  create_member: `create_member 一键入职:为工作区创建一位正式成员。
- 参数:workspace(必, 路径或 id), name(必, 会名), role(可选, 注入为 system-prompt section 的角色说明), skills(可选, 运行时 skill 定义数组 {name,description,content}), permissions(可选, preset 名 或 {sandbox, approval} 旋钮), flow(可选, 加入的 flow), description(可选, 能力卡 ≤200), modules(可选, 预留扩展点)。
- 语义:创建会话(绑 workspace)→ 重命名 → 注入 role(section)→ 挂载 skills → 配置 permissions(preset 或显式旋钮)→ 可选加入 flow → 写能力卡。baseline 组合 = deployment 默认 agent preset(存在时)。mcp/modules 本期接收但跳过(仅告警,不报错)。任一步失败回滚已建部分,不留半成品。
- 鉴权:caller 须在线且在工作区。
- 典型用法:扩编团队、给新人一次性配好角色/权限/技能/卡片。
- 注意:只用于真实成员,别用它创建一次性探路会话;permissions 旋钮需在沙箱/审批允许范围内。`,
}

/** 常驻系统提示的简短总览(替代原先一次性注入的长文)。 */
export const USAGE_OVERVIEW = `You share a workspace with other agent sessions and can dispatch work to them.

ROUTE BY SCOPE — pick the channel that matches how big the ask is:
- SMALL (a message, a question, a confirmation, a one-line coordination ping): send_note. No record, no lifecycle, no acceptance — the peer just answers in prose.
- MEDIUM (one deliverable the peer must produce and you will verify): create_task. Full lifecycle: report → settle → rework/cancel, with timeout backstop.
- LARGE (a multi-step effort that needs planning and ordering): create_flow. FIRST write out the full plan (what must happen, in what order, by whom), THEN create the flow, then split the plan into tasks created with flow_id and dependencies so the DAG auto-schedules: each task delivers only after its predecessors settle, and a failure propagates down the chain automatically. The flow is your roadmap; the DAG view renders it.
Never use a heavier channel than the ask needs, and never a lighter one: chat-as-task is how tasks get stuck forever in working; task-as-chat loses the lifecycle that keeps work accountable.

Incoming agent-bus messages open with a header naming the request kind, so read it first:
- <dsh-agent-bus task="…" tool="create_task" sender="…"> — a task to work; do it and call report_task with that task id.
- <dsh-agent-bus task="…" tool="scheduler" sender="…"> — an auto-dispatched task (its dependencies settled); work it like any task.
- <dsh-agent-bus task="…" tool="report_task" …> — a result you review is waiting; settle it promptly.
- <dsh-agent-bus task="…" tool="settle_task" …> — on failure, rework the same task and report again; on success, the task is done.
- <dsh-agent-bus task="…" tool="cancel_task" …> — your task was canceled; report a summary of what you had done.
- <dsh-agent-bus task="…" tool="reminder|timeout" …> — a system notice; it needs no separate action, only your report if you still owe one.
- <dsh-agent-bus-message tool="send_note" sender="…" id="…"> — a chat note, not a task; reply in prose if you wish, nothing to report or settle.
Only the reviewer can settle and only the initiator can cancel, so never mark your own work complete.

Delivery reaches live sessions only. A refusal from create_task is authoritative: the peer is not reachable, not in your workspace, or its queue is full.

TOOLS (call tool_help({ tool }) for the full manual of any one):
${TOOL_NAMES.join(', ')}`
