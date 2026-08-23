/**
 * 三方生命周期 e2e(verification.md §3):派发 → 执行 → report → 验收,
 * 负向:非 reviewer(含发起方)不能 settle 自己派的任务。
 *
 * 运行前置(需运行中的 dsh + 真实 live 会话,本脚本不做这些):
 *   dsh plugin --profile web add .      # 本地路径安装(软链到 checkout)
 *   dsh web                             # 启动,http://127.0.0.1:3080
 *   打开三个同工作区的 live 会话:initiator / executor / reviewer
 *   (会话 id 从 list_peers 或 GET /plugins/dsh-agent-bus/state 的 sessions 读取)
 *
 * 引导流程(工具调用由真实会话执行,脚本轮询台账等待可观测结果):
 *   1. initiator 执行 create_task(target=executor, reviewer=<独立 reviewer>,
 *      content 含 E2E_MARKER 或直接给 E2E_TASK_ID)——脚本等待任务出现并断言
 *      「已投递待执行」(submitted)。
 *   2. executor 执行任务后 report_task——脚本等待「待验收」(completed 无 outcome),
 *      并断言台账尚未出现 outcome。
 *   3. 负向(引导):让发起方或执行方对同一任务尝试 settle_task,预期被拒
 *      "only the task's reviewer may settle task <id>";工具拒绝发生在会话
 *      侧,HTTP 无法观测,脚本改为断言台账不变量:任何非 reviewer 的 settle
 *      尝试都不留痕迹——任务仍是 completed 且无 outcome。
 *   4. reviewer 执行 settle_task(task_id, outcome=success)——脚本等待台账
 *      出现 outcome=success,断言「完成后台账出现 outcome」。
 *
 * 环境变量:
 *   DSH_BASE_URL - 运行中 dsh 地址(默认 http://127.0.0.1:3080)。
 *   E2E_TASK_ID  - 已创建的任务 id(优先,跳过等待)。
 *   E2E_MARKER   - 任务内容/标题中的标记(未给 E2E_TASK_ID 时用)。
 *   E2E_WAIT_MS  - 单个等待阶段超时(默认 600000)。
 *
 * 已知限制:工具调用的拒绝文案只在会话侧可见,本脚本通过台账不变量与
 * 静态断言覆盖该语义(见步骤 3);如需要拒绝文案的逐字断言,请在会话日志中核对。
 */

import { pathToFileURL } from 'node:url'
import {
  BASE_URL,
  assert,
  fetchState,
  finish,
  guide,
  scenario,
  taskOf,
  waitForTask,
} from './helpers.ts'

const MARKER = process.env.E2E_MARKER ?? `e2e-abc-${Date.now().toString(36)}`

async function main(): Promise<void> {
  console.log(`e2e: abc 三方生命周期 → ${BASE_URL}`)
  console.log(`标记: ${MARKER}`)
  console.log('前置:运行中的 dsh + initiator/executor/reviewer 三个同工作区 live 会话。')

  // 解析目标任务 id:显式 id 优先,否则等待含标记的任务出现。
  let taskId = process.env.E2E_TASK_ID
  if (taskId === undefined) {
    guide(`请让 initiator 执行 create_task(target=executor, reviewer=<独立 reviewer>, `
      + `content 含标记 "${MARKER}")。脚本将等待该任务出现。`)
    const created = await waitForTask('任务出现(标记发现)', task =>
      (task.title ?? task.content).includes(MARKER))
    taskId = created.id
  }

  await scenario('任务被创建并投递(submitted)', async () => {
    const task = await waitForTask('任务进入 submitted(待执行)',
      candidate => candidate.id === taskId && candidate.status === 'submitted')
    assert(task.assignedBy !== task.assignedTo, '发起方与执行方不应相同')
  })

  await scenario('执行方 report 后进入待验收(completed 无 outcome)', async () => {
    const task = await waitForTask('任务进入 completed(待验收)',
      candidate => candidate.id === taskId && candidate.status === 'completed')
    assert(task.outcome === null, '台账在验收前不得出现 outcome')
  })

  await scenario('负向:非 reviewer 的 settle 被拒且不留台账痕迹', async () => {
    const snapshot = await fetchState()
    const task = taskOf(snapshot, taskId)
    const reviewer = task.assignedReviewer ?? task.assignedBy
    assert(reviewer !== '', '任务必须存在可识别的 reviewer')
    guide(`请让非 reviewer 会话(发起方或执行方)对任务 ${task.id} 尝试 `
      + `settle_task(outcome=success),预期被拒:`
      + `only the task's reviewer may settle task "${task.id}"。`
      + `脚本将断言台账不变量:任务保持 completed 且无 outcome。`)
    const after = await fetchState()
    const still = taskOf(after, task.id)
    assert(still.status === 'completed', '任务状态不得因非 reviewer 的 settle 改变')
    assert(still.outcome === null, '台账不得出现非 reviewer 写入的 outcome')
  })

  await scenario('reviewer 验收后台账出现 outcome=success', async () => {
    guide(`请让 reviewer 对任务 ${taskId} 执行 settle_task(outcome=success)。`
      + `脚本将等待台账出现 outcome。`)
    const task = await waitForTask('台账出现 outcome=success',
      candidate => candidate.id === taskId && candidate.outcome === 'success')
    assert(task.settled, '验收后任务应标记 settled')
  })

  finish()
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
