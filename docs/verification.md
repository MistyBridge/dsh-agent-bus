# 验证指南

dsh-agent-bus 的四层验证体系:离线检查 → 组合验证 → 真实 e2e → GUI 验证。CI 覆盖第一层;后三层需要运行中的 dsh。

## 1. 离线检查(CI 自动)

```sh
pnpm install
pnpm test       # vitest 单元测试(480 用例,见下表分文件数)
pnpm build      # tsc 双配置 + tsdown 客户端 bundle
```

| 检查 | 覆盖 | 用例数 |
|---|---|---|
| `ledger` 测试 | 状态机转换、queued 迁移、依赖校验(环/跨流程/上限)、传播、edit/reassign 语义、交接文档 | 46 |
| `panel` 测试 | 快照组装、会话目录 registry 同源、flows 派生归档、DAG 列 | 58 |
| `panel-model` 测试 | 客户端分区、节点集/祖先链、调度判定、DAG 布局、归档规则、状态徽标 | 130 |
| `message-channel` 测试 | 双通道 header、限流隔离、配置默认值、离线入队 | 36 |
| `tools-render` 测试 | 待验收/待投递徽标、可见集规则、交接文档读取、get_task 可达性(决策 4 严格鉴权) | 36 |
| `tools-schema` 测试 | 全工具面输出 schema 与返回面一致性 + checkedTool 报错可读性(横切关注点) | 26 |
| `claim-task` 测试 | claim_task 领取转移/鉴权/幂等 + 心跳重投活跃态冷却(决策 2) | 11 |
| `flow-naming` 测试 | create_flow 重名拒绝/命名建议 + rename_flow 鉴权/重名 + 流投影 description(决策 8) | 10 |
| `fingerprint` 测试 | 构建指纹解析、实例过期判定(决策 7 运行实例可更新提示) | 23 |
| `wake` 测试 | 唤醒会话 preset 解析与装配(决策 10 A 部分) | 9 |
| `scheduler` 测试 | 启动恢复扫描、滞留任务聚合通知(决策 10 B 部分) | 6 |
| `compression-priority` 测试 | 任务通道优先于消息通道的投递优先级(决策 3) | 18 |
| `question-bridge` 测试 | 提问桥接:ask 注册/超时、答案校验(决策 9) | 15 |
| `approval-bridge` 测试 | PM 代审批:转发、时限、拒绝理由与建议(决策 6) | 7 |
| `create-member` 测试 | 成员入职解析/回滚/权限映射(决策 5) | 47 |
| `smoke` 测试 | 测试基座可用性 | 2 |
| **合计** | | **480** |

> 注:`panel-model` 的 2 组 `it.each`(各 13 行)统计为 26 用例,与 104 个普通 `it`
> 相加共 130;`tools-schema` 的 1 组 `it.each`(19 行)与 7 个普通 `it` 共 26。
> e2e 脚本(`tests/e2e/*-test.ts`)为本地资产,不计入单测,且命名保证 vitest 不误收。

## 2. 组合验证(profile 生效)

```sh
dsh plugin --profile web add .     # 或 npm 包
dsh --profile web --dump-config   # 验证组合:tools/agents/systemPrompt/sessionTitle/storageDomain/workspaceRegistry 全部注入
dsh web                            # 启动
```

- 启动日志无 `agent-bus` 错误;`http://127.0.0.1:3080/plugins/dsh-agent-bus/state` 返回 200。
- 快照含:`sessions`(与 dsh 侧边栏逐字节一致)、`flows`、`tasks`(queued/待验收徽标字段)、`stats`(含 queued)。
- SSE:`curl -N http://127.0.0.1:3080/plugins/dsh-agent-bus/events` 输出 `: connected`。
- dispatch 幂等:`POST /plugins/dsh-agent-bus/dispatch {"taskId": "<非queued任务>"}` 返回 `{"dispatched": false}`。

## 3. 真实 e2e(需要运行中的 dsh + 真实会话)

`tests/e2e/`(本地资产,不推送)驱动运行中的 dsh。前置:

```sh
dsh plugin --profile web add .    # 本地路径安装(软链到 checkout)
dsh web                            # 启动,http://127.0.0.1:3080
```

- 打开三个**同工作区**的 live 会话扮演 initiator / executor / reviewer(会话 id 从
  `list_peers` 或 `GET /plugins/dsh-agent-bus/state` 的 sessions 读取);
- 脚本默认连 `http://127.0.0.1:3080`(`DSH_BASE_URL` 可覆盖),每个等待阶段默认
  10 分钟(`E2E_WAIT_MS` 可调);工具调用(create_task / report_task / settle_task /
  cancel_task)由真实会话执行,脚本轮询台账等待可观测结果;
- 脚本名保持 `*-test.ts`(非 `*.spec.ts` / `*.test.ts`),vitest 不会误收;目录被
  `.gitignore` 忽略,为本地资产不推送。

```sh
node --import tsx tests/e2e/abc-test.ts     # 三方生命周期 + 负向(非 reviewer 禁 settle)
node --import tsx tests/e2e/dag-test.ts     # DAG 链式自动派发(auto=true)+ 失败自动传播
```

| 场景 | 断言 |
|---|---|
| 链式自动排期 | T2/T3 创建即 queued;T1 settle success → 自动投递 T2(auto=true)→ 链式直至末端,无人工派发 |
| 失败传播 | 根任务终态失败(cancel → dependency-canceled;timeout/no-response → dependency-failed)→ dependent 递归自动 failed,从未被派发(auto=false/turn=null) |
| 待验收语义 | completed 无 outcome → 台账「待验收」;reviewer settle 后出现 outcome |
| 负向 | 非 reviewer 不能 settle(reviewer = assignedReviewer ?? 发起方;命名 reviewer 后发起方亦无权) |

> 失败传播的时间线:settle failure 是**重做**而非终态(同一任务回退 submitted);
> 终态失败来自 timeout/no-response 扫查或 cancel。验证 dependency-failed 分支需在
> 启动配置里把 `taskTimeoutMs` 调小(如 60000)再重启,并以 `E2E_FAILURE_MODE=timeout`
> 运行 dag-test。

## 4. GUI 验证(浏览器面板)

- **会话目录**:与 dsh 左侧侧边栏完全一致——侧边栏显示的会话在活跃区(live 点仅状态标记),手动归档的会话在「归档 N」折叠区。
- **流程视图**:「活跃流程」显示已创建流程(名称 + 未结算/总数);点选 → DAG 渲染(节点=流程内任务);归档祖先淡显且不可交互;无流程任务不出现。
- **任务卡**:待投递(queued)徽章;待验收虚线徽章;验收标准与交接文档在详情区。
- **事件驱动**:任一任务状态变更,DAG 节点徽章与任务列表实时更新(SSE);断网时降级轮询不白屏。

## 已知限制(验收时注意)

- 投递仅达 live 会话;queued 任务在 worker 离线时由 sweep 持续重试,不丢。
- send_note 离线入队(v1.5):补投带「延迟送达」标记;3 次失败丢弃并通知发送方。
- 执行方离线超 15 分钟 → initiator 收到决策通知(不自动 fail,2h 超时兜底)。
- 模型可能完成工作但不更新任务状态 → reminder/offlineGrace/超时三层收敛。
- **reassign 与在途投递的重复投递竞态**(T6 决策项):改派后旧投递消息仍留在原接收方
  收件箱,接收方会收到重复的任务消息;由「非 assignedTo 拒 report」兜底,无危害。
  彻底方案:delivery/scheduler 投递前校验 recipient 是否仍是 assignedTo。
- **心跳重投与认领/报告的竞态**(T6 决策项):执行方余额中断后,心跳把 working→submitted
  并重投;若新投递的认领未落地,执行方的 report_task 会被状态机拒绝(submitted→completed
  非法)。缓解选项:心跳加重投冷却(重投后 N 分钟内不再踢),或 report_task 对
  「刚重投且执行者已交付」容忍。
