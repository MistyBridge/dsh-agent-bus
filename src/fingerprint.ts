/**
 * Build fingerprint (decision 7): how the plugin tells the code it is running
 * from the code last built on disk.
 *
 * Every `pnpm build` writes two artifacts carrying the same identity:
 *
 * - `lib/build-fingerprint.json` — the disk fingerprint, read once at startup.
 * - `src/build-fingerprint.ts` — a generated module baked INTO the compiled
 *   output; this is the loaded code's own identity.
 *
 * The identity `id` is a content digest over the build inputs (sources,
 * configs, package.json, git HEAD when available), so a rebuild with
 * unchanged inputs yields the same id and never false-positives a stale
 * instance. `buildTime` is metadata only and never compared.
 *
 * Staleness is a pure comparison: when the loaded id differs from the disk
 * id, the running process predates the latest build and keeps serving old
 * behavior until restarted. Missing or unreadable fingerprints are treated
 * conservatively as NOT stale — a hint must never be a false alarm, and
 * source-mode runs (no build) must not alarm either.
 *
 * @module dsh-agent-bus/fingerprint
 */

import { readFileSync } from 'node:fs'

/** Build identity of one build, as recorded on disk and baked into code. */
export interface BuildFingerprint {
  /** Content digest of build inputs; stable across no-op rebuilds. */
  readonly id: string | null
  /** ISO build timestamp; metadata only, never compared. */
  readonly buildTime: string | null
  /** Short git HEAD at build time; null when not a git checkout. */
  readonly gitCommit: string | null
}

/** Whether a value has the fingerprint shape with a usable id. */
export function isBuildFingerprint(value: unknown): value is BuildFingerprint {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id !== ''
}

/**
 * Parse a fingerprint file's text.
 *
 * @param text - raw file content.
 * @returns the fingerprint, or `null` when the text is not a valid
 *   fingerprint JSON (missing, empty id, or wrong shape) — the conservative
 *   "no evidence" state.
 */
export function parseDiskFingerprint(text: string): BuildFingerprint | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (!isBuildFingerprint(parsed)) return null
  return {
    id: parsed.id,
    buildTime: typeof parsed.buildTime === 'string' ? parsed.buildTime : null,
    gitCommit: typeof parsed.gitCommit === 'string' ? parsed.gitCommit : null,
  }
}

/**
 * Read the disk fingerprint from a JSON file path.
 *
 * @param path - absolute path of `build-fingerprint.json`.
 * @returns the fingerprint, or `null` when the file is missing, unreadable,
 *   or invalid — the conservative "no evidence" state.
 */
export function readDiskFingerprint(path: string): BuildFingerprint | null {
  try {
    return parseDiskFingerprint(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Whether the running instance predates the code on disk. Conservative:
 * either side missing or unknown (null id) is NOT stale.
 *
 * @param loaded - the fingerprint baked into the running code.
 * @param disk - the fingerprint read from disk at startup.
 * @returns `true` only when both sides carry a real id and the ids differ.
 */
export function isInstanceStale(
  loaded: BuildFingerprint | null,
  disk: BuildFingerprint | null,
): boolean {
  if (loaded === null || disk === null) return false
  if (loaded.id === null || disk.id === null) return false
  return loaded.id !== disk.id
}

/**
 * The user-facing explanation for a stale instance.
 *
 * @param loaded - the fingerprint baked into the running code.
 * @param disk - the fingerprint read from disk at startup.
 * @returns a message naming both build ids when stale, `null` when current.
 */
export function staleMessage(
  loaded: BuildFingerprint | null,
  disk: BuildFingerprint | null,
): string | null {
  if (!isInstanceStale(loaded, disk)) return null
  if (loaded === null || disk === null || loaded.id === null || disk.id === null) return null
  const diskSuffix = disk.gitCommit === null ? '' : `,commit ${disk.gitCommit}`
  return `代码已更新,需重启生效(运行构建 ${loaded.id} → 磁盘构建 ${disk.id}${diskSuffix})`
}
