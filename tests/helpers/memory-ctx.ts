/**
 * dsh-agent-bus 单元测试共享基座：构造一个绑定了 storageDomain 的最小
 * cordis Context，域数据落在内存后端上，可直接 `TaskLedger.open(ctx)`。
 *
 * 为什么用 storage-hub 垫片而不是真实 Storage 插件：`@deepseek-ai/dsh-storage`
 * 未声明在 dsh-agent-bus/package.json 里，strict pnpm node_modules 下无法
 * 从本包测试解析它。harness 自带的 MemoryStorageBackend 测试助手可以解析
 * （它自身的 `@deepseek-ai/dsh-storage` 导入从 storage-domain 自己的
 * node_modules 解析），所以后端复用真实测试替身，只有 hub 门面
 * （backend 注册表 + mount/form）在本文件按 DomainFacility 实际消费的
 * 最小面复制。为它补 devDependency 并重装会搅动工作区 lockfile，无行为收益。
 *
 * vitest 会自动设置 NODE_ENV=test，`TaskLedger.open` 因此跳过备份快照
 * （src/ledger.ts），打开全程纯内存。
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MemoryMediaPool,
  MemoryStorageBackend,
} from '../../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { TaskLedger, type NewTask } from '../../src/ledger.ts'
import { TaskId, type FlowRecord, type TaskRecord } from '../../src/types.ts'

/** 冒烟与后续用例共享的固定会话/工作区标识。 */
export const SESSION_A = SessionId('session-a')
export const SESSION_B = SessionId('session-b')
export const SESSION_REVIEWER = SessionId('session-reviewer')
export const WORKSPACE = '/workspace'

/** StorageBackend 契约的结构化最小面（真实 MemoryStorageBackend 满足它）。 */
export interface MinimalBackend {
  readonly kv?: {
    open(descriptor: {
      readonly name: string
      readonly version: number
      readonly tables: readonly string[]
      readonly hasGlobal: boolean
    }): Promise<{
      loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
      putRecord(table: string, key: string, value: unknown): Promise<void>
      deleteRecord(table: string, key: string): Promise<void>
      setGlobal(value: unknown): Promise<void>
      close(): Promise<void>
    }>
  }
  close(): Promise<void>
}

/**
 * 最小 storage hub 垫片：`backend` 注册表 + `mount`/`form`，覆盖
 * DomainFacility 构造与 open 实际用到的面。以 `ctx.provide('storage', ...)`
 * 注入，`ctx.storage` 的类型仍按真实 Storage 服务参与检查。
 */
class StorageHubShim {
  private readonly backends = new Map<string, MinimalBackend>()
  private readonly forms = new Map<string, unknown>()

  readonly backend = {
    register: (name: string, backend: MinimalBackend): (() => void) => {
      this.backends.set(name, backend)
      return () => {
        if (this.backends.get(name) === backend) this.backends.delete(name)
      }
    },
    get: (name: string): MinimalBackend => {
      const backend = this.backends.get(name)
      if (backend === undefined) {
        throw new Error(`storage backend '${name}' is not registered`)
      }
      return backend
    },
    names: (): string[] => [...this.backends.keys()],
  }

  mount(form: string, facility: unknown): () => void {
    this.forms.set(form, facility)
    return () => {
      if (this.forms.get(form) === facility) this.forms.delete(form)
    }
  }

  form(form: string): unknown {
    const facility = this.forms.get(form)
    if (facility === undefined) {
      throw new Error(`storage form '${form}' is not mounted`)
    }
    return facility
  }
}

/** 一个就绪的测试基座：ctx、storageDomain facility、内存后端与介质池。 */
export interface LedgerContext {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly backend: MemoryStorageBackend
  readonly pool: MemoryMediaPool
  /**
   * 关闭 ledger 域并释放后端。幂等；同一介质池可被下一个基座重新打开
   * （模拟进程重启）。
   */
  dispose(): Promise<void>
}

/**
 * 构造绑定了 storageDomain 的最小 cordis Context。
 *
 * @param pool - 共享介质池；缺省时新建独立池（每次调用互不相通）。
 * @returns 就绪的基座，未打开任何域。
 */
export async function createMemoryCtx(pool?: MemoryMediaPool): Promise<LedgerContext> {
  const ctx = new Context()
  ctx.provide('storage', new StorageHubShim() as never)
  const backend = new MemoryStorageBackend(pool ?? new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const owned = backend.pool
  return {
    ctx,
    facility,
    backend,
    pool: owned,
    dispose: async () => {
      const domain = facility.get('agent_bus')
      if (domain !== undefined) await (domain as unknown as { close(): Promise<void> }).close()
      await backend.close()
    },
  }
}

/**
 * 打开 ledger：创建独立基座并 `TaskLedger.open(ctx)`。
 *
 * @param pool - 共享介质池；缺省新建独立池。
 * @returns 已打开的 ledger。需要介质池/清理时改用
 *   {@link createMemoryCtx} + `TaskLedger.open(ctx)`。
 */
export async function openLedger(pool?: MemoryMediaPool): Promise<TaskLedger> {
  const harness = await createMemoryCtx(pool)
  return TaskLedger.open(harness.ctx)
}

/** 最小合法的新任务录入意图（ledger.record 的入参）。 */
export function makeNewTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    id: TaskId('task-1'),
    assignedBy: SESSION_A,
    assignedTo: SESSION_B,
    workspacePath: WORKSPACE,
    content: 'do the thing',
    title: 'Do the thing',
    mode: 'followup',
    retries: 0,
    ...overrides,
  }
}

/** 最小合法的任务行（TaskRecord，含时间戳）。 */
export function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: TaskId('task-1'),
    assignedBy: SESSION_A,
    assignedTo: SESSION_B,
    workspacePath: WORKSPACE,
    content: 'do the thing',
    title: 'Do the thing',
    status: 'submitted',
    mode: 'followup',
    retries: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 最小合法的流程行（FlowRecord）。 */
export function makeFlow(overrides: Partial<FlowRecord> = {}): FlowRecord {
  return {
    id: 'flow-1',
    name: 'Test flow',
    createdBy: SESSION_A,
    workspacePath: WORKSPACE,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}
