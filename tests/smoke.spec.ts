/**
 * 测试基座冒烟：打开 ledger → 创建任务 → 读回 → 走一条合法状态迁移，
 * 证明 memory-ctx helper 的接线端到端可用。详细状态机/校验/DAG 语义
 * 属于后续 ledger/panel 等 spec 套件。
 */

import { describe, expect, it } from 'vitest'
import {
  MemoryMediaPool,
} from '../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { TaskLedger } from '../src/ledger/ledger.ts'
import { TaskId } from '../src/domain/types.ts'
import {
  SESSION_B,
  createMemoryCtx,
  makeNewTask,
  openLedger,
} from './helpers/memory-ctx.ts'

describe('agent-bus test base smoke', () => {
  it('opens the ledger, records a task, reads it back, and walks one legal transition', async () => {
    const ledger = await openLedger()

    const created = await ledger.record(makeNewTask({ id: TaskId('smoke-1'), title: 'Smoke task' }), 8)
    if (!created.ok) throw new Error(`record refused: ${created.message}`)

    const read = ledger.get(created.task.id)
    expect(read?.status).toBe('submitted')
    expect(read?.title).toBe('Smoke task')
    expect(read?.assignedTo).toBe(SESSION_B)

    const moved = await ledger.transition(created.task.id, 'working')
    if (!moved.ok) throw new Error(`transition refused: ${moved.message}`)
    expect(moved.task.status).toBe('working')
    expect(ledger.get(created.task.id)?.status).toBe('working')
  })

  it('dispose closes the domain and a fresh harness reopens the same pool', async () => {
    const pool = new MemoryMediaPool()

    const first = await createMemoryCtx(pool)
    const ledger = await TaskLedger.open(first.ctx)
    const created = await ledger.record(makeNewTask({
      id: TaskId('restart-1'),
      messageId: 'msg-restart-1',
    }), 8)
    if (!created.ok) throw new Error(`record refused: ${created.message}`)
    await first.dispose()

    // 同一介质池上重启：行仍可读，携带 messageId 的 submitted 行不被迁移。
    const second = await createMemoryCtx(pool)
    const reopened = await TaskLedger.open(second.ctx)
    expect(reopened.get(TaskId('restart-1'))?.status).toBe('submitted')
    await second.dispose()
  })
})
