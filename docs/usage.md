# dsh-agent-bus 使用说明书

dsh-agent-bus 让同一工作区的 agent 会话互相派活、验收、取消,并用流程(DAG)编排多步工作。本文档面向 agent 与人类使用,给出 21 个工具的使用说明、状态机、鉴权边界与渐进式披露用法。

## 一、渐进式披露:先看总览,按需看 full manual

系统提示只注入**简短总览**(`USAGE_OVERVIEW`),包含三条路由(Route by scope)、消息 header 约定,以及「用 `tool_help({ tool })` 获取任一工具完整说明书」的指引。

- **常驻**:`Route by scope`(SMALL→`send_note`、MEDIUM→`create_task`、LARGE→`create_flow`)+ 消息 header(`<dsh-agent-bus task=… tool=…>` 是任务 / `<dsh-agent-bus-message tool="send_note">` 是聊天)+ 21 个工具名清单。
- **按需**:执行某工具前,若需确认其完整参数 / 语义 / 鉴权,调用 `tool_help({ tool })`,工具结果为该工具的完整说明书(模型可见的披露路径)。
- 好处:避免一次性把 8.6KB 长文塞进每个请求;模型只在动手前按需展开,上下文负担小、不相关工具不干扰。

## 二、21 个工具

> 每个工具的**完整说明书**(参数枚举、语义、鉴权边界、典型用法、注意事项)在运行时经 `tool_help({ tool })` 返回;下表为速查。

### 发现与路由

| 工具 | 用途 | 参数 |
|---|---|---|
| `list_peers` | 列工作区在线 peer(id/title/status/pendingTasks/description/capabilities),为 create_task/send_note 选 target | 无 |
| `update_card` | 维护自身能力卡(description ≤200,capabilities ≤8 项、id 小写 kebab、label 1-50) | description?, capabilities? |
| `list_flows` | 列工作区流程(id/name/description/taskCount/unsettledCount/archived) | 无 |
| `list_tasks` | 列活跃任务(scope=inbox 派发给你的 / outbox 你发起的;status 过滤) | scope?, status? |
| `get_task` | 读单任务完整记录(含 report/acceptanceCriteria/handoffs/question 等) | task_id |

### 通道(按 scope 路由)

| 工具 | 用途 | 参数 |
|---|---|---|
| `send_note` | SMALL:一条轻量消息,无记录/验收/报告 | target, content |
| `create_task` | MEDIUM:一个可验收交付物 | target, content, title, mode?, reviewer?, task_id?, dependencies?, acceptance_criteria?, flow_id? |
| `claim_task` | 执行方把 submitted 拉回 working | task_id |

### 任务生命周期(worker → reviewer → initiator)

| 工具 | 用途 | 参数 |
|---|---|---|
| `report_task` | 执行方提交结果(working→completed,通知 reviewer;canceled 交摘要) | task_id, result |
| `settle_task` | 验收方裁决(success 终态+DAG 释放;failure 返工) | task_id, outcome, feedback? |
| `cancel_task` | 任务方取消未完成的任务(queued/submitted/working/input-required) | task_id, reason? |
| `reassign_task` | 任务方改派执行方/验收方(不重建任务) | task_id, new_executor?, new_reviewer? |
| `request_input` | 执行方暂停并请 initiator 提供关键输入 | task_id, question |
| `answer_question` | 发起方回答 worker 的 ask_user_question 结构化提问 | task_id, answers |

### 流程(DAG)与交接

| 工具 | 用途 | 参数 |
|---|---|---|
| `create_flow` | 建流程(LARGE 容器:先计划再分解;**流程名 ≤20 字,简明概括任务组核心内容**) | name(≤20), description? |
| `rename_flow` | 重命名一个流程(**新名 ≤20 字**;工作区成员即可改,不限创建者,可选替换 description) | flow_id, name(≤20), description? |
| `edit_task` | 编辑未派发任务(要求/依赖/验收/标题/移 flow) | task_id, content?, dependencies?, acceptance_criteria?, title?, flow_id? |
| `submit_handoff` | 执行方向下游任务提交交接文档 | task_id, to_task_id, document |

### 归档(手动,永不自动)

| 工具 | 用途 | 参数 |
|---|---|---|
| `archive_task` | 手动归档/取消归档一个任务(隐藏/恢复其活跃视图,可逆,不改变状态) | task_id, archived? |
| `archive_flow` | 手动归档/取消归档一个流程(独立于其任务;工作区成员即可操作,不限创建者) | flow_id, archived? |

### 扩编

| 工具 | 用途 | 参数 |
|---|---|---|
| `create_member` | 一键入职正式成员(workspace+name 必备;role/skills/permissions/flow/description 可选) | workspace, name, role?, skills?, mcp?, permissions?, flow?, description?, modules? |

### 加载器

| 工具 | 用途 | 参数 |
|---|---|---|
| `tool_help` | 返回指定工具的完整说明书(渐进披露入口) | tool |

## 三、状态机(任务生命周期)

合法迁移(`src/ledger.ts` `ALLOWED_TRANSITIONS`):

```
submitted → working → completed / failed / canceled / submitted(心跳重投)
working   → input-required(暂停) → working(回答后) / submitted(重投)
input-required → working / failed / canceled
queued    → submitted(依赖结算后自动派发)
(终态)completed / failed / canceled / rejected —— 不再迁移
```

- `submitted` 是投递后待执行;worker 可 `claim_task` 直接领回 `working`,或经认领自动转。
- `completed` 待验收;`settle_task(success)` 使其终态并释放 DAG 依赖者。
- `failed / canceled / rejected` 终态;它们**不会自动离开活跃列表**——归档是手动动作(`archive_task`),永不自动;取消归档即恢复可见。

## 四、鉴权边界(拒绝即给可读理由)

| 工具 | 鉴权 |
|---|---|
| `list_peers` / `list_flows` | caller 在线且在工作区 |
| `send_note` | caller 在线且有 workspace;不能自投;recipient 须同 workspace 注册会话(可离线);archived 拒绝 |
| `create_task` | `authorizePeerOrDormant`:caller 在线+有 workspace;target 同 workspace(可休眠);subagent 不可;maxPendingPerAgent 上限 |
| `get_task` | `authorizeTaskRead`:活动任务仅参与者(assignedBy/assignedTo/assignedReviewer);completed/终结公开 |
| `report_task` | 仅执行方(assignedTo) |
| `settle_task` / `cancel_task` | 仅任务 reviewer(显式 assignedReviewer,否则 initiator)——你不该验收/取消自己的活 |
| `reassign_task` / `edit_task` | 仅任务派发方(assignedBy) |
| `request_input` / `claim_task` | 仅执行方(assignedTo/authorizeClaim) |
| `answer_question` | 仅任务发起方(assignedBy) |
| `create_member` | caller 在线且在工作区 |

## 五、常见流程模板

1. **派一个交付物**:`list_peers` 选人 → `create_task(target, content, title)`。
2. **拆多步工作**:`create_flow(name)` → 多个 `create_task(flow_id, dependencies=…)`;依赖结算后自动派发。
3. **执行与交付**:收到 `<dsh-agent-bus task=… tool="create_task">` → 做 → `report_task`;缺输入 `request_input`,发起方 `create_task(task_id=…)` 回答或 `answer_question`。
4. **验收/返工**:收到 `report_task` 提醒 → `get_task` 读完整报告 → `settle_task(success|failure, feedback)`。
5. **交接**:已结算任务的上游 → `submit_handoff(task_id, to_task_id, document)` 给下游。
6. **改派/取消**:任务方向不对 → `reassign_task` 或 `cancel_task`。

### 命名规范(决策 8)

- 流程名 `create_flow` / `rename_flow` **≤20 字**,并简明概括任务组核心内容;超过 20 字拒绝,报错「流程名不超过 20 字,并简明概括任务组核心内容」。同工作区重名拒绝(报错列出已有名);无意义名(纯数字/符号)放行但返回命名建议。
- 任务 `title` **≤20 字**(与流程名阈值一致,统一"所有 name ≤20 字")。
- 会话标题(会名)`create_member` 的 `name` **≤20 字**。

## 六、配置与限流

- 工具从 `src/tools.ts` 的 `checkedTool` 定义注册;输出要与其 `output.schema` 精确一致(决策 1 schema gate,漂移抛结构化报错并给出修复方向)。
- 默认上限:`maxContentLength=16000`、`maxPendingPerAgent=20`、`maxSendsPerMinute=10`、`maxMessagesPerMinute=20`、`maxInlineReport=400`、`taskTimeoutMs=2h`、`offlineGraceMs=15min`、`retryIdleMs=5min`。
- `mode`(create_task):默认 `steer`(优先级通道,先于任何待认领 note 被认领);显式 `followup` 则 FIFO 排在已有消息后。
