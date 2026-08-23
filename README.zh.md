# dsh-agent-bus

[English](README.md) | **中文**

<p>
  <a href="https://github.com/MistyBridge/dsh-agent-bus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
  <a href="https://github.com/MistyBridge/dsh-agent-bus"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-1a73e8" alt="DeepSeek Harness"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933" alt="Node.js"></a>
</p>

**DeepSeek Harness 上的多 Agent 编排。** 别再当传话筒。

dsh-agent-bus 是 [DeepSeek Harness](https://deepseek-ai/deepseek-harness) 插件：把同一工作区里的活跃会话编成一套班子——互相派活、验收对方产出、按 DAG 跑多步骤流程。投递走的还是你已经在用的 Inbox。

专家还是那些专家。复制粘贴的人不再是你。

## 这个插件能做什么

来自真实团队在总线上的两张运行画面：

![任务工作台](https://github.com/MistyBridge/dsh-agent-bus/raw/main/docs/images/agent-bus-test.png)

*任务工作台：每件工作的状态、成员与消耗一目了然。*

![流程(DAG)看板](https://github.com/MistyBridge/dsh-agent-bus/raw/main/docs/images/QQ_1787487778189.png)

*流程(DAG)看板：流程的节点，只在全部前置结算后投递。*

- **派的是活，不是消息** —— `create_task` 给同伴一件带验收标准、带验收人的工作；`send_note` 只是没有生命周期的轻量问候。按轻重选通道，面板上一眼看到每件工作的状态。
- **计划不用你插手也能跑** —— `create_flow` 建一张命名 DAG：每个任务只在全部前置结算后投递，终态失败沿链条传播。看板一次渲染一个流程，已归档的祖先淡显。
- **配的是真专家** —— 每个总线成员都是普通 dsh 会话，自带独立的 skills、MCP 服务器、权限预设和模型。`create_member` 一键入职完整成员（工作区绑定、命名、角色、技能、权限、能力卡片），失败自动回滚。
- **崩溃后自动恢复** —— 重启后插件自动唤醒每个滞留执行者并恢复完整工具集，每人一条恢复通知。不用任何人手动把人拉回来。
- **团队纪律** —— 已完成/已归档任务是公开历史，进行中任务仅相关者可读；PM 代审子成员审批，工人可自领重投任务，流程可改名（`rename_flow`）便于管理。

## 为什么要做这个

Harness 已经能在一个工作区里开多个 Agent。它并不能让它们**协作**。

没有这个插件时：

- 规划会话没法给编码会话派活。你得把 brief 贴过去。
- 编码会话没法等验收会话。你得把 patch 贴过去。
- 第 3 步失败了，你得从聊天记录里把第 1、2 步重新拼回来。

用总线来管理团队，而不是你自己在当传话筒。

## 你实际能得到什么

**说话就是说话。** 提问、确认、「看一下这个」用 `send_note`。不落台账、不验收、不做超时戏。对方离线，消息入队，上线再送。

**干活就是干活。** `create_task` 是一件有正文、可选验收标准、有验收人的工作。执行方 report；验收方通过，或把**同一条任务**连同修改意见打回去。重做全程同一个 id。

**计划可以在你不插手时往下跑。** `create_flow` 是一张命名 DAG。你（或规划 Agent）先写 plan，再按 `flow_id` 和 `dependencies` 拆任务。B 在 A 被验收之前根本不会投递。A 被取消或终态失败，B、C 跟着失败——不会留下还在空转的执行者。

**下一棒读到的是链条，不是考古。** 结算后，执行方可以给每个后向任务附交接（数值、决策、注意事项）。投递时拼进下游正文。第 3 棒不必靠 `get_task` 把第 1 棒翻出来。

**你看得到。** Web 界面右侧胶囊打开工作台：任务列表，以及按流程的 DAG 画布。点节点看全文要求。已归档的祖先留在图上，淡显。

## 任务日志

会话聊天不适合当工作台账。问候和任务混在一起，压缩上下文时会丢，下一棒也无法查询「昨天验收通过的是哪一件」。

Agent-bus 在对话旁边另有一份 **任务日志**：只记真正的工作，不是每条消息的全文转储。

**消息留在会话里。** `send_note` 是聊天。不落台账行、不上面板、不需要 report。那个会话的 jsonl **就是**它的记录。

**任务落台账行。** 每次 `create_task` 写下谁派的、谁做、谁验收、任务要求、可选验收标准、依赖，以及后来的判定。状态在这一行上走（`queued` → `submitted` → `working` → `completed` → settle）。重做是同一个 id；`get_task` 能读出一件活的完整一生。

**报告是文档，不是又一段聊天。** 短报告内联在行上。长报告按 task id 外置到磁盘——引用是 id，不是模型可能泄漏的路径：

| 区 | 位置 | 内容 |
|---|---|---|
| 热 | `~/.dsh/agent-bus/cache/` | 活跃任务报告；7 天未访问清理 |
| 冷 | `~/.dsh/agent-bus/archive/` | 终态任务（`completed` / `failed` / `canceled`）；30 天未访问清理 |

`get_task` 先热后冷。模型看不见分区。台账本身在 harness 存储域（`agent_bus`）；每次打开还会在 `~/.dsh/agent-bus/backups/` 写一份 JSON 快照（保留最近 20 份），避免 schema 重建把表吃掉。

**人看的和模型列的不一样。** 面板是给人的日志：活跃工作、归档（结算超过 24 小时，或失败/取消）、token、某个流程的 DAG。`list_tasks` 故意不列归档行——执行方收件箱不是历史堆。历史在面板、`get_task` 和会话日志里。

目的就这一条：下一棒、验收方、以及你，读的是**同一份**记录，而不是从三个聊天窗口里把活重新拼出来。

## 快速开始

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

web-app bundle 已挂载存储和工作区注册表。自定义或 headless profile 须在自己的 `cordis.patch.yml` 里声明 `storage`、`storage-json`、`storage-domain`、`workspace`——否则加载即失败。记不住账的网关，不应以静默降级形态启动。

需要 Node.js `^22.19.0` 或 `>=24`。

## 它怎么工作

投递是 harness 的 Inbox：一次 `followup()` 一轮 turn，空闲会话才取下一项。本插件**不**再造一条队列。

插件负责的是**台账**——谁派的、谁做、什么叫完成、谁依赖谁——以及读这份台账的面板。

没有接收侧工具。执行方看到的是普通一轮对话。做完调用 `report_task`。

```
消息     send_note              →  对方用散文回复（也可以不回）
任务     create_task            →  queued → submitted → working → completed → settle
流程     create_flow + 任务     →  DAG 在前置结算后自动投递下一节点
```

选能覆盖需求的最轻通道。把聊天写成任务，工作会卡死在 `working`；把任务写成聊天，就丢掉验收。

## Agent Bus 对比 Sub-agent

### 为什么放弃 sub-agent 架构

Harness 已经有 **sub-agent**：父会话调用 `spawn_subagent`，子会话拉起来干活，交回一份**摘要**。适合「隔离着查一下再回来」。

团队没有建在这套架构上。子代理**通常继承主会话的权限组和配置**——skill、MCP、插件组、模型、allowlist。你可以裁工具带（agent 类型、capability mode、persona），但很难做到：编码会话自己的仓库 MCP、调研会话自己的网页 MCP、验收会话更严的租户 allowlist——三套不同的配置。专家团队要的就是这种精细化配置，继承做不到。

所以总线上的每一个对象**就是一个普通的 DeepSeek Harness 会话**——和你在 dsh 里已经会配的那种。它保住自己的 **skill**、**MCP**、**插件组**、**权限预设**和**模型**。组团队就是这么组的；多租户要挂的也是这套会话模型——**按租户 / 按角色的权限组与 dsh 插件组**，而不是「父会话这次 spawn 了什么」。

| | **Sub-agent** | **Agent Bus** |
|---|---|---|
| 工作单元 | 为这一次活新开子会话，结束即丢 | `followup()` 投进**已经存在**的同伴会话 |
| 执行方是什么 | 一次性孩子：类型 + capability mode + 可选 persona | 你在 dsh 里配好的**一等会话实例** |
| Skill / MCP / 插件 | 从父会话继承，spawn 时通常被裁 | **按会话**：自己的 skill、MCP、插件组 |
| 权限 | 父会话的信封再收窄 | **按会话**（多租户宿主上还可以按权限组） |
| 拓扑 | 星型：父会话是枢纽 | 同工作区 peer + 持久台账 |
| 谁验收 | 父会话读摘要 | 独立验收方，通过或把**同一 task id** 打回去重做 |
| 顺序 | 下一步必须由父会话再 spawn | DAG：A 结算之前 B 根本不会投递 |
| 失败 | 父会话得自己发现 | 终态失败 / 取消沿下游自动传播 |
| 进程重启 | 剧本在父会话上下文里 | 台账 + Inbox 检查点还在 |
| 并行 | 一个父会话可以同时挂很多子会话 | 多个 peer 同时干活；每个 peer 仍然一条一 turn |

### 成本实际花在哪

没有虚构的「快几倍」。差别是 **token 和延迟花在谁身上**。

| 成本 | Sub-agent | Agent Bus |
|---|---|---|
| **Prompt cache** | 每次 spawn 都付一遍**冷**前缀（系统提示、工具、指令）。 | 专家是长会话。下一件任务是同一前缀上的下一轮 user turn，**缓存是热的**。 |
| **编排者上下文** | 每个子会话的摘要都进**父窗口**。N 件活 → 父上下文按 N 份摘要涨。 | 发起方只收到一条短通知。全文在台账里（长报告落盘）。需要时再 `get_task`。 |
| **到首 token 的时间** | 拉起会话 + 冷缓存上的第一次解码。 | 同伴在线且空闲：就是**下一轮**，不新开进程。 |
| **专家记忆** | 子会话结束就没了。第 4 件活不记得第 3 件，除非父会话把摘要塞进下一次 spawn。 | 同一个编码会话窗口里还留着第 3 件活（工作区文件也还在）。其余靠交接文档。 |
| **一次性探索** | **用这个。** 隔离窗口，父会话缓存不被污染。 | 别用。peer 是团队里的人，不是沙箱。 |

**口诀：** 要保护调用方上下文、干完就扔 → spawn sub-agent。被叫的那一方**就是**一个有自己 skill / MCP / 插件 / 权限、还要接下一件活的同事 → 用 bus。

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
| [`docs/usage.md`](docs/usage.md) | 操作手册：工具、状态机、模板 |
| [`docs/v1.5-resilience-spec.md`](docs/v1.5-resilience-spec.md) | 离线消息、转派、离线宽限 |
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | 事件驱动排期、流程、交接 |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A 任务状态对齐 |

## License

MIT
