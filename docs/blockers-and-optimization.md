# dsh-agent-bus 卡点与优化建议（含产品决策）

> 状态：**v9，全部决策已实施 + Phase 3 优化完成**（2026-08-23 产品批复 + 决策 8/9/10 补充；Phase 2 决策实施全部落地；Phase 3 遗留卡点优化全部落地）。已采纳的决策进入「六、已采纳决策设计要点」，由开发团队按要点实施；无未决项。后续新增卡点/决策持续追加。
> v4 变更：剩余三项全部决策——心跳重投冷却（要）、实例更新提示（做）、PM 判定=任务指派方。
> v5 变更：新增决策 8（流程命名管理，产品反馈：流程界面新建的流程需要良好命名，否则难以管理任务组）。
> v6 变更：新增决策 9（提问转交任务发起方，产品反馈：worker 执行任务中调用 ask_user_question 应由任务发起方回答；产品确认：**A2A 提问需转发，user↔A 提问不转发**）。
> v7 变更：新增决策 10（重启恢复：平台崩溃后自动拉起会话并恢复工具集。实战:20:20 重启后所有经 wakeSession 唤醒的工人缺文件/shell 工具,根因=wakeSession 未传 preset setup;PM 手工逐条发 note 唤醒,步骤多)。
> v8 变更：Phase 2 全部落地（决策 1-10 已实施完成）——16 文件 480 用例全绿、typecheck 双零错误、build 通过。决策 1-9 由团队按 DAG 实施并逐项验收,决策 10 由 PM 直接实施(A wake 修复 / B 启动恢复扫描 / C 面板提示)。
> v9 变更：Phase 3 遗留卡点优化全部落地——①审批拒绝 reason+suggestion 随返回同步附上(T1)；②A2A/user↔A 判定改用注入上下文(open turn 首个消息 + source.kind + findByMessage,T2)；③19 工具完整梳理 + 说明书单一事实源(tool-docs.ts)+ USAGE_TEXT 收缩为短总览 + tool_help 渐进式披露(T3)；④流程命名 ≤20 字上限(决策 8 追加,T3)；决策 10 B/C 状态修正为已完成。门禁:17 文件 496 用例全绿、typecheck 双零错误、build 通过。

---

## 一、卡点清单（实战记录）

### 卡点 1【严重】工具输出 schema 漂移导致核心工具静默失效
- **现象**：`list_tasks` / `get_task` 返回被 harness 拒绝：`"value[0].title" is not a declared property`。发起方与工人全部无法使用。
- **根因**：v1.6 新增 `title` 字段，`view()` 返回携带但 `output.schema` 未同步；返回面必须精确等于 schema。这是 updatedAt 同类 bug 的**第二次复现**——无自动校验机制。
- **决策**：✅ 采纳（见决策 1）。

### 卡点 2【严重】心跳重投与认领/报告的竞态（任务卡死 submitted）
- **现象**：T5 被心跳从 working 踢回 submitted，重投后认领未落地，`report_task` 被状态机拒绝（submitted→completed 非法），工人重试 5 次无效。
- **根因**：心跳重投与正常周期的竞态；**状态机没有 submitted 直达 completed 的路径**，也没有恢复手段。
- **决策**：✅ 采纳「工人主动领取」方案（见决策 2）；心跳冷却/report 容忍/恢复工具作为补充项继续评估。

### 卡点 3【中】协调消息与任务投递共用 FIFO，消息阻塞进度
- **现象**：协调者多条 `send_note` 每条占工人一个 turn，任务投递被挤在队列后，认领延迟多轮。
- **决策**：✅ 采纳消息压缩机制（见决策 3）。

### 卡点 4【中】reassign 与在途投递的重复投递
- **现象**：T3/T4 改派后原执行者仍收到旧投递（重复，兜底有效）。
- **决策**：➖ 重复投递暂缓（无影响）；✅ 追加**严格鉴权**（见决策 4）。

### 卡点 5【中】新增成员（RPC 建会话）入口不友好
- **现象**：`session.create` 需 `workspaceId` 才绑定工作区（踩坑 3 次）；新会话权限默认严，pwsh 审批挂起。
- **决策**：✅ 采纳「成员入职 tool」（见决策 5，吸收本卡点与卡点 6 的权限部分）。

### 卡点 6【中】审批无应答导致轮次挂起
- **现象**：新会话跑 pwsh 触发沙箱升级审批，无应答时轮次挂起。
- **决策**：✅ 采纳「PM 代为审批」权限管理模型（见决策 6）。

### 卡点 7【外部】DeepSeek API 余额不足（402）
- 非插件 bug；harness 自动恢复，任务未丢失；暴露卡点 2 的窗口。优化 2 修复会缩小危害。

---

## 二、多维度评估

### 可靠性
- 三层收敛（reminder → offlineGrace → timeout）设计良好，余额中断中任务无一丢失。
- 心跳重投引入新卡死状态——**恢复路径缺失是最大可靠性缺口**（决策 2 直接回应）。

### 易用性
- schema 漂移让核心工具静默失效且报错不可读（决策 1 回应）。
- 队列挤占影响协调体验（决策 3 回应）。
- 成员创建/审批是扩编团队的入门障碍（决策 5/6 回应）。

### 成本
- 长会话热前缀收益已验证；协调往返、重复投递、重复重投是纯浪费（决策 3/2 回应）。

### 运维
- 运行实例 lib/ 过期导致新旧行为并存；台账 JSON 是可靠兜底。

---

## 三、优化建议（决策状态）

| # | 建议 | 决策 |
|---|---|---|
| 1 | 工具输出 schema 一致性 gate + 有价值报错 + 更新说明书 | ✅ **采纳**（决策 1） |
| 2 | 心跳重投冷却 / report 容忍 / 恢复工具 | ✅ **采纳「主动领取」方案**（决策 2）；其余子项继续评估 |
| 3 | 队列感知忙碌 / 任务投递优先 / 消息压缩 | ✅ **采纳消息压缩**（决策 3） |
| 4 | reassign 去重在途投递 + 严格鉴权 | ➖ 去重暂缓；✅ **严格鉴权采纳**（决策 4） |
| 5 | 会话创建绑定文档化 | ➖ 并入决策 5 |
| 6 | 审批增量投递 / PM 代审批 | ✅ **采纳 PM 代审批模型**（决策 6） |
| 7 | 运行实例可更新提示 | ✅ **采纳**（决策 7） |
| 8 | 成员入职函数（JSON 结构化 + 解析器 + 模块预留） | ✅ **采纳**（决策 5） |

---

## 四、决策记录（2026-08-23 三轮批复）

**第一轮（6 项）**：决策 1/2/3/4/5/6 采纳（见第六节）。
**第二轮（剩余 3 项）**：
1. **心跳重投冷却** → ✅ **要**（并入决策 2）。
2. **优化 7 实例更新提示** → ✅ **做**（决策 7）。
3. **PM 判定标准** → ✅ **任务指派方**（`assignedBy` / initiator，并入决策 6）。

**结论**：所有优化项均已决策，无未决项。「会话级模块模板」保持延后评估（第五节），但决策 5 预留模块扩展点。

---

## 五、延后评估（不进入本期）

- **会话级 dsh 模块化定制（per-session 模块模板）**：逐会话定义加载哪些 dsh 模块/插件。**决定：暂不开发**——dsh 可能暂不支持该粒度，开发难度待评估。**但决策 5 的入职 tool 预留模块扩展点**（见决策 5 第 6 条），待 dsh 侧能力确认后接入。

---

## 六、已采纳决策设计要点（2026-08-23 产品批复）

### 决策 1：工具输出 schema 自动检查 + 有价值报错 + 更新说明书（卡点 1）
1. **机制**：`defineTool` 包装器对 `execute` 返回做 schema 校验（复用 harness 同一把尺子 `validateJsonSchemaValue`）；不一致时抛出结构化错误。
2. **报错必须有价值**：明确指出——哪个字段缺失 / 多余 / 类型不符 / 违反 `additionalProperties:false`；附返回面与说明书的最小差异；提示模型「工具返回面与说明书不一致」。
3. **更新说明书**：报错信息引导修复方向——若是新功能加了字段，提示同步更新 `output.schema`（说明书）；给出缺失字段的建议声明（含类型）。
4. **回归防线**：tools-schema.spec.ts（19 用例）保留；新增「报错信息可读性」断言（错误消息包含字段名与修复提示）。

### 决策 2：submitted 状态工人可主动领取任务（卡点 2）
1. **状态机新增路径**：任务处于 `submitted`（待执行）时，执行方（assignedTo）**可主动领取**，状态 `submitted → working`，**无需等待系统自动投递**。
2. **实现**：新增工具（建议名 `claim_task`）或扩展 `report_task` 前自动 claim；claim 需鉴权（仅 `assignedTo` 可领，其他人报错「该任务不属于你」）。
3. **缓解卡点 2**：工人卡在 submitted 时可直接领回 working 再 report，不再依赖协调者手动 reassign。
4. **保留**：系统自动投递照旧；心跳重投照旧（作为兜底）。
5. **心跳重投冷却（产品确认：要）**：重投后冷却期内不再踢——冷却绑定「执行者活跃态」：执行者在连续 N 分钟内有过 turn/报告活动则不重投；避免反复重投刷新 updatedAt 形成循环（T5 曾因此循环）。
6. **A2A 对齐**：claim 语义映射到 A2A 的 submitted→working 自然转移，不破坏现有状态机（仍是合法转移，只是触发方从「系统」扩展到「执行方」）。

### 决策 3：消息压缩机制（卡点 3）
1. **批量合并**：同一接收者的多条 `send_note` 合并为一条投递（已有离线补投合并基础，复用该模式）。
2. **系统提示压缩**：reminder/通知类消息按接收者合并、去重、限频（如 15 分钟冷却已有，再合并同主题）。
3. **目标**：减少「一条一 turn」的回合占用，避免过多系统提示消息阻塞任务投递与执行。
4. **实现（T5，2026-08-23）**：系统通知压缩落地在 `src/delivery.ts` 的 NoticeMerger（按**接收者**为键、3s 窗口合并；同接收者+同任务+同主题去重；不同主题/任务合并为一条投递，每段自带 relay header），`notifySession`/`flushNoticeMerges`/`clearNoticeMerges` 同文件导出，scheduler/index/tools 全部经此投递通知；投递优先级落地为任务消息走 **steer（next-step）通道**（create_task 默认 mode 改 steer、心跳重投/reassign/返工/cancel 摘要/回答路径改 steer），send_note 与离线补投保持 followup（next-turn），`Inbox.claim` 先取 next-step 后取 next-turn，任务认领不再被 note 队列挤后。测试见 `tests/compression-priority.spec.ts`（18 例）。

### 决策 4：严格鉴权——非终态任务仅任务相关者可访问（卡点 4 追加）
1. **规则**：非 `completed` 且未归档的任务，**仅任务相关者可读取/操作**：`assignedBy`（派发方）、`assignedTo`（执行方）、`assignedReviewer`（验收方）。
2. **非相关者访问**：报错「该任务与你无关」（或「你不是该任务的相关者」），不给任何任务内容。
3. **覆盖**：`get_task`、`list_tasks` 详情、以及所有会泄露任务内容的工具路径；`canReadTask` 收紧为「相关者或任务已归档/已完成」。
4. **终态例外**：已完成/已归档任务可公开读取（历史记录）。
5. **重复投递去重**：暂缓（无影响，非 assignedTo 拒 report 兜底有效）。

### 决策 5：成员入职 tool——create_member（卡点 5）
1. **封装**：新增 agent-bus 工具（建议名 `create_member`），一键入职。
2. **输入（JSON 结构化）**：`workspace`（工作区）、`name`（会话名）、`role`（角色设定/persona）、`skills`（技能列表）、`mcp`（MCP 配置）、`permissions`（权限）、可选 `flow`（加入流程）、可选 `description`（能力卡片描述）。
3. **解析器**：JSON 结构校验（缺必填字段/非法值报错并指明字段）→ 解析为入职步骤。
4. **自动化入职**：创建会话（workspaceId 绑定）→ 命名（session.rename）→ 角色注入（persona/系统提示）→ 挂载 skills/MCP（配置注入）→ 权限配置 → 更新能力卡片 → 可选加入 flow。
5. **失败处理**：任一步失败回滚已创建部分并给出明确错误（避免半成品成员）。
6. **预留扩展点**：**agent 级 dsh 模块定制字段**（如 `modules`）——本期不实现，schema 预留并文档标注「待 dsh 侧能力确认」，实现时解析器忽略或告警。

### 决策 6：PM 代为审批的权限管理（卡点 6）
1. **角色模型**：PM（项目经理）通常 **full access**；子 agent 权限可能受限。PM 是任务的派发方（initiator）或指定 reviewer。
2. **代审批**：子 agent 执行需要鉴权（提升权限）的操作时，**由 PM 代为审批**——agent-bus 自动把审批请求转给该任务的 PM（而非全局审批者）。
3. **自动提醒**：工作过程中出现鉴权操作，agent-bus **自动提醒 PM 进行审批**（通知含：谁、什么操作、为什么需要、任务上下文）。
4. **拒绝必须给理由 + 解决方案**：PM 判决不通过时，必须填写理由，并给出解决方案建议（如改用低权限替代操作、修改任务范围、调整权限配置），随拒绝结果一并告知子 agent——子 agent 不能只收到冷冰冰的「拒绝」。
5. **PM 判定（产品确认）**：PM = **任务指派方**（`assignedBy` / initiator）。子 agent 的鉴权操作审批自动转给该任务的指派方；无指派方的操作（如会话级操作）转给 full access 会话或按配置处理。
6. **兜底**：PM 长时间不响应时，按既有超时/降级机制处理（fail-closed 并告知子 agent 可请求 PM 或调整方案），不永久挂起。

### 决策 7：运行实例可更新提示（产品确认：做）
1. **机制**：插件启动/运行中检测自身 lib 版本与磁盘构建产物是否一致（如记录构建指纹）；不一致时在面板/日志提示「代码已更新，需重启生效」。
2. **缓解**：本 session 多次「视图滞后 / 工具行为旧」的根因就是运行实例 lib 过期；提示后用户可主动重启，减少新旧行为并存期。
3. **低成本版**：启动日志 + 面板角标提示；不强制自动重启（重启会打断会话，需用户决策）。

### 决策 8：流程命名管理（产品反馈 2026-08-23：新建流程需良好命名，否则难以管理任务组）
1. **create_flow 重名拒绝**：同一工作区内**重名流程创建直接报错**（「该工作区已有同名流程『xxx』」，并列出已有流程名），引导换个可区分的名字。
2. **其余给提示不强制**：空名/纯数字/纯符号等无意义名**放行**，但报错信息（或创建结果）中提醒命名建议（如「目标 + 阶段」格式），不打断模型工作流。
3. **rename_flow 工具**：流程创建后**可改名**（`rename_flow(flow_id, name, description?)`），重名检测同上。
4. **权限（产品确认）**：改名**仅创建者可改**（`createdBy`），他人报错「仅流程创建者可改名」。
5. **DAG 界面**：流程列表项显示 `name` + `description`（截断一行，悬停看全文）+ 任务数，多流程并排可区分。
6. **命名上限（产品反馈 2026-08-23 追加）**：流程命名**不允许超过 20 个字**，且须**简明说出核心内容**（一眼能看出这个任务组在做什么）。create_flow / rename_flow 的 name 校验由「1–80 字符」收紧为「≤20 字符」；超长报错含「流程名不超过 20 字,并简明概括任务组核心内容」。命名规范写入说明书(docs/usage.md 与 USAGE_TEXT 的 create_flow/rename_flow 描述)。重名拒绝与无意义名提示保留。
7. **测试**：重名拒绝、无意义名放行但提示、rename 成功/重名/越权、界面模型、**20 字上限拒绝**。

### 决策 9：提问转交任务发起方——A2A 提问转发，user↔A 提问不转发（产品反馈 2026-08-23）
1. **场景**：worker 执行 agent 发起的任务过程中，调用 dsh 官方工具 `ask_user_question`（选择题请求）——默认会弹给人类用户，但正确回答者是任务发起方（PM）。
2. **判定标准（产品确认）**：**提问的 agent 是否正在执行 agent-bus 任务**（ledger 中存在 `assignedTo = 调用者` 且状态 `working` 的任务）——
   - **A2A 提问（是）→ 转发**：agent-bus 接管，把问题转给该任务的发起方（`assignedBy` / PM）回答。
   - **user↔A 提问（否）→ 不转发**：人类用户与 agent 的对话中提问，走 dsh 原链路（弹给人类用户），agent-bus 不介入。
3. **机制**：agent-bus 注册 `tools/execute` around-wrapper（官方扩展点，不侵入官方代码），拦截 `ask_user_question` 调用——匹配「worker 正在执行任务」时接管（不调 `next()`），否则放行（调 `next()` 走原链路）。
4. **接管流程**：问题序列化进任务记录（含选项）→ 任务 → `input-required`（复用现有状态机）→ 通知 PM → PM 用新工具回答 → 答案转成 `AskUserQuestionAnswer` 返回给 worker 的工具调用。
5. **新增 answer_question 工具**：PM 回答 `answer_question(task_id, answers)`（`{id, selected[], custom?}` 数组，复用官方 Answer 结构）；鉴权：仅 `assignedBy`（PM）可答。
6. **边界**：PM 自己执行任务时提问 → 转给**它的**任务发起方，不是自己；worker 一次只做一个任务（一条一 turn），按最新 working 任务匹配；PM 不响应 → 超时 fail-closed（同决策 6 兜底），不永久挂起。
7. **与 request_input 的关系**：并存互补——`request_input` 是 worker 主动纯文本提问；本机制拦截官方选择题工具，结构化选项自动转 PM。
8. **测试**：A2A 提问转发（worker 任务中提问 → 转 PM、回答返回）、user↔A 不转发（人类会话提问 → 走原 provider）、PM 越权拒绝、超时兜底。

### 决策 10：重启恢复——崩溃后自动拉起会话并恢复工具集（实战 2026-08-23）
1. **实战背景**：20:20 dsh 重启后,所有经 `wakeSession` 唤醒的工人会话**只恢复了一半**——agent-bus 工具在(host 插件全局注册),文件/shell 工具丢(preset 未挂载)。工人无法读源码、写代码、跑测试;互相转包也无效(所有唤醒会话同病);PM 手工逐条发 note 才拉起 6 人。根因对比源码确认:`dsh-agent-bus/src/wake.ts` 的 `wakeSession` 调 `ctx.agents.resume()` 时**未传 setup**,而官方 api-proxy 冷启动 resume 会 `composeAgent(storedPreset)` 把 preset setup(工具/persona)挂上(api-proxy.ts:1598-1602)。
2. **A 部分:修复 wakeSession 工具集恢复(已完成,PM 实施)**:
   - `src/wake.ts` 新增 `resolveSessionPreset(header, events)`(最新 `agent-preset/selected` 事件优先,header 兜底——与官方 `dsh-agent-presets/session` 同规则,但 agent-bus 不依赖该包,事件标签走开放式记录读取)与 `composeWakeSetup(ctx, header, events)`(经 `ctx.get('agentPresets')` 构造 setup,挂载会话记录的 preset)。
   - `wakeSession` resume 前先 `ctx.get('sessionPersistence').inspect(sessionId)` 拿 header/events,构造 setup 后传给 `agents.resume({..., setup})`。
   - 可选服务 `ctx.get`(sessionPersistence/agentPresets),webless profile 缺服务时保持原降级(不唤醒→排队),不阻塞启动。
   - 测试:`tests/wake.spec.ts` 9 用例(resolveSessionPreset 5 + composeWakeSetup 4),test 359 全绿、build 通过、strict tsc 零错误。
3. **B 部分:启动自动恢复扫描(已完成,PM 实施)**:
   - `src/scheduler.ts` 新增 `resumeStrandedTasks`:插件启动时(apply 末尾,`dispatchReadyTasks` 之后)扫描 `status ∈ {working, submitted, input-required}` 的任务,执行者(`assignedTo`)不在 agents registry → `wakeSession` 唤醒 → 成功则投递「系统恢复通知」(带任务上下文,提醒继续并 report);失败维持现状(offlineGrace 兜底)。
   - 按 session 聚合,一个 worker 只收一条通知(即使有多个任务)。
   - 幂等:本次启动已唤醒的不重复(内存 Map);live 执行者的任务不动(避免干扰正在跑的)。
   - 测试:`tests/scheduler.spec.ts` 6 用例(唤醒/聚合去重/live 不碰/无法唤醒跳过/终态忽略/双执行者各一条),test 480 全绿、build 通过、strict tsc 零错误。
4. **C 部分(已完成,PM 实施)**:面板快照带 `recoveredWorkers`/`recoveryAt`,客户端 TaskPanel 显示「上次启动已自动恢复 N 个滞留任务的工作会话」提示条(可关闭,per-batch 记忆)。测试见 fingerprint/panel 相关断言。
5. **预期效果**：A+B+C 落地后,崩溃恢复 = 重启 → 插件自动唤醒所有未完成任务执行者(工具集完整)→ 每工人一条恢复通知继续干活,零人工介入。

---

## 附：实施建议顺序

1. 决策 1（schema gate + 报错可读性）——低成本高收益，先行
2. 决策 2（claim_task 主动领取）——直接解除卡点 2
3. 决策 4（严格鉴权）——安全基线
4. 决策 3（消息压缩）——体验优化
5. 决策 5（create_member 最小版）——产品指定方向
6. 决策 6（PM 代审批）——涉及审批链路，最后做
