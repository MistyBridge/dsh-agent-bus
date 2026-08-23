# dsh-agent-bus

[English](README.md) | **中文**

<p>
  <a href="https://github.com/MistyBridge/dsh-agent-bus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
  <a href="https://github.com/MistyBridge/dsh-agent-bus"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-1a73e8" alt="DeepSeek Harness"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.0.0-339933" alt="Node.js"></a>
</p>

# DeepSeek Harness 上的多 Agent 编排

**把一屋子互不相干的 Agent 变成一支真正干活的团队。** 在同一条你已经在用的 Inbox 上派活、验收、按 DAG 跑多步骤流程——不用在它们之间复制粘贴，也不用守着循环当保姆。

> dsh-agent-bus 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给同一工作区的活跃会话配一份**持久任务台账**、一条**验收回路**和一台 **DAG 调度器**——于是**协调这件事交给 Agent 自己**，而不是你。

![任务工作台](docs/images/agent-bus-test.png)

*任务工作台：每件工作的状态、成员与消耗一目了然。*

![流程(DAG)看板](docs/images/QQ_1787487778189.png)

*流程(DAG)看板：流程的节点，只在全部前置结算后投递。*

---

## 为什么值得做

Harness 已经能在同一个工作区里开多个 Agent，但它不让它们**协作**。落到实上：你才是那个粘合剂。

- **规划 Agent 没法把 brief 交给编码 Agent。** 你得手动贴过去。
- **编码 Agent 没法等验收 Agent。** 你得把 patch 贴过去，再催验收人。
- **第 3 步失败时，** 你得从聊天记录里把第 1、2 步重新拼回来，再手动重排后续。

agent-bus 把 **你** 从这个循环里摘出去：让协调变得**可持久、可验收、可自动**——这正是它能在生产里用起来、而不是停留在「聊天式演示」的原因。

### 你能得到什么

| 能力 | 你不用再做的事 |
|---|---|
| **真正的工作项，不是消息** | `create_task` 是一件带正文、带验收标准、带验收人的活；`send_note` 只是没有生命周期的问候。把任务当聊天，活会卡在「进行中」；把聊天当任务，验收就没了。 |
| **能自己跑的计划** | `create_flow` 建一张命名 DAG：每个任务**只在全部前置结算后**投递。终态失败沿链条传播——不会留下空转的执行者。 |
| **一份持久任务日志** | 每件活都是台账里的一行，不是埋在聊天里。`get_task` 读一件任务的完整一生；长报告落盘，绝不走模型可能泄露的路径。 |
| **真正会验收的验收人** | 执行方 report，验收方通过或把**同一条**任务连同意见打回去。重做全程同一个 id。 |
| **自己会走的上下文** | 结算后，执行方附一份交接（数值、决策、注意事项）随下游任务一起投递。下一棒读的是链条，不是考古。 |
| **能扛崩溃的记忆** | 台账 + Inbox 检查点在重启后存活；插件自动唤醒滞留执行者并恢复完整工具集。不用任何人把人拉回来。 |
| **真·专家而非子代理** | 每个总线成员都是普通 dsh 会话，自带独立的 skills、MCP 服务器、权限预设和模型。`create_member` 一键入职完整成员，失败自动回滚。 |

## 生产里能落在哪些地方

agent-bus 是为已超出「一个 Agent + 大量复制粘贴」的团队准备的：

- **长期多步骤构建**——规划一次发布，拆成 Agent 真去执行的任务，让 DAG 只在依赖被验收后才派下一步。你看面板，不看逐字稿。
- **能力各异专家池**——带仓库 MCP 的编码员、带网页 MCP 的研究员、权限更紧的验收人。各自保留配置，总线负责在他们之间路由活。
- **可复现的验收门槛**——每件活都有验收标准和验收人。非得一位具名验收人落定，才算「完成」。这是聊天与工作流的分水岭。
- **可查询的审计轨迹**——每个决定、结论、交接都是台账行或落盘报告。「昨天验收通过的是哪件？」是一次 `get_task`，不是翻聊天。
- **能活过重启的团队**——会话压缩和进程重启不会丢计划、不会困住执行者。总线会自动把它们拉起来。

## 怎么工作

投递用的是 harness Inbox：一个 turn 一条 `followup()`，空闲会话接下一条。本插件**不加第二队列**。

插件的活是 **台账**——谁派活、谁执行、什么叫「完成」、谁依赖谁——再加一台读台账的面板。

没有 receive 端工具。执行方看到的是一次普通 turn，干完调 `report_task`。

```
note     send_note              →  对方用 prose 回（或不回）
task     create_task            →  queued → submitted → working → completed → settle
flow     create_flow + tasks    →  DAG 在前置结算后自动投递下一节点
```

按轻重选最匹配的通道。

## Agent Bus 与子代理

子代理（sub-agent）在今天 Harness 里是**默认答案**，这不无道理。问题不是「谁更好」，而是 **「哪个适配工作的形状」**。

### 子代理擅长什么

`spawn_subagent` 会启动一个**用完即弃的子会话**，它继承父会话的权限信封与会话配置，干一件活，还回一条**摘要**。它在这些情况下正合适：

- 你想**保护调用方上下文**——派一个隔离的探索者去调研，让父窗口保持干净。
- 子会话是**一次性的、可丢弃的**——它的记忆不需要活过这件活。
- 任务是**单个自包含请求**，配固定 prompt，而不是一个会接许多活的角色。

### agent-bus 擅长什么

总线成员**不是**子代理。它是一个**普通 DeepSeek Harness 会话**——你已经会定制的那种——带着自己的 **skills**、**MCP 服务器**、**插件组**、**权限预设**、**模型**。这在以下情况很重要：

- 执行者是一个**你想长期保留的具名专家**——带仓库 MCP 的编码员、带网页 MCP 的研究员、权限更紧的验收人。子代理继承给三者同一个信封；按会话配置给各自专属。
- 工作是**带依赖的多步骤计划**——A 没验收，B 不该开始。那种排序是张 DAG，不是「摘要落地了就 spawn 下一个」。
- 你需要**验收回路和审计轨迹**，而不是一棵摘要树。任务的正文、验收标准、验收人、结论、交接，都是你能用 `get_task` 查询的持久台账行。
- 团队得**扛得住重启或压缩**——台账和 Inbox 检查点比父上下文活得久。

### 对比

| | **子代理** | **Agent Bus** |
|---|---|---|
| 工作单元 | 为一件活而生的子会话，用完即弃 | `followup()` 进一个已存在的 Peer 会话 |
| 执行者*是*什么 | 一次性孩子：类型 + 能力模式 + 可选 persona | 你在 dsh 里配置的**一级会话实例** |
| Skills / MCP / 插件 | 继承自父，通常为 spawn 收窄 | **按会话**：自己的 skills、MCP 服务器、插件组 |
| 权限 | 父会话信封，收窄 | **按会话**（多租户 host 下按权限组） |
| 拓扑 | 星型：父是中心 | 同一工作区的 Peer + 持久台账 |
| 谁验收 | 父读摘要 | 一级验收人验收或重做**同一条**任务 id |
| 排序 | 父必须编排每一次 spawn | DAG：A 没结算，B 不投递 |
| 失败 | 父得自己发现 | 终态失败/取消沿链条传播 |
| 重启后 | 剧本活在父上下文里 | 台账 + Inbox 检查点存活 |
| 并行 | 一个父派多个孩子 | 多个 Peer 并行；每个 Peer 一个 turn 一个 Inbox 项 |
| 热上下文 | 每次 spawn 吃一次冷前缀 | 专家长寿；下一条活是暖 turn |

### 经验法则

用**子代理**去保护调用方上下文，应对**一次性**工作——隔离探索、单个请求、用完即弃的孩子。

用 **agent-bus** 当被调用者**是一个具名队友**——带着自己的 skills、MCP、插件、权限，还会接下一条活——并且工作**值得保留排序、验收和审计轨迹**。

它们是互补而非竞争：spawn 一个子代理让调用方保持干净，用总线去跑那个会 spawn、会验收、会把工作往前推的**团队**。

## 快速上手

```sh
dsh plugin --profile web add dsh-agent-bus
dsh web
```

本地开发：

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

需要 Node.js `^22.19.0` 或 `>=24.0.0`（与 harness 一致；CI 跑在 Node 24）。

## 工具

| 你想… | 用 |
|---|---|
| 问一句、不是派活 | `send_note` |
| 给一个同伴一件要验收的活 | `create_task` |
| 按顺序跑一个多步骤计划 | `create_flow`，再带 `flow_id` / `dependencies` 的 `create_task` |
| 交差 / 验收 / 重做 / 停掉 / 反问 / 换人 | `report_task` · `settle_task` · `cancel_task` · `request_input` · `reassign_task` |
| 自己领回被重投的任务 | `claim_task` |
| 回答执行者的结构化提问 | `answer_question` |
| 把上下文交给下一棒 | `submit_handoff` |
| 改还没投递的节点，或查记录 | `edit_task` · `list_flows` · `list_tasks` · `get_task` |
| 给流程改名，让任务组更好管理 | `rename_flow` |
| 看谁在线，声明自己能做什么 | `list_peers` · `update_card` |
| 把新成员一键入职到工作区 | `create_member` |

## 文档

| | |
|---|---|
| [`docs/usage.md`](docs/usage.md) | 手册（中文）：工具、状态机、模板 |
| [`docs/v1.5-resilience-spec.md`](docs/v1.5-resilience-spec.md) | 离线消息、改派、离线宽限 |
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | 事件驱动派发、流程、交接 |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A 任务状态对齐 |

## 许可

MIT
