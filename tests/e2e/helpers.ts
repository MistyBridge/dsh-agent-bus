/**
 * e2e 共享驱动层:agent-bus 面板/派发端点的 HTTP 客户端、轮询、断言与
 * 场景运行器。两个 e2e 脚本(abc-test.ts / dag-test.ts)共用。
 *
 * 脚本以 `node --import tsx tests/e2e/<file>.ts`(dsh-agent-bus 目录)运行,
 * 驱动运行中的 dsh(需真实 live 会话,见各脚本头注释的启动步骤)。本层只做
 * 可观测断言:任务/流程/会话/统计经 GET /plugins/dsh-agent-bus/state 读取,
 * 派发经 POST /plugins/dsh-agent-bus/dispatch(幂等)触发;工具调用
 * (create_task / report_task / settle_task / cancel_task)由真实会话执行,
 * 脚本轮询等待其可观测结果。
 *
 * 环境变量:
 * - DSH_BASE_URL  - 运行中 dsh 的地址(默认 http://127.0.0.1:3080)。
 * - E2E_WAIT_MS   - 单个等待阶段的超时(默认 600000,10 分钟)。
 * - E2E_POLL_MS   - 轮询间隔(默认 500ms)。
 *
 * @module
 */

/** 运行中 dsh 的基地址。 */
export const BASE_URL = process.env.DSH_BASE_URL ?? 'http://127.0.0.1:3080'

/** 单个等待阶段的超时。 */
export const WAIT_MS = Number(process.env.E2E_WAIT_MS ?? 600_000)

/** 轮询间隔。 */
export const POLL_MS = Number(process.env.E2E_POLL_MS ?? 500)

/** 面板快照中一行任务的可观测面(与 src/panel.ts 的 TaskView 对齐)。 */
export interface TaskView {
  readonly id: string
  readonly status: string
  readonly settled: boolean
  readonly auto: boolean
  readonly turn: number | null
  readonly reason: string | null
  readonly outcome: string | null
  readonly dependencies: readonly string[]
  readonly dependents: readonly string[]
  readonly blockedBy: readonly string[]
  readonly flowId: string | null
  readonly content: string
  readonly title: string | null
  readonly assignedBy: string
  readonly assignedTo: string | null
  readonly assignedReviewer: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 面板快照(与 PanelSnapshot 对齐的字段子集)。 */
export interface Snapshot {
  readonly tasks: readonly TaskView[]
  readonly flows: readonly { id: string; name: string; archived: boolean }[]
  readonly sessions: readonly { id: string; title: string; live: boolean }[]
  readonly stats: { readonly total: number }
}

/** 读一次面板快照;非 200 或 JSON 畸形即抛错。 */
export async function fetchState(): Promise<Snapshot> {
  const response = await fetch(`${BASE_URL}/plugins/dsh-agent-bus/state`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`state endpoint returned HTTP ${response.status}`)
  }
  return await response.json() as Snapshot
}

/** POST /dispatch:对 queued 任务触发一次幂等派发。 */
export async function postDispatch(taskId: string): Promise<{ dispatched: boolean; status: string }> {
  const response = await fetch(`${BASE_URL}/plugins/dsh-agent-bus/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId }),
  })
  if (!response.ok) {
    throw new Error(`dispatch endpoint returned HTTP ${response.status}`)
  }
  return await response.json() as { dispatched: boolean; status: string }
}

/** 断言;失败抛错,由场景运行器汇总。 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * 轮询等待 probe 返回非 undefined 的值;超时抛错。
 *
 * @param label - 等待阶段的描述。
 * @param probe - 每次轮询的探针;返回 undefined 表示尚未满足。
 * @param timeoutMs - 超时(默认 E2E_WAIT_MS)。
 */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(POLL_MS)
  }
  throw new Error(`timeout waiting for: ${label} (${Math.round(timeoutMs / 1000)}s)`)
}

/** 等待直至快照中出现满足谓词的任务并返回它。 */
export async function waitForTask(
  label: string,
  predicate: (task: TaskView) => boolean,
  timeoutMs: number = WAIT_MS,
): Promise<TaskView> {
  return waitFor(label, async () => {
    const snapshot = await fetchState()
    return snapshot.tasks.find(predicate)
  }, timeoutMs)
}

/** 读取快照中的一行任务。 */
export function taskOf(snapshot: Snapshot, id: string): TaskView {
  const task = snapshot.tasks.find(item => item.id === id)
  if (task === undefined) throw new Error(`task "${id}" is not in the snapshot`)
  return task
}

/** 按内容/标题标记发现任务(引导式 e2e 的默认发现方式)。 */
export function findByMarker(snapshot: Snapshot, marker: string): TaskView | undefined {
  return snapshot.tasks.find(task =>
    (task.title ?? '').includes(marker) || task.content.includes(marker))
}

/** 睡眠。 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 场景失败收集器;finish() 决定进程退出码。 */
const failures: string[] = []

/** 跑一个命名场景;失败记录但不中断后续场景。 */
export async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.error(`FAIL ${name}: ${message}`)
  }
}

/** 汇总并设置退出码:有失败退出 1,全过退出 0。 */
export function finish(): void {
  if (failures.length > 0) {
    console.error(`\n${failures.length} scenario(s) failed:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('\nall e2e scenarios passed')
    process.exitCode = 0
  }
}

/** 打印一条需要操作员/会话执行的引导指令。 */
export function guide(text: string): void {
  console.log(`\n[引导] ${text}`)
}
