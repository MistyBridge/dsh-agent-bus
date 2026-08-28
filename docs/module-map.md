# 模块拆分设计:agent-bus 单体 → 嵌套 cordis 子插件

> 状态:**设计文档,仅方案,不实现**。目标是把当前单体的 `src/`(`index.ts` ≈613 行、`tools.ts` ≈2828 行、`ledger.ts` ≈1195 行等)按内聚边界拆成若干**真实嵌套 cordis 子插件**——每个子插件在自己的模块里 `export const name/inject/apply`,名字带 `agent-bus:` 前缀,参与 cordis 生命周期(可 `ctx.provide` 服务、`ctx.get`/`inject` 消费),由 `index.ts` 这个唯一挂载入口的 `apply()` 用 `ctx.plugin(...)` 依次挂载。行为不变(现有 18 文件 / 580 例测试必须仍绿,host+client tsc 零错)。
> 基线:HEAD `69554f3`,工作区干净。范围仅 `dsh-agent-bus/`;**不动** harness `packages/`、`apps/`、`vendor/`、`scripts/` 或其它插件。
> 面向后续特性的插入点:DAG 持久开关(`dag: 'running'|'paused'`),见 §4。

---

## 0. 现状耦合扫描(读码依据)

已读:`index.ts`、`tools.ts`、`ledger.ts`(open/迁移/emitChange + 全部方法面)、`types.ts`、`spec.ts`、`scheduler.ts`、`delivery.ts`、`checked-tool.ts`、`wake.ts`、`authorize.ts`、`rate-limit.ts`、`external.ts`、`panel.ts`(导出面)、`create-member.ts`、`reconfigure-member.ts`、`member-config.ts`、`approval-bridge.ts`、`question-bridge.ts`(导出面)、`tool-docs.ts`、`tools.ts` 全部工具注册名、`client/panel-model.ts`(导出面)、`src/client/*`、`vendor/cordis`(context/fiber/reflect/registry 的 `extend`/`provide`/`get`/`plugin`/`inject` 语义)。

关键结论:

- **纯领域**:`types.ts`(仅依赖 `@deepseek-ai/dsh-session` 的 `SessionId` 类型)与 `spec.ts`(仅 zod + `@deepseek-ai/dsh-storage-domain` + `SessionId`/`TaskId`)零跨插件行为依赖,可独立成域。
- **账本**:`ledger.ts` 的 `TaskLedger` 类是唯一**有状态、持 ctx、写 durable 域**的实体;`TaskLedger.open(ctx)` 用 `ctx.storageDomain.open(agentBusDomainSpec)` 打开域、`ctx.effect(() => domain.close())` 注册关闭、`ctx.emit('agent-bus/task-changed')` 发变更。它是其余一切插件的根服务。
- **跨插件共享的进程态**(index.ts 内联构造):两个 `DispatchRateLimiter`(`limiter`/`messageLimiter`)、`ReportStore`(`reports`)、`QuestionRegistry`(`questions`)、`noteActivity` 闭包(持 `lastActivity` Map)。这些由组合根构造,须以值服务传给 tools/runtime/bridges/web。
- **工具面**:`tools.ts` 的 `registerAgentBusTools(ctx, config, deps)` 一次注册 **27 个文档工具**(`tool-docs.TOOL_NAMES`)+ 披露加载器 `tool_help`,共 28 个注册项。工具共享一批纯函数(`renderTaskRow`/`canReadTask`/`renderTaskDetail`/`resolvePeerTarget`/`requireCaller`/`snapshotTokensAtDispatch`/`view`/`detailView`/`assertFlowName`)与 `checkedTool` 门。工具按域高度可分组(list/send/flows/tasks/members/answer/help)。
- **运行时钩子**(index.ts inline):`agent/inbox/claimed`、`agent/inbox/discarded`、`session/event`(turn-end 提醒,带 `noteActivity`)、`agent-bus/settle`(→`releaseDependents`)、启动 `dispatchReadyTasks`、`resumeStrandedTasks`(写 `recoveryInfo`)、三个 `setInterval` 清扫(超时/离线 + DAG 兜底、note 补投、cache 清扫)。
- **web 面**:`buildPanelSnapshot(ctx, ledger, reports, now, instanceInfo, recoveryInfo)` + `/state`、`/events`(SSE)、`/dispatch`、`/archive` 四条路由,全部在 index.ts 的 `registerWebSurface()` 里(webServer 可后到,故 lazy 注册 + `internal/service` 重触发)。
- **桥**:`approval-bridge`(`installApprovalBridge`)与 `question-bridge`(`registerQuestionBridge` + `QuestionRegistry`)独立,均消费 ledger + questions。
- **delivery.ts 编码卫生问题**:首 3 字节为 UTF-8 BOM(`EF BB BF`),且 **L73 的正则字符类内嵌一个 `\x00` 空字节**(`const C0_CONTROLS = /[\x00-\x08...]/g`),导致部分工具将其判为 binary。借拆分顺手修(见 §5.4 步骤 0)。

---

## 1. 目标模块图

```
src/
  index.ts            # 薄组合根:agent-bus(唯一挂载入口)
  domain/             # agent-bus:domain  —— 纯领域,零插件内依赖
    types.ts          # 原 types.ts(词汇/记录/Id 字面量)
    spec.ts           # 原 spec.ts(defineDomain 各表 schema)
  ledger/             # agent-bus:ledger  —— TaskLedger + 账本持久化;提供 'ledger' 服务
    index.ts          # 插件(name/inject/apply)
    ledger.ts         # 原 ledger.ts 主体(TaskLedger + 纯函数)
  members/            # agent-bus:members —— 成员/身份/授权/唤醒
    index.ts          # 插件(name/inject/apply)
    create-member.ts  # 原 create-member.ts
    reconfigure-member.ts  # 原 reconfigure-member.ts
    member-config.ts  # 原 member-config.ts
    wake.ts           # 原 wake.ts
    authorize.ts      # 原 authorize.ts(peer/身份/结算/读/线索 授权)
  tools/              # agent-bus:tools   —— registerAgentBusTools 全部工具
    index.ts          # 插件(name/inject/apply)
    checked-tool.ts   # 原 checked-tool.ts(工具输出 schema 门)
    tool-docs.ts      # 原 tool-docs.ts(TOOL_NAMES/TOOL_DOCS/USAGE_OVERVIEW)
    common.ts         # 共享纯函数:view/detailView/renderTaskRow/renderTaskDetail/
                      #   canReadTask/isActiveTask/resolvePeerTarget/requireCaller/
                      #   snapshotTokensAtDispatch/assertFlowName/admitContent 包装/rate-limit 助手
    list.ts           # list_peers/list_tasks/get_task/update_card
    send.ts           # send_note/wake_member
    flows.ts          # create_flow/create_batch/rename_flow/list_flows/list_batches/list_batch
    tasks.ts          # create_task/edit_task/report_task/settle_task/cancel_task/
                      #   request_input/claim_task/reassign_task/submit_handoff/archive_task/archive_flow
    members.ts        # create_member/reconfigure_member/archive_member
    answer.ts         # answer_question
    help.ts           # tool_help(披露加载器)
  runtime/            # agent-bus:runtime —— index.ts 内联的钩子 + 清扫
    index.ts          # 插件(name/inject/apply)
    hooks.ts          # inbox claimed/discarded、turn-end 提醒、settle→release、恢复扫描
    sweeps.ts         # dagSweep / 超时+离线 / note 补投 / cache 清扫 / 报告补投
  bridges/            # agent-bus:bridges —— 审批 + 提问
    index.ts          # 插件(name/inject/apply)
    approval-bridge.ts  # 原 approval-bridge.ts
    question-bridge.ts  # 原 question-bridge.ts
    question-registry.ts # 原 QuestionRegistry(可并入 question-bridge)
  web/                # agent-bus:web    —— 面板 snapshot + 路由
    index.ts          # 插件(name/inject/apply)
    panel.ts          # 原 panel.ts(buildPanelSnapshot 等 host 侧)
    routes.ts         # /state /events /dispatch /archive + SSE 监听 + event-source
    panel-model.ts    # 原 client/panel-model.ts(纯函数,client 复用) —— 见 §5.6
```

> **边界说明**(对任务建议清单的微调,均给出理由):
> 1. **`remove`/含 `ack` 挂载入口**:`create_batch`/`list_batches`/`list_batch` 现已是工具(报告 4.2),归 `flows.ts`(容器类)而非因名含 "list" 硬塞 `list.ts`;`archive_task`/`archive_flow` 是任务/流程生命周期,归 `tasks.ts`,不归 `members.ts`。
> 2. **`authorize.ts` 放 `members` 而非单独 common**:它是「谁能触达谁 / 谁能结算」的身份线索授权,与成员/peer 身份语义强耦合;但因它是**纯函数**(无状态、非服务),tools/runtime 可直接 `import` 到成员目录下的该模块——跨插件对纯函数的源码导入合法,不构成服务耦合。
> 3. **`runtime` 拆 `hooks`/`sweeps` 两个文件但同一插件**:二者共享 `lastActivity`/`recoveryInfo` 等进程态,拆成两个插件反而要互相把状态经 ctx 传来传去,违背内聚,故同一插件内分文件。
> 4. **`panel.ts`(host 侧)放 `web`,`client/panel-model.ts`(纯函数)保持 client**:`panel.ts` 的 `buildPanelSnapshot` 直接读 `ctx.agents`/`ledger`/`reports`,是 web 路由专用;`panel-model.ts` 是浏览器端纯函数,已在 `src/client` 打包路径,不动。
> 5. **不含 `fingerprint.ts`/`build-fingerprint.ts` 专插件**:指纹是启动一次性的「实例是否过期」判定 + 面板提示,极小;其 `instanceInfo` 与 `recoveryInfo` 随 web/boot 值传入(§2),不单独立插件。

---

## 2. 每个插件提供/消费的契约

### 总则(为何这样接)
- cordis 的 `ctx.extend()` 让子上下文**原型继承父上下文的所有属性**(含 `symbols.isolate` 服务名→symbol 映射与 `ctx.get`/`ctx.provide` 方法),同一隔离作用域下的服务实现写进共享 store;`ctx.provide(name, value)` 注册一个**当前 fiber 持有的服务实现**,`ctx.get(name)`/`inject:[name]` 沿原型向上解析。故**先激活的插件在子 ctx 上 `provide` 的服务,后挂载的兄弟插件能 `inject` 到**(二者共享父 ctx 的 store 与 isolate symbol;`inject` 会等待提供方 fiber 进入 ACTIVE)。
- 因此:组合根把「进程态共享值」在**根 ctx** 上 `provide`,子插件用 `inject` 取;账本子插件在**其子 ctx** 上 `provide('ledger')`,后挂载的 tools/runtime/bridges/web 用 `inject:['ledger']` 取。

### `agent-bus:domain`
- `inject: []`(零依赖)。
- 提供:**纯类型/纯 schema**。不通过 cordis 服务暴露(无实例);其余插件直接 `import` 其导出的 `TaskId`/`TaskRecord`/`agentBusDomainSpec` 等。若后续多个插件需要「同一份 zod schema」,可选择 `provide('agent-bus/domain-spec', agentBusDomainSpec)`,但当前无此必要(ledger 独享 spec)。

### `agent-bus:ledger`
- `inject: ['storageDomain', 'agent-bus/domain-spec']`(storageDomain 为 harness 服务;domain-spec 若未提供则直接 `import` 自 `spec.ts`,避免强制服务化)。
- `apply(ctx)`:调用 `TaskLedger.open(ctx)`(其内部已 `ctx.effect(() => domain.close())`、`import` spec、写迁移),随后 `ctx.provide('ledger', ledger)`,并把 `ctx` 引用留作 `emitChange` 用。
- 提供服务:`'ledger'`(值 = `TaskLedger` 实例)。
- 注:`TaskLedger.open` 已自持 `ctx` 用于 `emitChange`;无需子插件再包一层。**保留 `ledger.ts` 现有的类导出与 `static open`**,未迁移消费者可继续 `import { TaskLedger }`,再逐步迁到 `ctx.get('ledger')`(见 §5 阶段 2)。

### `agent-bus/members`
- `inject: ['agents', 'workspaceRegistry', 'sessionTitle', 'systemPrompt', 'permissionPresets?', 'agentPresets?', 'skills?', 'sessionPersistence?', 'ledger']`(其中 `permissionPresets`/`agentPresets`/`skills`/`sessionPersistence` 为**可选**,`ctx.get` 读、缺失即降级;`sessionTitle`/`systemPrompt` 为 create/reconfigure 成员所必需)。
- `apply(ctx)`:把成员相关**纯函数**组织为模块(create/reconfigure/member-config/wake/authorize)。此插件**不注册工具**(注册在 `agent-bus:tools`),但提供一小组可被 tools 调用的**函数导入**;同时把「成员组合需要的最小服务面」组合成一个**值服务** `provide('agent-bus/member-host', host)` 供 `create_member`/`reconfigure_member` 工具复用,避免 tools 里重复拼 `CreateMemberHost`/`ReconfigureMemberHost`。
  - host = `{ agents, sessionTitle, permissionPresets?, agentPresets?, skills?, ledger, workspaceRegistry }`(各面与 `create-member.ts` 的 `CreateMemberHost`、`reconfigure-member.ts` 的 `ReconfigureMemberHost` 对齐)。
  - **单例唤醒路由**:`setWakeRoute(...)` 是 wake.ts 的模块级单例(非 per-ctx),由**组合根在挂载 members 前调用一次**(§3);members 插件的 `wakeSession` 直接读该单例。
- 提供服务:`'agent-bus/member-host'`(值),供 tools 注入。
- 备注:authorize 为纯函数,`agent-bus:tools` 直接 `import` 而无服务化;若某些授权判定需要 live agent 面,authorize 已接受 `ctx` 参数,tools 传入。

### `agent-bus:tools`
- `inject: ['tools', 'agents', 'workspaceRegistry', 'ledger', 'agent-bus/deps', 'agent-bus/member-host', 'systemPrompt'?, 'permissionPresets'?]`(`tools` 为 harness 工具注册表服务;`systemPrompt` 用于 create_member role 缺省路由提示;`permissionPresets` 可选用于 create_member/reconfigure_member 权限提示)。
- `apply(ctx)`:在 `registerAgentBusTools` 拆成的若干**工具模块**上逐个 `ctx.tools.register(checkedTool({...}))`,每件工具仍走 `checkedTool` 门、`tool-docs` 单一事实源;`registerAgentBusTools` 的签名改为只接受 `ctx` + 已 `inject` 的 `config`/`deps`(config 由组合根解析后经 `provide` 或直接作插件 config 传入)。
  - **config 来源**:组合根校验 `Config`(zod)后,把 `ToolsConfig`(max* 字段)作为**插件 config** 传入 `ctx.plugin(agentBusTools, { config: resolvedToolsConfig })`,或 `provide('agent-bus/tools-config', resolved)`;tools 插件 apply 读 `config`。
  - `checked-tool.ts`、`tool-docs.ts` 留在此插件(工具专属),`tool-help` 工具在此注册。
- 不提供新服务(不对外暴露工具)。

### `agent-bus:runtime`
- `inject: ['agents', 'ledger', 'agent-bus/deps', 'agent-bus/boot', 'systemPrompt'?]`。
- `apply(ctx)`:
  - 挂 `agent/inbox/claimed`、`agent/inbox/discarded`(调 `deps.noteActivity`、`ledger.transition`)。
  - 挂 `session/event`(turn-end 提醒,带 `noteActivity` + 提醒冷却)。
  - 挂 `agent-bus/settle`(**必须是 Waterfall/emit,注**:`settle_task` 里 `ctx.emit('agent-bus/settle')` → 本插件 `ctx.on('agent-bus/settle')` 调 `releaseDependents`)。
  - 起动 `dispatchReadyTasks`、`resumeStrandedTasks`(写 `boot.recoveryInfo`)。
  - 起 4 个 `setInterval` 清扫(DAG 兜底 / 超时+离线 / note 补投 / cache 清扫),全部注册进 `ctx.effect(() => clearInterval(...))` 以便卸载。
  - 消费 `deps.activityAt`(心跳冷却)与 `deps.noteActivity`。

### `agent-bus:bridges`
- `inject: ['agents', 'ledger', 'agent-bus/deps', 'systemPrompt'?]`(`deps.questions` 由 question-bridge 与 answer_question 工具共享)。
- `apply(ctx)`:调 `installApprovalBridge(ctx, ledger, {...})`(经 `ctx.effect`)与 `registerQuestionBridge(ctx, ledger, deps.questions, {...})`,各自以 `ctx.on`/`ctx.waterfall` 挂监听,返回 disposer 由 `ctx.effect` 收编。
- 提供 `'agent-bus/questions'`(值 = `deps.questions`);若 tools 已从 `deps.questions` 拿到同一实例,可只经 deps 共享。

### `agent-bus:web`
- `inject: ['agents', 'ledger', 'agent-bus/deps', 'agent-bus/boot']`(`webServer` 经 `ctx.get` 可选,不确定时注册后移除)。
- `apply(ctx)`:`registerWebSurface()`(从 index.ts 原样搬入)——`/pluginstate`/`/events`/`/dispatch`/`/archive` 路由 + SSE 事件流;lazy 注册 + `ctx.on('internal/service')` 遇 `webServer` 重试。`buildPanelSnapshot` 读 `boot.instanceInfo`/`boot.recoveryInfo` 作面板提示。
- 提供:无对外服务。

### 共享值服务(组合根 提供)
- **`agent-bus/deps`**(值):
  ```ts
  {
    limiter: DispatchRateLimiter          // 任务派发限流
    messageLimiter: DispatchRateLimiter   // send_note 限流(独立窗口)
    reports: ReportStore                  // 外部化报告热/冷分区
    questions: QuestionRegistry           // 提问注册表(question-bridge/answer_question 共享)
    noteActivity(id: SessionId): void    // 执行者活跃信号(写 lastActivity)
    activityAt(id: SessionId): number | undefined  // 读 lastActivity(心跳冷却)
  }
  ```
  由组合根构造(来自 `Config` + `dshHomePath`,`lastActivity = new Map()` 在根持有,`noteActivity`/`activityAt` 两个闭包共用它)。
- **`agent-bus/boot`**(值,`recoveryInfo` 为可变对象):
  ```ts
  { staleInfo: StaleInfo, recoveryInfo: { recoveredWorkers: number; recoveryAt: number|null } }
  ```
  组合根计算 `staleInfo`(指纹),web 读,`runtime.resumeStrandedTasks` 写 `recoveryInfo`。

---

## 3. 薄组合根的接线清单(`index.ts apply`)

顺序(在根 ctx 上先 `provide` 共享值,再依次 `ctx.plugin(...)`,每个子插件返回的 disposer 收入 `ctx.effect`):

```
export const name = 'agent-bus'
export const inject = ['tools','agents','systemPrompt','sessionTitle','storageDomain','workspaceRegistry']

export async function apply(ctx, config) {
  // 1) 解析 config(zod 已校验) → resolved ToolsConfig + timeout/offline/retry/wake 等字段
  // 2) 构造共享值:
  //    - lastActivity = new Map<string, number>()
  //    - noteActivity / activityAt 闭包共用 lastActivity
  //    - deps = { limiter, messageLimiter, reports, questions, noteActivity, activityAt }
  //    - staleInfo = isInstanceStale(BUILD_FINGERPRINT, readDiskFingerprint(...))
  //    - recoveryInfo = { recoveredWorkers: 0, recoveryAt: null }
  //    - boot = { staleInfo, recoveryInfo }
  // 3) setWakeRoute({ provider, model })   // wake.ts 模块单例,挂 members 前调一次
  // 4) ctx.provide('agent-bus/deps', deps)
  //    ctx.provide('agent-bus/boot', boot)
  //    ctx.provide('agent-bus/tools-config', resolvedToolsConfig)   // 可选,亦作插件 config 传
  // 5) ctx.provide('agent-bus/domain-spec', agentBusDomainSpec)     // 可选;ledger 亦可直接 import
  // 6) 依次挂载子插件(顺序即依赖序;inject 已声明者cordis会等,显式顺序更稳):
  //    await ctx.plugin(domainPlugin)
  //    await ctx.plugin(ledgerPlugin)      // 内部 open → provide('ledger')
  //    await ctx.plugin(membersPlugin)     // 内部 provide('agent-bus/member-host')
  //    await ctx.plugin(toolsPlugin)       // consume ledger + deps + member-host
  //    await ctx.plugin(runtimePlugin)     // consume ledger + deps + boot
  //    await ctx.plugin(bridgesPlugin)     // consume ledger + deps.questions
  //    await ctx.plugin(webPlugin)         // consume boot + ledger + deps
  // 7) 不再内联任何工具/钩子/路由/清扫——只留组合与 `ctx.systemPrompt.section(agent-bus:usage)`(usage 段仍在此,靠 systemPrompt)
}
```

**现有调用点迁移归属**:

| 现有 index.ts 调用点 | 迁往 |
|---|---|
| `ctx.systemPrompt.section(agent-bus:usage, USAGE_OVERVIEW)` | 保留在组合根(靠 `inject:['systemPrompt']`);或移 `runtime`(usage 是常驻策略,归 `agent-bus:runtime` 更贴切——建议移 runtime,组合根更薄)。 |
| `TaskLedger.open(ctx)` | `agent-bus:ledger` |
| `new DispatchRateLimiter(...)`×2 / `new ReportStore(...)` / `new QuestionRegistry()` / `noteActivity` | 组合根构造,经 `agent-bus/deps` |
| `setWakeRoute(...)` | 组合根调用一次(单例) |
| `registerAgentBusTools(ctx, resolved, deps)` | `agent-bus:tools` |
| `registerQuestionBridge` / `installApprovalBridge` | `agent-bus:bridges` |
| `registerWebSurface()` + `/state` `/events` `/dispatch` `/archive` | `agent-bus:web` |
| `ctx.on('agent/inbox/claimed'|'agent/inbox/discarded')` | `runtime/hooks` |
| `ctx.on('session/event')(turn-end 提醒)` | `runtime/hooks` |
| `ctx.on('agent-bus/settle')`→`releaseDependents` | `runtime/hooks` |
| `dispatchReadyTasks` / `resumeStrandedTasks` | `runtime` |
| `dagSweep` / 超时+离线 sweep / noteSweep / cacheSweep | `runtime/sweeps` |

---

## 4. DAG 持久开关插入点(仅方案,不实现)

### 4.1 状态字段放哪
`src/spec.ts` 的 `agentBusDomainState`(全局单例 schema)加字段:
```ts
export const agentBusDomainState = z.object({
  taskIds: z.array(taskId).default([]),
  dag: z.enum(['running', 'paused']).default('running'),
})
```
`agentBusDomainSpec` 的 `global.initial` 追加 `dag: 'running'`,`version` 11 → **12**(dsh-storage-domain 单调版本,升级即失效存储单元;升级需先备份 `agent_bus.json`,同 v1.3 §6 惯例)。落盘即持久,重启保留。

### 4.2 TaskLedger 新方法
`src/ledger/ledger.ts` 的 `TaskLedger` 增:
- `dagState(): 'running' | 'paused'` —— 读 `this.global.value.dag`(同步,域全局读),缺省当 `'running'`。
- `async setDagState(mode: 'running' | 'paused'): Promise<LedgerResult>` —— 写 `this.global`(`enqueue` 写链串行),返回 `{ok, dag}`;幂等(set 相同值不重复写)。写后 `this.ctx.emit('agent-bus/task-changed', { taskId:'-', from:'-', to:`dag:${mode}` })`(或单独事件)供客户端刷新面板 DAG 开关状态。

### 4.3 `dispatchOne` 返回类型
`src/scheduler.ts` 的 `dispatchOne` 由 `Promise<void>` 改为返回**结果并揭示是否因暂停未投递**:
```ts
export type DispatchOutcome =
  | { dispatched: true; taskId: TaskId; status: 'submitted' }
  | { dispatched: false; reason: 'not-queued' | 'no-worker' | 'dag-paused' | 'raced' }
export async function dispatchOne(ctx, ledger, id): Promise<DispatchOutcome>
```
实现:进入先 `if (await ledger.dagState() === 'paused') return { dispatched:false, reason:'dag-paused' }`(在取 worker / 建消息之前,零副作用的短路);其余分支现状不变,仅统一返回类型。

### 4.4 哪些调用点随之读返回
| 调用点 | 现状 | 改动 |
|---|---|---|
| `index.ts` `/dispatch` 端点 | `await dispatchOne(...)` 后固定发 `{status:'submitted', dispatched:true}` | 读 `outcome`:dispatched→200 `{status:'submitted',dispatched:true}`;`dag-paused`→200 `{status:'queued',dispatched:false, dag:'paused'}`(客户端停止轮询该任务,等恢复) |
| `scheduler.releaseDependents`(settle→release) | `for` 循环忽略返回 | 读 `outcome`:`dag-paused` 的依赖**不计**为已释放(返回计数只算真正 dispatched),避免「settle 成功但依赖仍 queued」被误判为已投递 |
| `scheduler.dispatchReadyTasks`(兜底扫) | 返回 `ready.length` | 暂停时全部 `dag-paused`,返回 0;返回**实际 dispatched 数** |
| `scheduler.resumeStrandedTasks` | 不涉 dispatchOne | 不受影响(仅唤醒提醒,不投递) |
| `tools.edit_task` | `await dispatchOne(...)` | 读 `outcome`,仅当 `dispatched` 时把 `blockedBy` 置空;`dag-paused` 时保留 `blockedBy`/提示「DAG 已暂停」 |
| `tools.settle_task`(成功时 `ctx.emit('agent-bus/settle')`) | 经事件触发 | 无需直接改;由 releaseDependents 读返回体现 |
| client `/dispatch` 事件驱动调度(client panel-model `isReadyToDispatch`) | POST 后按返回更新 | 读 `dag` 字段;paused 时不再 POST,`isReadyToDispatch` 增加「dag==='running'」前置 |

### 4.5 `set_dag_state` 工具的解析/编排模块
- **解析/编排放** `src/tools/dag-switch.ts`(归 `agent-bus:tools`):
  - `parseSetDagStateInput(raw): { ok, plan?: { dag:'running'|'paused' } } | { ok:false, error }` —— 字段 `dag`(必填,enum 'running'|'paused')。
  - `setDagState(host, plan)` —— `host = { ledger: TaskLedger, resume?: () => Promise<number> }`;调 `ledger.setDagState(mode)`;当 `mode==='running'` 时再调 `resume()`(= `dispatchReadyTasks`)补投之前因暂停滞留的 queued 任务。
- **工具注册**:`src/tools/dag-switch.ts` 的 `registerDagTool(ctx, deps)` 在 `agent-bus:tools` 挂载时以 `checkedTool` 注册 `set_dag_state`;`tool-docs.TOOL_NAMES` + `TOOL_DOCS` 增配。
- **权限**:仅「工作区成员、非自身」即可(与成员工具一致);或限定任务发起方?——**建议**同泛化鉴权(授权工具面一致),非特殊权限需求。

### 4.6 面板如何读到状态
- `src/panel.ts` 的 `PanelSnapshot` 增 `dag: 'running'|'paused'`(由 `buildPanelSnapshot` 读 `ledger.dagState()` 填入)。
- `src/client/panel-model.ts` 增对应 `dag` 字段与常量;`TaskPanel.tsx` 渲染一个 DAG 开关/状态徽标;`/state` 返回携 `dag`。
- `/events`(SSE)在 `set_dag_state` 后发 `task-changed`(或专门 `dag-changed`),客户端据此更新开关显示。

---

## 5. 抽取顺序建议(每步保持「测试绿 + tsc 绿」)

**硬性原则**:
- 每个子插件**先以「模块化 + 被 index 挂载」存在**,不一次性推翻;先**保留既有模块导出**(`TaskLedger` 类、`registerAgentBusTools`、`buildPanelSnapshot` 等)让未迁移消费者继续 `import`。
- 每个阶段结束跑一次 `pnpm --dir dsh-agent-bus test` + `tsc -p tsconfig.json/tsconfig.client.json --noEmit`(tests 用 esbuild 不类型检查,但 build 的 tsc 只覆盖 src;如需对测试文件做严格检查,可对新增 `.spec.ts` 单独 `tsc`);门禁指纹即「现有 18 文件 / 580 例 + host+client tsc 零错」。

**阶段 0(前置卫生)**:`delivery.ts` BOM + 内嵌 `\x00`(L73)。仅去掉首 3 字节 BOM、把正则字符类里的空字节改写为可读的 `\x00` 表示(如 `/[\\x00-\\x08...]/`),**不改任何行为**;改后确认 vitest 通过。这是 `tools.ts` 拆分前必要的一步(拆分后 `delivery.ts` 仍在,行为不变)。

**阶段 1(cleanup/domain)**:新建 `domain/`(`types.ts`+`spec.ts` 原样搬入),`ledger.ts` 改 `import ... from './domain/types.ts'` 等;**保留** ledger.ts 的类导出。tsc + test 绿。

**阶段 2(ledger)**:建 `ledger/` 插件(`name:'agent-bus:ledger'`,`inject:['storageDomain']`),`apply` 调 `TaskLedger.open(ctx)` 并 `provide('ledger')`;组合根先 `ctx.plugin(ledgerPlugin)`,其余消费者暂仍 `import { TaskLedger }` 直用(组合根把打开的 ledger 实例经 `agent-bus/deps` 顺带传下去,或各插件暂先 `ctx.get('ledger')`)。关键做法:**`TaskLedger` 类与 `static open` 保留**,配合 `Provider` 一次性接上,避免迁移期双实例。tsc + test 绿。

**阶段 3(members)**:建 `members/` 插件(纯函数模块搬迁 + `provide('agent-bus/member-host')`)。create/reconfigure 工具暂仍从 `members/` import。tsc + test 绿。

**阶段 4(tools)**:建 `tools/` 插件。先把 `registerAgentBusTools` 原样搬入插件 apply(不拆域),随后**按零行为变化**把 27+1 工具拆到 `common.ts` + `list/send/flows/tasks/members/answer/help.ts`;每件工具仍经过 `checkedTool`;`deps`/`config` 改经注入。**关键做法**:工具纯函数导出(`renderTaskRow`/`canReadTask`/`renderTaskDetail` 等)在有 spec 引用时保留,迁移后删。tsc + test green(工具面 schema 回归 tools-schema.spec 全绿)。

**阶段 5(runtime / bridges / web)**:三个插件各自打包 index.ts 内联块。runtime 先搬 hooks/sweeps 并把 `lastActivity`/`recoveryInfo` 经 `agent-bus/deps`/`agent-bus/boot` 传出;bridges 搬 approval/question;web 搬 `registerWebSurface`。tsc + test 绿。

**阶段 6(DAG 开关)**:在 spec 加 `dag` 字段、ledger 加 `dagState/setDagState`、`dispatchOne` 改返回类型、各调用点读返回、`set_dag_state` 工具 + `dag-switch.ts`、面板读状态;version 11→12。**此步单独成 commit/改动**,便于回滚;加 `dag-switch.spec.ts`(解析/编排/暂停不投递/恢复补投)与 tools-schema 的 maximalValueOf 用例。

**各阶段「保持绿」的关键手法**:
- **保留导出别名**:源文件在迁移目录与老路径之间保留 `export *`/`export { X }` 别名若干 commit,直到无消费者为止,避免大爆炸式一次性改写。
- **服务化是「加法」**:`ctx.provide` / `inject` 只在**新插件边界**引入;`TaskLedger` 等先用类导出,后续消费者再迁 `ctx.get('ledger')`。
- **先搬后拆、小步单文件**:每个工具/模块搬迁为一次小 commit,跑一次 tsc+test;拆大文件时先拆纯函数(无 ctx)再拆耦合体。
- **测试基座不动**:`tests/helpers/*`(memory-ctx / tool-harness)保持 in-memory storage-domain 接缝;拆分若需调整导入路径(`../src/ledger.ts`→`../src/ledger/ledger.ts`),改导入不改行为。

---

## 6. 附录:每个插件「name / inject / provide」速查

| 插件 | `name` | `inject` | `provide` |
|---|---|---|---|
| domain | `agent-bus:domain` | `[]` | 无(纯类型/schema,直接 import) |
| ledger | `agent-bus:ledger` | `['storageDomain']` | `ledger: TaskLedger` |
| members | `agent-bus:members` | `['agents','workspaceRegistry','sessionTitle','systemPrompt', ...(可选 permissionPresets/agentPresets/skills/sessionPersistence), 'ledger']` | `agent-bus/member-host` |
| tools | `agent-bus:tools` | `['tools','agents','workspaceRegistry','ledger','agent-bus/deps','agent-bus/member-host','systemPrompt'?,'permissionPresets'?]` | 无 |
| runtime | `agent-bus:runtime` | `['agents','ledger','agent-bus/deps','agent-bus/boot']` | 无 |
| bridges | `agent-bus:bridges` | `['agents','ledger','agent-bus/deps']` | 无(questions 经 deps 共享) |
| web | `agent-bus:web` | `['agents','ledger','agent-bus/deps','agent-bus/boot']` | 无 |
| (组合根) | `agent-bus` | `['tools','agents','systemPrompt','sessionTitle','storageDomain','workspaceRegistry']` | `agent-bus/deps`,`agent-bus/boot`,`agent-bus/tools-config`(可选) |

> 跨插件共享的进程态由**组合根**持有并 `provide`:deps(`limiter`/`messageLimiter`/`reports`/`questions`/`noteActivity`/`activityAt`)+ boot(`staleInfo`/`recoveryInfo`)+ tools-config;`setWakeRoute` 为 wake.ts 模块单例,组合根调一次;`ledger` 由 `agent-bus:ledger` 提供。这样 tools/runtime/bridges/web 各取所需,无重复实例。
