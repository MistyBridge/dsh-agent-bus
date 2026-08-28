# dsh-agent-bus 设计笔记

> 记录决策与移植取舍。本文档是活文档:改动设计时同步更新。
> 基线:dsh 0.1.0-rc.5 · 2026-08-17

## 已定决策

1. **双平面**:投递用 dsh 原生 Inbox(`next-turn` FIFO,一条一 turn,空闲取下一项,item 间有持久化检查点);台账自建,记录意图与结果。台账**不镜像** Inbox——两者按设计漂移(Inbox 是执行权威)。参见 dsh `.agents/notes/implemented/architecture/2026-07-30-followup-enqueue-and-owned-runs.md`。
2. **状态机四段 + 细分**:待分配 → 待执行 → 执行中 → 已提交 → 完成归档(success/failure)。失败处理与测试环节在台账状态机内,不在节点状态。判定权 = `task.assignedBy === caller`(涌现角色,无 role 字段)。
3. **工具面 4 个**,无 Router Mode。教训源:CC_BOOS 73 工具被迫做 router 稳定 prompt-cache;要吸取的不是「也做 router」而是「别走到那一步」。
4. **不扩 SessionEventMap**。`known-event-types.ts` 由仓库根 glob 生成,仓库外插件构造上进不去;`ignorable: true` 契约限定「丢失不影响重建」。所有需存活状态落 storage domain。
5. **`inject` 声明 `storageDomain` + `workspaceRegistry`**。前者是 provided 值非 Service——`ctx.get()` 查不到,`inject` 能解析(workspace 包同法)。缺失则加载即失败(misconfiguration fails loud),不做静默降级。
6. **内容消毒**:ANSI CSI / ESC 对 / C0(留 `\t\n\r`)/ C1 剥离 + 长度上限。超限拒绝不截断。
7. **深度上限 + 速率限制**:dsh Inbox 无深度上限(`append()` 只查 id 重复),台账在 `record()` 前数未完成行;派发按发送者 60s 滑动窗口限流。两者皆 Config 字段。

## 刻意不移植(自 CC_BOOS)

| 模块 | 行数(约) | 不移植原因 |
|---|---|---|
| `ptyInjectionQueue.js` + `notificationsWake.js` | 764 | 其四层防护(idle 门/安静窗/burst/自愈重注入)存在的唯一理由是 Claude Code 无程序化收件箱,唤醒要敲 `check_inbox[BOOS]` 进终端。dsh `followup()` 原生把消息变成 turn。 |
| `transport.js` SSE 会话管理 | ~600 | 同上,服务于 PTY 双通道唤醒与断线回放。 |
| `inboxStore.js` | 375 | per-uid 文件锁/TOCTOU 修复/写后验证——dsh 的 `Session.append` 是唯一写路径,域写入走域自身写链。 |
| `routerMode.js` | 79 | 工具面 4 个不需要。 |
| DAG(15 工具)+ Goal(7)+ 评审提案(9) | ~3500 | 上层编排,不是消息网关;v2 议题,`dependsOn` 字段已预留(无需迁移)。 |
| 文件锁 3 + 知识库 2 + 约束 2 | — | 另一能力。 |
| PMO 角色 | — | CC_BOOS 里本就是个半成品(schema enum 无 pmo,registry 却接受),且用户决策去掉。 |
| 离线 mailbox | — | dsh 已明确否决(`2026-07-30-continuable-subagent-report-tool.md:89`);需要正式的 proposed note supersede 才能做。 |

## 移植时发现的 CC_BOOS 缺陷(我们避免重犯)

- `auth.requireSameWorkspace` 导出但从未被调用,工作区检查每处手写 → `dag_status` 等三个工具完全无门。我们的可达性判定只有 `authorize.ts` 一个函数。
- `message_type=response` 路径存在但 schema 里没有该字段,调用方不可发现。我们的工具 schema 与实现一一对应。
- 若干工具描述与实施不符(以代码为准的教训)。

## 未做(排队)

- 执行中超时扫查:被认领后 step 被拒的消息既不触发 `discarded` 也不执行(`agent/inbox/claimed` JSDoc 明示),台账会永久停在执行中。需定时扫查 + 超时转 failed。
- 可视化面板(Web UI):`domain/changed` 仅进程内;client bundle 需复刻 `tsdown.client.ts` 协议(参考 dsh-agent-teams 的复刻)。
- 离线投递 / DAG:见上。

## 冷热分区报告存储(2026-08-18 已实现)

- **用户要求**:自己规划冷热数据分区,划分归档区。
- **设计**:`~/.dsh/agent-bus/cache/`(热区,活跃任务报告,7 天未访问清理)+ `archive/`(冷区,终态任务报告,30 天未访问清理)。
- **流转**:报告 > `maxInlineReport`(默认 400)外置热区,台账存截断摘要 + `reportRef`(= taskId,永不暴露路径);settle/cancel/超时扫查使任务进入终态时报告**移动**热→冷(reference 不变,台账无需更新);`get_task` 先热后冷读回全文,模型无感知。
- **评估结论**:dsh 的 spill seam 不契合——它面向工具结果一次性溢出(模型拿 locator 自己 read),无任务级寻址与清理;自建 ReportStore(两区 + sweep)。
- 单测 5 项(含两区 sweep)+ 冷热 e2e ALL PASS;domain v4。

## UI 折叠渲染(2026-08-18 已实现)

- **用户要求**:状态机全部工具调用不在前端显式显示为「Tool call: xxx」行,而是像「上下文注入」一样折叠(标题 `agent-bus-task`,参数收在折叠栏内)。
- **关键调查结论**:前端 `toolRowModel`(ui-tool/tool-call-model.ts)**不消费 `presentCall` 的 callView**——「Tool call: 工具名」是静态组合。正确通道是 keyed `tool.call.toolview` slot:按工具名注册即**整体替换**通用工具行(ui-tool/apply.ts 注释明示)。
- **实现**:
  - 服务端:9 工具全部加 `presentCall`/`presentResult`(generic 卡片,title 语义化,rawInput 只放关键参数)。
  - client 半边:`src/client/` 入口注册 9 个 keyed toolview + `AgentBusToolRow`(复用 `DisclosureRow`,一行「agent-bus-task」+ 动作摘要,展开显示完整参数 JSON)。
  - 构建:双 tsconfig(host exclude src/client)+ tsdown 闭包 bundle(lib/client.js 4.25kB,externals = PLATFORM_MODULES 冻结表 + 纯度门),`dsh.client` 声明 + `exports["./client"]`。
- **验证**:`/plugins/dsh-agent-bus/client.js` 200;新工具调用全部渲染为折叠行,零 console 错误。

## 已实现

**2026-08-23(A2A vs user↔A 判定改为注入上下文)**
- `currentTurnTaskMessage(session)`(question-bridge.ts):从 `session.events` 尾部取最近 turn 边界——尾随 `turn/end` 则无 open turn,尾随 `turn/start` 则 open,取其内**首个** `user/message`(避开 `agent.inject()` 追加的上下文 source)。
- `tools/execute` 监听器把 `ledger.findWorkingFor(caller.id)` 替换为组合判定:currentTurnTaskMessage → undefined 则 `next()`;source.kind ≠ `agent-bus-task` 则 `next()`;`findByMessage(msg.id)` 未命中(通知消息)则 `next()`;`task.assignedTo !== caller.id` 则 `next()`;命中才作 A2A(用 `task.assignedBy` 转发)。`findWorkingFor` 语义保留在 ledger(文档写明)但不再驱动桥接——判定改为「当前 open turn 是不是任务上下文」,能区分「正在执行任务」vs「只是有任务记录但当前 turn 是闲聊」。
- 测试:question-bridge.spec.ts 全部 A2A/user↔A 断言改为真实 `session.events` 驱动;补齐边界:无 open turn、首个 user/message 是人类提示/注入上下文(plugin)、turn 已关闭、通知消息同 source.kind 但无 ledger 行、任务 assignedTo 非调用者。

**2026-08-28(易用性 4.4:成员改配 reconfigure_member)**
- 痛点:成员建错角色/权限,没有一键改配,只能 cancel/recreate;`reassign_task` 只适用于任务,不适用于成员本人配置。新增 `reconfigure_member(member_id, role?, permissions?)` 让 PM 原地改配已建成员。
- 复用:权限语法与写路径抽到 `src/member-config.ts`(`parsePermissions` / `applyPermissions`),create_member 与 reconfigure_member 共用同一 grammar(preset 名或 {sandbox, approval} 旋钮)与同一写路径(permissionPresets.set / setSandboxMode / setApprovalPolicy,均为 durable 会话日志事件,重启后仍生效);角色同为 `systemPrompt.section`(MEMBER_ROLE_SECTION, order = PERSONA_ORDER+1)。
- 角色替换不撞名:`systemPrompt.section` 同一 scope layer 内重名会抛,故 `setMemberRole(sessionId, agentCtx, text)` 维护进程内 disposer 注册表——先 dispose 旧 section 再注册新 text;create_member 的 buildSetup 在注册时把 disposer 按 sessionId 记住,reconfigure 据此替换。dormant 成员经 wakeSession 唤醒后其 agent scope 无旧 section,直接注册。
- 行为:dormant 成员先唤醒再改配(改配后该成员后续 turn/下次加载按新配置生效);不可唤醒/非工作区/已归档/订阅者(subagent)拒绝;禁止改配调用方自身(防止成员自提权)。skills 改配本期明确不支持(技能注册为每层 first-wins,重注册不替换),parser 拒之并说明原因。
- 测试:reconfigure-member.spec.ts 23 例(解析/角色替换/权限映射/preset 名/dormant 唤醒/不可唤醒拒绝/无改项拒绝/systemPrompt 与 permissionPresets 缺失拒绝);tools-schema 补 maximalValueOf 与参数面;tools-render 补工具面行为(角色路径、非 peer/已归档/自身/不可唤醒/无改项/无 systemPrompt 拒绝)。

**2026-08-23(决策 8:流程命名管理)**
- create_flow 同工作区重名拒绝:检查放在 ledger.createFlow 的 enqueue 内(串行写入链,并发安全),报错含「该工作区已有同名流程『xxx』」并列出已有流程名。
- 无意义名(纯数字/纯符号,无任何字母字符)放行但返回 `suggestion` 字段:「建议格式:目标 + 阶段,如『电商站上线:Phase 1 基建』」(create_flow output schema 增加可选 suggestion)。
- `rename_flow(flow_id, name, description?)` 工具(checkedTool):仅创建者(createdBy)可改,他人报错「仅流程创建者可改名」;重名拒绝同上(ledger.renameFlow,新 FlowResult 返回类型);description 传值替换、空串清除、缺省保留。
- DAG 侧栏流程项显示 name + description(单行截断,悬停 title 全文)+ 任务数;archived 项补 taskCount 徽标。FlowView 的 description 投影(panel.ts / panel-model.ts)本已存在,仅渲染层补齐。

**2026-08-23(决策 4:严格鉴权——非终态任务仅任务相关者可访问)**
- `authorize.ts` 新增 `isTaskParty`(assignedBy/assignedTo/assignedReviewer 三角色)与 `authorizeTaskRead`(DenialReason 新增 `not-task-party`):live 任务(queued/submitted/working/input-required/auth-required)仅相关者可读;completed 与终态(failed/canceled/rejected,即立即归档集合)为历史、公开可读;非相关者报错「该任务与你无关」。
- `tools.ts` 的 `canReadTask` 收紧为同一规则(签名去掉 callerWorkspace——工作区成员身份不再授予读权),`get_task` 改用 `authorizeTaskRead`;list_tasks 本就按 assignedTo(收件箱)/assignedBy(发件箱)过滤、天然相关者限定,无需改动;其余操作类工具(report/settle/cancel/request_input/claim/edit/reassign/handoff/answer)均已按对应角色鉴权,无泄露路径。

**2026-08-23(决策 2:claim_task 主动领取 + 心跳重投活跃态冷却)**
- `claim_task(taskId)` 工具:执行方(assignedTo)可把 submitted 任务领回 working(复用 ledger 既有转移 submitted→working);鉴权走 `authorizeClaim`(非执行方报错「该任务不属于你」);已 working 且本人领取为幂等 no-op;非 submitted/working 状态报错。ToolsDeps 新增 `noteActivity` 记录执行者活跃信号。
- 心跳重投冷却绑定执行者活跃态:index.ts 维护 `sessionId → 最后活动时间` 映射,在 turn/end、agent/inbox/claimed、claim_task/report_task/request_input 时刷新;心跳重投前用 `shouldHeartbeatRedeliver`(scheduler.ts 纯函数)判定——执行者在 `heartbeatCooldownMs`(新配置,缺省 = retryIdleMs)内有活动则不重投,封死「重投刷新 updatedAt → 又触发重投」的 T5 循环。

**2026-08-23(决策 1:工具输出 schema 自动检查)**
- `checkedTool` 包装器(`src/checked-tool.ts`)包住全部工具的 `defineTool`:`execute` 返回先用 harness 同一把尺子 `validateJsonSchemaValue` 校验,不一致即抛 `ToolOutputMismatchError`——消息含字段名(缺失/多余/类型不符)、返回面与说明书的最小差异、修复方向(新增字段附建议声明,如 `title: { "type": "string" }`),并提示「工具返回面与说明书不一致」。schema 漂移从「harness 裸拒绝、不可读」变成工具内可读报错,不再静默失效。

**2026-08-17(端到端验证)**
- 事件驱动迁移:`agent/inbox/claimed` / `agent/inbox/discarded` → 台账转移。无标签的根上下文监听器被 scope 过滤器全局准入(`scopeTarget` 的 `tag === undefined → return true`),无需 per-agent 注册。
- 投递竞态修复:`followup()` 对空闲接收者同 tick 认领,先写 messageId 再投递(delivery.ts 拆分 build/deliver)。
- 输出校验修复:工具返回对象省略 undefined 键(dsh 拒绝非 lossless JSON)。
- cwd 失效容忍:resolveWorkspacePath 捕获 ENOENT,视为无工作区。

**2026-08-18(A2A 对齐重写,`docs/a2a-alignment.md` 为确认版设计)**
- 状态机:八个 A2A TaskState 原词(submitted/working/input-required/auth-required/completed/failed/canceled/rejected),零自造状态;扩展语义压字段(reason/question/outcome/supersedes)。判定不改状态,重做 = 新任务(supersedes),无自动重投。
- 工具面 9 个:A2A 操作名(send_message/list_tasks/get_task/cancel_task)+ 拆分 report_task/settle_task + 新增 request_input/update_card/list_peers。
- Agent Card:description(模型)+ capabilities(机器,规范化 kebab-case id ≤8 项),domain peers 表,自维护覆盖式。
- 超时扫查:taskTimeoutMs 默认 2h,working→failed(timeout)、input-required→failed(no-response)。
- cancel 流程:取消→打断→要求摘要(report_task 对 canceled 只追加字段)。
- 修两个上线时被 dsh 拒绝的 schema 问题:参数 DSL 不支持 `maxItems`;工具返回含未声明字段(updatedAt)被 additionalProperties:false 拒绝——返回面必须精确等于输出 schema。
- **提交通知回环(用户指出的断链)**:report_task 置 completed 后对验收方 followup 唤醒,附任务 id + 200 字摘要;验收方自主 settle。防环:settle 是工具调用不产生消息,单向无循环;离线静默跳过。已用「派发后零指令、台账出现 outcome」证明闭环。
- **三方模型 + 回退重做(用户要求,推翻 supersedes)**:
  - `assignedReviewer` 字段:dispatch_task 可指定 reviewer,缺省 = 发起方;settle_task 鉴权改为 reviewer。
  - 状态机:`completed → submitted` 回退转移;settle failure 使**同一任务**回退 submitted、retries+1、feedback 即修改意见、清 report/turn;success 保持 completed 终态。`supersedes` 字段移除——重做不再发新任务,全生命周期停留同一 taskId。
  - 三条回环:report→通知 reviewer;settle success→通知发起方(结果回传);settle failure→记录新消息 messageId 后通知执行方重做(claimed 监听器据此转移 working——不先记 messageId 则执行方收不到重做驱动,曾为此踩坑)。
  - 验证:同一任务 id 完成→failure 回退→自动重做→success,retries=1,台账全生命周期连续。
- domain 版本升 v3(assignedReviewer + 回退,旧数据拒绝)。
