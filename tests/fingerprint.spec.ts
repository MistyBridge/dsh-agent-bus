/**
 * 决策 7 指纹检测单测（运行实例可更新提示）。
 *
 * 覆盖：parseDiskFingerprint（合法/非法 JSON、缺字段、空 id）、
 * readDiskFingerprint（文件缺失/损坏/合法）、isInstanceStale 三态
 * （一致 → false、不一致 → true、任一缺失 → 保守 false）与
 * staleMessage（当前 → null、过期 → 含双构建 id 的提示文案）。
 *
 * 保守约定：指纹缺失/不可读/id 为空一律视为「无证据」，不提示——
 * 提示不应误报，源码模式（未构建）运行也不应告警。
 */

import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILD_FINGERPRINT } from '../src/build-fingerprint.ts'
import {
  isBuildFingerprint,
  isInstanceStale,
  parseDiskFingerprint,
  readDiskFingerprint,
  staleMessage,
  type BuildFingerprint,
} from '../src/fingerprint.ts'

/** 一个带真实 id 的合法指纹。 */
function fingerprint(overrides: Partial<BuildFingerprint> = {}): BuildFingerprint {
  return { id: 'abc123', buildTime: '2026-08-01T00:00:00.000Z', gitCommit: 'deadbee', ...overrides }
}

describe('isBuildFingerprint', () => {
  it('accepts an object with a non-empty string id', () => {
    expect(isBuildFingerprint(fingerprint())).toBe(true)
  })

  it('rejects non-objects', () => {
    expect(isBuildFingerprint(null)).toBe(false)
    expect(isBuildFingerprint(undefined)).toBe(false)
    expect(isBuildFingerprint('abc123')).toBe(false)
    expect(isBuildFingerprint(42)).toBe(false)
  })

  it('rejects a missing or empty id', () => {
    expect(isBuildFingerprint({ id: undefined, buildTime: null, gitCommit: null })).toBe(false)
    expect(isBuildFingerprint(fingerprint({ id: '' }))).toBe(false)
    expect(isBuildFingerprint(fingerprint({ id: null }))).toBe(false)
  })
})

describe('parseDiskFingerprint', () => {
  it('parses a valid fingerprint with every field', () => {
    expect(parseDiskFingerprint(JSON.stringify(fingerprint()))).toEqual(fingerprint())
  })

  it('tolerates missing optional metadata (buildTime / gitCommit)', () => {
    expect(parseDiskFingerprint('{"id":"abc123"}')).toEqual({
      id: 'abc123',
      buildTime: null,
      gitCommit: null,
    })
  })

  it('returns null for invalid JSON text', () => {
    expect(parseDiskFingerprint('not json')).toBeNull()
    expect(parseDiskFingerprint('')).toBeNull()
  })

  it('returns null when the id is absent or unusable', () => {
    expect(parseDiskFingerprint('{"buildTime":"x"}')).toBeNull()
    expect(parseDiskFingerprint('{"id":""}')).toBeNull()
    expect(parseDiskFingerprint('{"id":null}')).toBeNull()
    expect(parseDiskFingerprint('{"id":42}')).toBeNull()
  })

  it('returns null for JSON that is not an object', () => {
    expect(parseDiskFingerprint('["abc123"]')).toBeNull()
    expect(parseDiskFingerprint('"abc123"')).toBeNull()
  })
})

describe('readDiskFingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agent-bus-fp-'))
  const path = (name: string): string => join(dir, name)

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the file is missing', () => {
    expect(readDiskFingerprint(path('missing.json'))).toBeNull()
  })

  it('reads a valid fingerprint file', () => {
    writeFileSync(path('valid.json'), JSON.stringify(fingerprint({ id: 'disk-id' })))
    expect(readDiskFingerprint(path('valid.json'))).toMatchObject({ id: 'disk-id' })
  })

  it('returns null for a corrupted file', () => {
    writeFileSync(path('corrupt.json'), '{"id": ')
    expect(readDiskFingerprint(path('corrupt.json'))).toBeNull()
  })

  it('returns null for an empty file', () => {
    writeFileSync(path('empty.json'), '')
    expect(readDiskFingerprint(path('empty.json'))).toBeNull()
  })
})

describe('isInstanceStale', () => {
  it('is false when both sides carry the same id (一致)', () => {
    const loaded = fingerprint({ id: 'same' })
    expect(isInstanceStale(loaded, fingerprint({ id: 'same' }))).toBe(false)
  })

  it('is true when the disk id differs from the loaded id (不一致)', () => {
    const loaded = fingerprint({ id: 'loaded' })
    expect(isInstanceStale(loaded, fingerprint({ id: 'disk' }))).toBe(true)
  })

  it('ignores buildTime: a no-op rebuild with the same id is not stale', () => {
    const loaded = fingerprint({ id: 'same', buildTime: '2026-08-01T00:00:00.000Z' })
    expect(isInstanceStale(loaded, fingerprint({ id: 'same', buildTime: '2026-08-02T00:00:00.000Z' }))).toBe(false)
  })

  it('is conservatively false when the disk fingerprint is missing (缺失)', () => {
    expect(isInstanceStale(fingerprint(), null)).toBe(false)
  })

  it('is conservatively false when the loaded fingerprint is unknown', () => {
    expect(isInstanceStale(fingerprint({ id: null }), fingerprint())).toBe(false)
    expect(isInstanceStale(null, fingerprint())).toBe(false)
  })

  it('is false when both sides are missing', () => {
    expect(isInstanceStale(null, null)).toBe(false)
  })

  it('never flags the committed stub against itself', () => {
    expect(isInstanceStale(BUILD_FINGERPRINT, BUILD_FINGERPRINT)).toBe(false)
  })
})

describe('staleMessage', () => {
  it('is null when the instance is current', () => {
    const loaded = fingerprint({ id: 'same' })
    expect(staleMessage(loaded, fingerprint({ id: 'same' }))).toBeNull()
  })

  it('is null when either side is missing', () => {
    expect(staleMessage(fingerprint(), null)).toBeNull()
    expect(staleMessage(null, fingerprint())).toBeNull()
  })

  it('names both build ids when stale', () => {
    const message = staleMessage(fingerprint({ id: 'loaded' }), fingerprint({ id: 'disk' }))
    expect(message).toContain('需重启生效')
    expect(message).toContain('loaded')
    expect(message).toContain('disk')
  })

  it('includes the disk git commit when available', () => {
    const message = staleMessage(
      fingerprint({ id: 'loaded' }),
      fingerprint({ id: 'disk', gitCommit: 'abc1234' }),
    )
    expect(message).toContain('commit abc1234')
  })
})
