/**
 * External report storage with hot/cold partitioning.
 *
 * Oversized reports live on disk, keyed by task id, in one of two zones:
 *
 * - **hot** (`cache/`): reports of active tasks (`submitted` / `working` /
 *   `input-required`) and recent terminals; pruned after
 *   {@link HOT_IDLE_MS} of no access.
 * - **cold** (`archive/`): reports of terminal tasks, moved here the moment
 *   a task reaches `completed` (settled), `failed`, or `canceled`; pruned
 *   after {@link COLD_IDLE_MS} — the archive is the long-lived record.
 *
 * The ledger row carries a bounded inline summary plus a `reportRef`; the
 * reference is the task id, never a path. get_task reads back through
 * {@link ReportStore.read}, which checks the hot zone first and falls back
 * to the cold zone, so the model never sees the zone split.
 *
 * @module dsh-agent-bus/external
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskId } from './domain/types.ts'

/** Hot-zone files untouched for this long are swept (7 days). */
export const HOT_IDLE_MS = 7 * 24 * 60 * 60 * 1000

/** Cold-zone files untouched for this long are swept (30 days). */
export const COLD_IDLE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Two-zone report storage.
 */
export class ReportStore {
  /**
   * @param hotRoot - directory for active-task reports (`cache/`).
   * @param coldRoot - directory for terminal-task reports (`archive/`).
   */
  constructor(
    private readonly hotRoot: string,
    private readonly coldRoot: string,
  ) {}

  /**
   * Persist one report body into the hot zone.
   *
   * @param taskId - the owning task; also the reference.
   * @param content - the full report text.
   * @returns the reference stored on the ledger row.
   */
  async save(taskId: TaskId, content: string): Promise<string> {
    await mkdir(this.hotRoot, { recursive: true })
    await writeFile(join(this.hotRoot, `${taskId}.md`), content, 'utf8')
    return taskId
  }

  /**
   * Move one report from the hot zone to the cold zone.
   *
   * Called when a task reaches a terminal state; the reference does not
   * change, so ledger rows stay untouched.
   *
   * @param taskId - the reference to archive.
   */
  async archive(taskId: string): Promise<void> {
    const hot = join(this.hotRoot, `${taskId}.md`)
    try {
      await mkdir(this.coldRoot, { recursive: true })
      await rename(hot, join(this.coldRoot, `${taskId}.md`))
    } catch {
      // Absent hot file means nothing to archive; the cold zone may already
      // hold it (re-archive is a no-op).
    }
  }

  /**
   * Read a report back by its reference: hot zone first, cold zone second.
   *
   * @param ref - the reference stored on the ledger row.
   * @returns the full text, or `undefined` when the file is missing.
   */
  async read(ref: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.hotRoot, `${ref}.md`), 'utf8')
    } catch {
      // Fall through to the cold zone.
    }
    try {
      return await readFile(join(this.coldRoot, `${ref}.md`), 'utf8')
    } catch {
      return undefined
    }
  }

  /**
   * Whether a report file exists in the hot zone. A missing zone root reads
   * as an empty zone, never an error.
   *
   * @param ref - the report reference (the task id).
   * @returns `true` when the hot-zone file exists.
   */
  async existsHot(ref: string): Promise<boolean> {
    try {
      await stat(join(this.hotRoot, `${ref}.md`))
      return true
    } catch {
      return false
    }
  }

  /**
   * Whether a report file exists in the cold zone, same tolerance as
   * {@link existsHot}.
   *
   * @param ref - the report reference (the task id).
   * @returns `true` when the cold-zone file exists.
   */
  async existsCold(ref: string): Promise<boolean> {
    try {
      await stat(join(this.coldRoot, `${ref}.md`))
      return true
    } catch {
      return false
    }
  }

  /**
   * Sweep both zones: remove files untouched for the zone's idle window.
   *
   * @returns the number of removed files.
   */
  async sweep(): Promise<number> {
    const hotCutoff = Date.now() - HOT_IDLE_MS
    const coldCutoff = Date.now() - COLD_IDLE_MS
    let removed = 0
    removed += await this.sweepZone(this.hotRoot, hotCutoff)
    removed += await this.sweepZone(this.coldRoot, coldCutoff)
    return removed
  }

  private async sweepZone(root: string, cutoff: number): Promise<number> {
    let removed = 0
    try {
      for (const entry of await readdir(root)) {
        if (!entry.endsWith('.md')) continue
        const file = join(root, entry)
        const info = await stat(file).catch(() => undefined)
        if (info !== undefined && info.mtimeMs > cutoff) continue
        await rm(file, { force: true })
        removed += 1
      }
    } catch {
      // Missing zone root is an empty zone.
    }
    return removed
  }
}
