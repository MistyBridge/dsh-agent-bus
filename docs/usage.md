# 使用手册

dsh-agent-bus 操作手册:工具参考、状态机、常见流程模板、配置。面向 agent 与人类使用者。

## 工具参考(17 个)

### 发现

| 工具 | 说明 |
|---|---|
| `list_peers` | 同工作区 live 会话 + 自维护卡片(description/capabilities)+ 状态 + 排队数;归档会话不出现 |
| `update_card` | 维护自己的能力卡片;capabilities 为 kebab-case 机器键(≤8 个) |

### 团队管理

| 工具 | 说明 |
|---|---|
| `create_member` | 一键入职:workspace(路径或 id)+ name 必填;可选 role(persona section)、skills(技能定义)、permissions(预设名或 {sandbox, approval})、flow(加入流程)、description(能力卡片);默认挂部署默认 agent preset 作为基线;mcp/modules 接受但本期降级(仅 warning);任一步失败回滚已创建会话 |

### 通道(按规模路由)

| 工具 | 规模 | 说明 |
|---|---|---|
| `send_note` | SMALL | 轻量消息;无记录无验收;目标离线时**入队补投**(返回 `queued: true`) |
| `create_task` | MEDIUM | 单任务:content + `dependencies?` + `acceptance_criteria?` + `flow_id?` + `reviewer?`;依赖未清 → 待投递自动排期 |
| `create_flow` | LARGE | 流程容器:先 plan 文档 → 拆任务建 DAG → 自动排期 + 失败传播 |

### 生命周期

| 工具 | 说明 |
|---|---|
| `report_task` | 执行方交差:working → completed(「待验收」),reviewer 被通知 |
| `settle_task` | 验收方判定:success 释放下游(自动派发依赖它的任务);failure 同 id 重做(retries++,反馈即修改意见) |
| `cancel_task` | 发起方取消(未结算);queued 任务静默取消;终态自动向下游传播 |
| `request_input` | 执行方暂停提问(working → input-required);发起方用 create_task 带 task_id 回答 |
| `answer_question` | 执行方任务中调用 dsh 官方 ask_user_question 时,问题转发给任务发起方;发起方用本工具回答(仅发起方可答) |
| `reassign_task` | 发起方转派:换执行者(重投递)/换验收者;id/历史/依赖/流程全保留 |
| `submit_handoff` | 结算任务的执行方为每个后向任务提交交接文档;投递时自动拼入下游内容 |

### 编辑与查询

| 工具 | 说明 |
|---|---|
| `edit_task` | 改未派发任务:依赖拓扑/内容/验收标准/流程归属 |
| `list_flows` | 流程目录:名称、任务数、未结算数、归档派生标记 |
| `list_tasks` | 活跃任务(inbox/outbox + status 过滤);归档自动不可见;待投递/待验收徽标 |
| `get_task` | 全量记录:内容、验收标准、交接文档、报告、判定、反馈、原因 |

## 状态机

```
创建 ──> queued(待投递) ──调度──> submitted(待执行) ──认领──> working(进行中)
            │                                                        │
            └────── settle failure(重做,同 id) ◄───── report ──> completed(待验收)
                                                                      │ settle success
                                                                      ▼
                                                                (结算完成,24h 后归档)

终态:failed(timeout / no-response / discarded / dependency-failed / dependency-canceled)
     canceled(发起方取消)   rejected(保留)
```

- **重做 = 同一任务回退**:id 全程不变,feedback 即修改意见,retries++。
- **失败传播**:依赖终态失败 → 下游递归自动 failed,无人工步骤。
- **三层收敛**:reminder(执行方 15 分钟提醒)→ offlineGrace(执行方离线 15 分钟,发起方决策)→ 超时(2h 兜底)。

## 流程模板

### 单任务(最简单)

```
create_task(target=二号, content="计算 5×7 并报告", acceptance_criteria="答案正确且附计算过程")
→ 二号执行 → report → 你 settle
```

### 接力链(结构化传递)

```
create_flow(name="数字接力", description="一号→二号→三号,每棒传值")
create_task(target=一号, flow_id=F, content="提供初始数字 d 并计算 d×2,report 时说明输出")
create_task(target=二号, flow_id=F, dependencies=[T1], content="基于上棒输出计算 (d×累计)%(d+1)")
create_task(target=三号, flow_id=F, dependencies=[T2], content="最终验收:汇总两棒结果")
→ T1 settle 后 T2 自动投递,T2 settle 后 T3 自动投递
→ 每棒 settle 后,执行方为后向任务 submit_handoff 传交接文档(数值/决策/注意事项)
→ 最后一棒 settle → 创建者收到全流程汇总
```

### 重做循环(质量把关)

```
settle failure(feedback="结果不正确,请重算") → 同一任务回 submitted → 执行方被唤醒重做 → 再 report
```

### 转派(执行者掉线)

```
reassign_task(task_id=T, new_executor=三号)          # 换执行者:任务重投给三号,旧执行者报告被拒
reassign_task(task_id=T, new_reviewer=三号)          # 换验收者:权限即时转移
reassign_task(task_id=T, new_executor=自己, new_reviewer=四号)  # 自我执行必须独立验收
```

## 配置(cordis.patch.yml)

| 键 | 默认 | 作用 |
|---|---|---|
| `maxContentLength` | 16000 | 内容字符上限,超限拒绝 |
| `maxPendingPerAgent` | 20 | 单个接收者未完成任务深度上限 |
| `maxSendsPerMinute` | 10 | 任务派发限流(每发送方/分钟) |
| `maxMessagesPerMinute` | 20 | 消息限流(独立窗口) |
| `taskTimeoutMs` | 7200000(2h) | working/input-required 超时转 failed |
| `offlineGraceMs` | 900000(15min) | 执行方离线超时 → 通知发起方决策 |
| `maxInlineReport` | 400 | 超长报告外置到报告存储 |

## 数据位置

| 数据 | 位置 |
|---|---|
| 任务/流程/交接文档/待投消息 | `~/.dsh/storages/agent_bus.json`(存储域 v10) |
| 备份快照 | `~/.dsh/agent-bus/backups/`(每次启动一份,保留 20) |
| 长报告 | `~/.dsh/agent-bus/{cache,archive}/` |
| 会话日志 | `~/.dsh/sessions/`(dsh 原生,zstd) |
