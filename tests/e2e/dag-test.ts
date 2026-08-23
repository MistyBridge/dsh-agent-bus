/**
 * DAG 链式自动派发 + 失败传播 e2e(verification.md §3)。
 *
 * 运行前置(需运行中的 dsh + 真实 live 会话,本脚本不做这些):
 *   dsh plugin --profile web add .      # 本地路径安装(软链到 checkout)
 *   dsh web                             # 启动,http://127.0.0.1:3080
 *   打开同工作区的 live 会话:initiator / executor1..3 / reviewer
 *   (timeout 失败模式还需在 cordis.patch.yml 配 taskTimeoutMs: 60000 后重启)
 *
 * 引导流程(工具调用由真实会话执行,脚本轮询台账等待可观测结果):
 *
 * 场景 A 链式自动派发:
 *   1. initiator 执行 create_flow(name 含 E2E_CHAIN_MARKER 或直接给 E2E_FLOW_ID);
 *   2. 依次创建 T1(target=executor1)、T2(target=executor2, flow_id=F,
 *      dependencies=[T1])、T3(target=executor3, flow_id=F, dependencies=[T2])
 *      ——脚本断言 T2/T3 创建即 queued、T1 已投递;
 *   3. reviewer 对 T1 settle success → 脚本等待 T2 自动投递(auto=true);
 *     再对 T2 settle success → 等待 T3 自动投递(auto=true)。全程无人工派发。
 *
 * 场景 B 失败传播(独立流程 E2E_FAIL_FLOW_ID):
 *   cancel 模式(默认):initiator 对根任务 cancel_task → 下游递归
 *     failed(reason=dependency-canceled),从未被派发。
 *   timeout 模式(E2E_FAILURE_MODE=timeout,需 taskTimeoutMs=60000):
 *     根任务无人认领 → 超时扫查转 failed(no-response)→ 下游递归
 *     failed(reason=dependency-failed),从未被派发。
 *
 * 说明:settle failure 是**重做**不是终态(同一 id 回退 submitted),不触发
 * 传播;终态失败来自 timeout/no-response 扫查或 cancel。timeout 模式验证的是
 * 传播语义中 dependency-failed 的分支。
 *
 * 环境变量:
 *   DSH_BASE_URL   - 运行中 dsh 地址(默认 http://127.0.0.1:3080)。
 *   E2E_FLOW_ID    - 链式场景的流程 id(优先,跳过等待)。
 *   E2E_CHAIN_MARKER - 链式流程名标记(未给 E2E_FLOW_ID 时用)。
 *   E2E_FAIL_FLOW_ID  - 失败场景的流程 id(优先)。
 *   E2E_FAIL_MARKER   - 失败场景流程名标记。
 *   E2E_FAILURE_MODE  - cancel(默认) | timeout。
 *   E2E_WAIT_MS    - 单个等待阶段超时(默认 600000;timeout 模式建议 120000)。
 */

import { pathToFileURL } from 'node:url'
import {
  BASE_URL,
  assert,
  fetchState,
  finish,
  guide,
  scenario,
  waitFor,
  type TaskView,
} from './helpers.ts'

const CHAIN_MARKER = process.env.E2E_CHAIN_MARKER ?? `e2e-dag-chain-${Date.now().toString(36)}`
const FAIL_MARKER = process.env.E2E_FAIL_MARKER ?? `e2e-dag-fail-${Date.now().toString(36)}`
const FAILURE_MODE = process.env.E2E_FAILURE_MODE === 'timeout' ? 'timeout' : 'cancel'

/** 某流程下按创建序排列的任务(快照即权威,创建序 = createdAt 升序)。 */
async function flowTasks(flowId: string): Promise<TaskView[]> {
  const snapshot = await fetchState()
  return snapshot.tasks
    .filter(task => task.flowId === flowId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/** 等待流程中的任务满足谓词;返回首个命中的任务。 */
async function waitForFlowTask(
  flowId: string,
  label: string,
  predicate: (task: TaskView, all: readonly TaskView[]) => boolean,
): Promise<TaskView> {
  return waitFor(label, async () => {
    const all = await flowTasks(flowId)
    return all.find(candidate => predicate(candidate, all))
  })
}

/** 等待流程任务齐备并返回创建序列表。 */
async function awaitFlowReady(flowId: string, minimum: number): Promise<TaskView[]> {
  await waitFor(`流程 ${flowId} 任务齐备(≥${minimum})`, async () => {
    const all = await flowTasks(flowId)
    return all.length >= minimum ? all : undefined
  })
  return flowTasks(flowId)
}

/** 发现流程 id:显式 id 优先,否则按流程名标记等待。 */
async function resolveFlowId(envValue: string | undefined, marker: string, kind: string): Promise<string> {
  if (envValue !== undefined) return envValue
  guide(`请让 initiator 执行 create_flow(name 含 "${marker}")并创建该流程的任务。`
    + `脚本将等待该流程出现。(${kind})`)
  const flowId = await waitFor('流程出现(标记发现)', async () => {
    const snapshot = await fetchState()
    return snapshot.flows.find(item => item.name.includes(marker))?.id
  })
  return flowId
}

async function chainScenario(): Promise<void> {
  const flowId = await resolveFlowId(process.env.E2E_FLOW_ID, CHAIN_MARKER, '链式')

  await scenario('链式:T2/T3 创建即 queued,T1 已投递', async () => {
    let tasks = await awaitFlowReady(flowId, 3)
    if (tasks.length < 3) {
      guide(`请确保流程 ${flowId} 下有三个任务:T1(target=executor1)、`
        + `T2(flow_id=F, dependencies=[T1])、T3(flow_id=F, dependencies=[T2])。脚本将等待。`)
      tasks = await awaitFlowReady(flowId, 3)
    }
    const [t1, t2, t3] = [tasks[0]!, tasks[1]!, tasks[2]!]
    assert(t1.status === 'submitted', `T1 应已投递(submitted),实为 ${t1.status}`)
    assert(t2.status === 'queued', `T2 创建即 queued,实为 ${t2.status}`)
    assert(t3.status === 'queued', `T3 创建即 queued,实为 ${t3.status}`)
    assert(t2.blockedBy.includes(t1.id), 'T2 应被 T1 阻塞')
    assert(t3.blockedBy.includes(t2.id), 'T3 应被 T2 阻塞')
  })

  await scenario('链式:T1 settle success → T2 自动投递(auto=true)', async () => {
    const t1 = (await awaitFlowReady(flowId, 3))[0]!
    guide(`请让 reviewer 对 ${t1.id}(T1)执行 settle_task(outcome=success)。`
      + `脚本将等待 T2 被调度器自动投递。`)
    const t2 = await waitForFlowTask(flowId, 'T2 自动投递',
      (_t, list) => list[1]?.status === 'submitted' && list[1]?.auto === true)
    assert(t2.auto === true, 'T2 应由调度器投递(auto=true),非人工派发')
  })

  await scenario('链式:T2 settle success → T3 自动投递(auto=true),全程无人工派发', async () => {
    const t2 = (await awaitFlowReady(flowId, 3))[1]!
    guide(`请让 reviewer 对 ${t2.id}(T2)执行 settle_task(outcome=success)。`
      + `脚本将等待 T3 被调度器自动投递。`)
    const t3 = await waitForFlowTask(flowId, 'T3 自动投递',
      (_t, list) => list[2]?.status === 'submitted' && list[2]?.auto === true)
    assert(t3.auto === true, 'T3 应由调度器投递(auto=true),非人工派发')
    const final = await flowTasks(flowId)
    assert(final[0]!.outcome === 'success', 'T1 应已验收成功')
    assert(final[1]!.outcome === 'success', 'T2 应已验收成功')
  })
}

async function failureScenario(): Promise<void> {
  const flowId = await resolveFlowId(process.env.E2E_FAIL_FLOW_ID, FAIL_MARKER, '失败')

  await scenario(`失败传播:根终态失败(${FAILURE_MODE})→ 下游递归 failed 且从未被派发`, async () => {
    let all = await awaitFlowReady(flowId, 2)
    if (all.length < 2) {
      guide(`请确保流程 ${flowId} 下有根任务 R1 与下游 R2(dependencies=[R1])。脚本将等待。`)
      all = await awaitFlowReady(flowId, 2)
    }
    const root = all[0]!
    const downstream = all.slice(1)
    const expectedReason = FAILURE_MODE === 'cancel' ? 'dependency-canceled' : 'dependency-failed'

    if (FAILURE_MODE === 'cancel') {
      guide(`请让 initiator 对根任务 ${root.id} 执行 cancel_task。`
        + `脚本将等待下游自动失败。`)
      await waitForFlowTask(flowId, '根任务已取消',
        (_t, list) => list[0]?.status === 'canceled')
    } else {
      guide(`timeout 模式:请勿认领根任务 ${root.id},等待超时扫查`
        + `(需 taskTimeoutMs=60000 配置)将其转 failed。脚本将等待。`)
      await waitForFlowTask(flowId, '根任务已失败(no-response)',
        (_t, list) => list[0]?.status === 'failed')
    }

    for (const task of downstream) {
      const failed = await waitForFlowTask(flowId, `下游 ${task.id} 自动失败`,
        (_t, list) => list.find(item => item.id === task.id)?.status === 'failed')
      assert(failed.reason === expectedReason,
        `下游 ${task.id} 的 reason 应为 ${expectedReason},实为 ${failed.reason}`)
      // 从未被派发:未投递(auto=false)且从未被认领(turn=null)。
      assert(failed.auto === false, `下游 ${task.id} 不得被派发(auto=false)`)
      assert(failed.turn === null, `下游 ${task.id} 不得被认领(turn=null)`)
    }
  })
}

async function main(): Promise<void> {
  console.log(`e2e: DAG 链式自动派发 + 失败传播 → ${BASE_URL}`)
  console.log(`链式标记: ${CHAIN_MARKER}  失败标记: ${FAIL_MARKER}  失败模式: ${FAILURE_MODE}`)
  console.log('前置:运行中的 dsh + 同工作区 live 会话(initiator/executor1..3/reviewer)。')

  await chainScenario()
  await failureScenario()

  finish()
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
