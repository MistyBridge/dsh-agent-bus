/**
 * Workbench: capsule → 3×3 launcher → sticky-note feature windows.
 * The existing task list is the first feature window.
 *
 * Styles live in TaskPanel.module.css. This pipeline compiles client sources
 * through tsc then tsdown (no lightningcss CSS-modules plugin), so the sheet
 * is injected as a tagged <style> and class names stay the authored `abP*`
 * locals. Keep the two copies in lockstep.
 *
 * @module dsh-agent-bus/client/TaskPanel
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { IconChevronDownOutline14, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import {
  emptySnapshot,
  formatTokenUsage,
  hasUnreadableTokens,
  callSteps,
  tokensForSession,
  archiveAgents,
  activeTabTasks,
  archiveTabTasks,
  relativeTime,
  sessionsOfWorkspace,
  sortActive,
  sortArchived,
  statusLabel,
  statusTone,
  tasksOfSession,
  tasksOfWorkspace,
  flowsOfWorkspace,
  blockedByOf,
  type PanelSnapshot,
  type TaskView,
  type TokenBuckets,
  type WorkspaceView,
} from './panel-model.ts'
import { DagView } from './DagView.tsx'

const STATE_PATH = '/plugins/dsh-agent-bus/state'
const EVENTS_PATH = '/plugins/dsh-agent-bus/events'
const DISPATCH_PATH = '/plugins/dsh-agent-bus/dispatch'
const ARCHIVE_PATH = '/plugins/dsh-agent-bus/archive'
const FLOW_KEY = 'dsh-agent-bus.dag.flow'
const STORAGE_KEY = 'dsh-agent-bus.workspace'
const SIDEBAR_KEY = 'dsh-agent-bus.sidebar-width'
const SIDEBAR_MIN = 128
const SIDEBAR_MAX = 280
const SIDEBAR_DEFAULT = 160
const TASK_NOTE_KEY = 'dsh-agent-bus.note.tasks'
const DAG_NOTE_KEY = 'dsh-agent-bus.note.dag'
const NOTE_MIN_W = 360
const NOTE_MIN_H = 320
const STALE_DISMISS_KEY = 'dsh-agent-bus.stale-dismissed'
const RECOVERY_DISMISS_KEY = 'dsh-agent-bus.recovery-dismissed'
const POLL_MS = 2000
const STYLE_ID = 'dsh-agent-bus-panel-styles'

type FeatureId = 'tasks' | 'dag'

const LAUNCHER_TILES: readonly {
  id: FeatureId | `soon-${number}`
  label: string
  mark: string
  ready: boolean
}[] = [
  { id: 'tasks', label: '任务', mark: '任', ready: true },
  { id: 'dag', label: '流程', mark: '流', ready: true },
  { id: 'soon-1', label: '预留', mark: '+', ready: false },
  { id: 'soon-2', label: '预留', mark: '+', ready: false },
  { id: 'soon-3', label: '预留', mark: '+', ready: false },
  { id: 'soon-4', label: '预留', mark: '+', ready: false },
  { id: 'soon-5', label: '预留', mark: '+', ready: false },
  { id: 'soon-6', label: '预留', mark: '+', ready: false },
  { id: 'soon-7', label: '预留', mark: '+', ready: false },
]

interface NoteGeom {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly pinned: boolean
}

const ROLE_LABEL = {
  initiator: '发起',
  executor: '执行',
  reviewer: '验收',
} as const

/** Optional current-session feed; highlighting is best-effort. */
export interface TaskPanelProps {
  readonly sessionsList?: ObservableSnapshot<SessionListState>
}

function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredWorkspace(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* private mode */
  }
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
}

function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY)
    if (raw === null) return SIDEBAR_DEFAULT
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

function writeSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(width))
  } catch {
    /* private mode */
  }
}

function defaultTaskNoteGeom(): NoteGeom {
  const w = 520
  const h = Math.min(620, Math.max(NOTE_MIN_H, window.innerHeight - 96))
  return {
    x: Math.max(16, window.innerWidth - w - 72),
    y: Math.max(24, Math.round((window.innerHeight - h) / 2)),
    w,
    h,
    pinned: false,
  }
}

function defaultDagNoteGeom(): NoteGeom {
  const w = 760
  const h = Math.min(680, Math.max(400, window.innerHeight - 72))
  return {
    x: Math.max(16, window.innerWidth - w - 112),
    y: Math.max(24, Math.round((window.innerHeight - h) / 2) + 32),
    w,
    h,
    pinned: false,
  }
}

function clampNoteGeom(geom: NoteGeom): NoteGeom {
  const w = Math.min(Math.max(NOTE_MIN_W, geom.w), Math.max(NOTE_MIN_W, window.innerWidth - 24))
  const h = Math.min(Math.max(NOTE_MIN_H, geom.h), Math.max(NOTE_MIN_H, window.innerHeight - 24))
  const x = Math.min(Math.max(8, geom.x), Math.max(8, window.innerWidth - 80))
  const y = Math.min(Math.max(8, geom.y), Math.max(8, window.innerHeight - 40))
  return { x, y, w, h, pinned: geom.pinned }
}

function readNoteGeom(key: string, fallback: () => NoteGeom): NoteGeom {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback()
    const parsed = JSON.parse(raw) as Partial<NoteGeom>
    return clampNoteGeom({
      ...fallback(),
      ...parsed,
      pinned: parsed.pinned === true,
    })
  } catch {
    return fallback()
  }
}

function writeNoteGeom(key: string, geom: NoteGeom): void {
  try {
    localStorage.setItem(key, JSON.stringify(geom))
  } catch {
    /* private mode */
  }
}

function useNoteWindow(storageKey: string, fallback: () => NoteGeom) {
  const [open, setOpen] = useState(() => readNoteGeom(storageKey, fallback).pinned)
  const [geom, setGeom] = useState(() => readNoteGeom(storageKey, fallback))
  const geomRef = useRef(geom)
  geomRef.current = geom
  const drag = useRef<{ originX: number; originY: number; startX: number; startY: number } | null>(null)
  const resize = useRef<{ originX: number; originY: number; startW: number; startH: number } | null>(null)

  const persist = (next: NoteGeom): void => {
    const clamped = clampNoteGeom(next)
    geomRef.current = clamped
    setGeom(clamped)
    writeNoteGeom(storageKey, clamped)
  }

  const onDragDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      originX: event.clientX,
      originY: event.clientY,
      startX: geomRef.current.x,
      startY: geomRef.current.y,
    }
  }

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null) return
    persist({
      ...geomRef.current,
      x: current.startX + event.clientX - current.originX,
      y: current.startY + event.clientY - current.originY,
    })
  }

  const onDragUp = (): void => {
    drag.current = null
  }

  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resize.current = {
      originX: event.clientX,
      originY: event.clientY,
      startW: geomRef.current.w,
      startH: geomRef.current.h,
    }
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = resize.current
    if (current === null) return
    persist({
      ...geomRef.current,
      w: current.startW + event.clientX - current.originX,
      h: current.startH + event.clientY - current.originY,
    })
  }

  const onResizeUp = (): void => {
    resize.current = null
  }

  return { open, setOpen, geom, geomRef, persist, onDragDown, onDragMove, onDragUp, onResizeDown, onResizeMove, onResizeUp }
}

function asSnapshot(value: unknown): PanelSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.workspaces) || !Array.isArray(record.sessions) || !Array.isArray(record.tasks)) {
    return null
  }
  if (!Array.isArray(record.flows)) {
    return { ...(value as PanelSnapshot), flows: [] }
  }
  return value as PanelSnapshot
}

function resolveWorkspace(
  workspaces: readonly WorkspaceView[],
  storedId: string | null,
): WorkspaceView | null {
  if (workspaces.length === 0) return null
  const stored = storedId === null ? undefined : workspaces.find(item => item.id === storedId)
  return stored ?? workspaces[0] ?? null
}

function badgeKind(task: TaskView): 'solid' | 'dashed' | 'outline' {
  if (task.status === 'queued') return 'dashed'
  if (task.status === 'completed' && task.outcome === null) return 'dashed'
  if (task.status === 'canceled') return 'outline'
  return 'solid'
}

function reportZoneLabel(zone: TaskView['reportZone']): string | null {
  if (zone === 'hot') return '报告外置·热'
  if (zone === 'cold') return '报告外置·冷(已归档)'
  if (zone === 'missing') return '报告缺失'
  return null
}

function TokenTriple({ tokens }: { tokens: TokenBuckets | null }): JSX.Element {
  const hint = tokens === null ? undefined : `cache-write ${tokens.cacheWriteTokens}`
  return <div className={css.abPTriple} title={hint}>{formatTokenUsage(tokens)}</div>
}

function taskTouchesSession(task: TaskView, sessionId: string): boolean {
  return task.assignedBy === sessionId
    || task.assignedTo === sessionId
    || task.assignedReviewer === sessionId
}

function ensurePanelStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS + PANEL_STALE_CSS
  document.head.appendChild(style)
}

function useCurrentSessionId(
  sessionsList: ObservableSnapshot<SessionListState> | undefined,
): string | undefined {
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (sessionsList === undefined) return () => {}
    return sessionsList.subscribe(onStoreChange)
  }, [sessionsList])
  const getSnapshot = useCallback(
    () => sessionsList?.getSnapshot().current,
    [sessionsList],
  )
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined)
}

function dispatchReady(tasks: readonly TaskView[], changedId: string | null): void {
  const candidates = changedId === null
    ? tasks.filter(task => task.status === 'queued')
    : tasks.filter(task =>
      task.status === 'queued' && (task.id === changedId || task.dependencies.includes(changedId)))
  for (const task of candidates) {
    if (blockedByOf(task, tasks).length > 0) continue
    void fetch(DISPATCH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: task.id }),
    })
  }
}

function usePanelSnapshot(): { snapshot: PanelSnapshot; loading: boolean; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<PanelSnapshot>(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const pullRef = useRef<(changedId: string | null) => Promise<void>>(async () => {})

  useEffect(() => {
    let cancelled = false
    let pollTimer: number | null = null

    const pull = async (changedId: string | null): Promise<void> => {
      try {
        const response = await fetch(STATE_PATH, { cache: 'no-store' })
        if (!response.ok) return
        const parsed = asSnapshot(await response.json())
        if (parsed === null || cancelled) return
        snapshotRef.current = parsed
        setSnapshot(parsed)
        if (changedId !== null) dispatchReady(parsed.tasks, changedId)
      } catch {
        /* keep the last good snapshot — host restart must not white-screen */
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    pullRef.current = pull

    const startPoll = (): void => {
      if (pollTimer !== null) return
      pollTimer = window.setInterval(() => { void pull(null) }, POLL_MS)
    }
    const stopPoll = (): void => {
      if (pollTimer === null) return
      window.clearInterval(pollTimer)
      pollTimer = null
    }

    void pull(null).then(() => {
      if (!cancelled) dispatchReady(snapshotRef.current.tasks, null)
    })

    let source: EventSource | null = null
    try {
      source = new EventSource(EVENTS_PATH)
      source.onopen = () => { stopPoll() }
      source.onerror = () => { startPoll() }
      source.onmessage = event => {
        let changedId: string | null = null
        try {
          const payload = JSON.parse(event.data) as { taskId?: unknown }
          if (typeof payload.taskId === 'string') changedId = payload.taskId
        } catch {
          changedId = null
        }
        void pull(changedId)
      }
    } catch {
      startPoll()
    }

    return () => {
      cancelled = true
      stopPoll()
      source?.close()
    }
  }, [])

  return { snapshot, loading, refresh: () => { void pullRef.current(null) } }
}

function StatusDot({ task, className }: { task: TaskView; className: string }): JSX.Element {
  const tone = statusTone(task.status, task.outcome)
  return <span className={className} data-tone={tone} aria-hidden="true" />
}

function StatusBadge({ task }: { task: TaskView }): JSX.Element {
  const tone = statusTone(task.status, task.outcome)
  return (
    <span className={css.abPBadge} data-tone={tone} data-kind={badgeKind(task)}>
      {statusLabel(task.status, task.outcome)}
    </span>
  )
}

function TaskCard({
  task,
  nowMs,
  currentSessionId,
  focused,
  onFocusTask,
}: {
  task: TaskView
  nowMs: number
  currentSessionId: string | undefined
  focused: boolean
  onFocusTask: (el: HTMLButtonElement) => void
}): JSX.Element {
  const current = currentSessionId !== undefined && taskTouchesSession(task, currentSessionId)
  return (
    <button
      type="button"
      className={css.abPTask}
      data-focused={focused || undefined}
      data-current={current || undefined}
      aria-expanded={focused}
      onMouseEnter={event => onFocusTask(event.currentTarget)}
      onFocus={event => onFocusTask(event.currentTarget)}
      onClick={event => onFocusTask(event.currentTarget)}
    >
      <div className={css.abPTaskLine}>
        <StatusBadge task={task} />
        <span className={css.abPTaskPreview}>{task.title ?? task.contentPreview}</span>
      </div>
      <div className={css.abPTaskMeta}>
        {`任务时间 ${relativeTime(task.updatedMs, nowMs)}`}
      </div>
    </button>
  )
}

function placeFloat(anchor: DOMRect): { top: number; left: number; width: number } {
  const drawer = document.querySelector(`.${css.abPDrawer}`)
  const drawerLeft = drawer instanceof HTMLElement
    ? drawer.getBoundingClientRect().left
    : window.innerWidth - 440
  const gap = 12
  const available = Math.max(200, drawerLeft - gap - 12)
  const width = Math.min(380, available)
  const left = Math.max(12, drawerLeft - gap - width)
  const maxHeight = Math.min(window.innerHeight - 24, 560)
  let top = anchor.top
  if (top + maxHeight > window.innerHeight - 12) {
    top = Math.max(12, window.innerHeight - 12 - maxHeight)
  }
  return { top, left, width }
}

function TaskFloat({
  task,
  nowMs,
  anchor,
  onReady,
  onClose,
  onArchive,
}: {
  task: TaskView
  nowMs: number
  anchor: DOMRect
  onReady: (el: HTMLElement | null) => void
  onClose: () => void
  onArchive: (archived: boolean) => void
}): JSX.Element {
  const zone = reportZoneLabel(task.reportZone)
  const box = placeFloat(anchor)
  const steps = callSteps(task)
  return (
    <article
      ref={onReady}
      className={css.abPFloat}
      style={{ top: box.top, left: box.left, width: box.width }}
    >
        <div className={css.abPFloatTop}>
          <StatusDot task={task} className={css.abPDot} />
          <div className={css.abPTaskSummary}>
            <div className={css.abPTaskLine}>
              <StatusBadge task={task} />
            </div>
            <div className={css.abPTaskMeta}>
              {`任务时间 ${relativeTime(task.updatedMs, nowMs)}`}
              {task.retries > 0 ? ` · 重做 ${task.retries}` : ''}
            </div>
          </div>
          <button
            type="button"
            className="abPArchive"
            aria-label={task.archived === true ? '取消归档任务' : '归档任务'}
            onClick={() => onArchive(task.archived !== true)}
          >
            {task.archived === true ? '取消归档' : '归档'}
          </button>
          <button type="button" className={css.abPClose} aria-label="关闭任务详情" onClick={onClose}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>
        <div className={css.abPReq}>
          <div className={css.abPStaffHead}>任务要求</div>
          <pre className={css.abPContent}>{task.content}</pre>
        </div>
        <div className={css.abPStaffHead}>
          本任务合计
          {hasUnreadableTokens(task.staff) ? ' · 部分会话不可读' : ''}
        </div>
        <TokenTriple tokens={task.taskTokensTotal} />
        <div className={css.abPCalls} aria-label="调用过程">
          {steps.map((step, index) => (
            <div key={`${step.from.sessionId}:${step.to.sessionId}:${index}`} className={css.abPCall}>
              <div className={css.abPCallHead}>
                <span className={css.abPCallWho}>{step.from.title}</span>
                <span className={css.abPChainArrow} aria-hidden="true">→</span>
                <span className={css.abPCallWho}>{step.to.title}</span>
                <span className={css.abPCallRoles}>
                  {`${ROLE_LABEL[step.from.role]} · ${ROLE_LABEL[step.to.role]}`}
                </span>
              </div>
              <div className={css.abPCallSummary}>{step.summary}</div>
              <div className={css.abPCallCost}>
                <span className={css.abPCallCostName}>{step.from.title}</span>
                <TokenTriple tokens={tokensForSession(task, step.from.sessionId)} />
              </div>
              <div className={css.abPCallCost}>
                <span className={css.abPCallCostName}>{step.to.title}</span>
                <TokenTriple tokens={tokensForSession(task, step.to.sessionId)} />
              </div>
            </div>
          ))}
        </div>
        {zone !== null && (
          <div className={css.abPZone} data-missing={task.reportZone === 'missing' || undefined}>
            {zone}
          </div>
        )}
      </article>
  )
}

const css = {
  abPRoot: 'abPRoot',
  abPCapsule: 'abPCapsule',
  abPLauncher: 'abPLauncher',
  abPLaunchTile: 'abPLaunchTile',
  abPLaunchMark: 'abPLaunchMark',
  abPNote: 'abPNote',
  abPNoteBar: 'abPNoteBar',
  abPNoteTitle: 'abPNoteTitle',
  abPNotePin: 'abPNotePin',
  abPNoteBody: 'abPNoteBody',
  abPNoteGrip: 'abPNoteGrip',
  abPCapsuleCount: 'abPCapsuleCount',
  abPCapsuleMeta: 'abPCapsuleMeta',
  abPCapsuleDot: 'abPCapsuleDot',
  abPStaleBadge: 'abPStaleBadge',
  abPStale: 'abPStale',
  abPStaleText: 'abPStaleText',
  abPStaleClose: 'abPStaleClose',
  abPRecovery: 'abPRecovery',
  abPRecoveryText: 'abPRecoveryText',
  abPPreview: 'abPPreview',
  abPPreviewHead: 'abPPreviewHead',
  abPPreviewWs: 'abPPreviewWs',
  abPPreviewStats: 'abPPreviewStats',
  abPPreviewList: 'abPPreviewList',
  abPPreviewRow: 'abPPreviewRow',
  abPPreviewTo: 'abPPreviewTo',
  abPPreviewText: 'abPPreviewText',
  abPPreviewEmpty: 'abPPreviewEmpty',
  abPDrawer: 'abPDrawer',
  abPTop: 'abPTop',
  abPWs: 'abPWs',
  abPWsBtn: 'abPWsBtn',
  abPWsTitle: 'abPWsTitle',
  abPWsChevron: 'abPWsChevron',
  abPWsMenu: 'abPWsMenu',
  abPWsItem: 'abPWsItem',
  abPWsItemPath: 'abPWsItemPath',
  abPClose: 'abPClose',
  abPBody: 'abPBody',
  abPSessions: 'abPSessions',
  abPResize: 'abPResize',
  abPAll: 'abPAll',
  abPAllBtn: 'abPAllBtn',
  abPAllToggle: 'abPAllToggle',
  abPGroup: 'abPGroup',
  abPSessionList: 'abPSessionList',
  abPSession: 'abPSession',
  abPSessionText: 'abPSessionText',
  abPSessionTitle: 'abPSessionTitle',
  abPOffline: 'abPOffline',
  abPOfflineToggle: 'abPOfflineToggle',
  abPLive: 'abPLive',
  abPMain: 'abPMain',
  abPEmpty: 'abPEmpty',
  abPEmptyTitle: 'abPEmptyTitle',
  abPEmptyHint: 'abPEmptyHint',
  abPTask: 'abPTask',
  abPTaskSummary: 'abPTaskSummary',
  abPTaskLine: 'abPTaskLine',
  abPTaskPreview: 'abPTaskPreview',
  abPTaskMeta: 'abPTaskMeta',
  abPDot: 'abPDot',
  abPBadge: 'abPBadge',
  abPFloat: 'abPFloat',
  abPFloatTop: 'abPFloatTop',
  abPFloatTitle: 'abPFloatTitle',
  abPChainArrow: 'abPChainArrow',
  abPCalls: 'abPCalls',
  abPCall: 'abPCall',
  abPCallHead: 'abPCallHead',
  abPCallWho: 'abPCallWho',
  abPCallRoles: 'abPCallRoles',
  abPCallSummary: 'abPCallSummary',
  abPCallCost: 'abPCallCost',
  abPCallCostName: 'abPCallCostName',
  abPZone: 'abPZone',
  abPContent: 'abPContent',
  abPReq: 'abPReq',
  abPStaffHead: 'abPStaffHead',
  abPTriple: 'abPTriple',
} as const

/**
 * Capsule opens the launcher; 任务 / 流程 each open a sticky-note window.
 */
export function TaskPanel({ sessionsList }: TaskPanelProps): JSX.Element {
  useLayoutEffect(() => { ensurePanelStyles() }, [])
  const { snapshot, loading, refresh } = usePanelSnapshot()
  const archiveToggle = async (kind: 'task' | 'flow', id: string, archived: boolean): Promise<void> => {
    try {
      await fetch(ARCHIVE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id, archived }),
      })
    } finally {
      refresh()
    }
  }
  const currentSessionId = useCurrentSessionId(sessionsList)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const taskNote = useNoteWindow(TASK_NOTE_KEY, defaultTaskNoteGeom)
  const dagNote = useNoteWindow(DAG_NOTE_KEY, defaultDagNoteGeom)
  const [front, setFront] = useState<FeatureId>('tasks')
  const [wsMenu, setWsMenu] = useState(false)
  const [dagWsMenu, setDagWsMenu] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<string | null>(null)
  const [storedFlow, setStoredFlow] = useState<string | null>(() => {
    try {
      return localStorage.getItem(FLOW_KEY)
    } catch {
      return null
    }
  })
  const [archiveMode, setArchiveMode] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [offlineOpen, setOfflineOpen] = useState(false)
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [floatAnchor, setFloatAnchor] = useState<DOMRect | null>(null)
  const floatRef = useRef<HTMLElement | null>(null)
  const dagEscRef = useRef<(() => boolean) | null>(null)
  const [storedWorkspace, setStoredWorkspace] = useState<string | null>(readStoredWorkspace)
  const [dismissedStale, setDismissedStale] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STALE_DISMISS_KEY)
    } catch {
      return null
    }
  })
  const [dismissedRecovery, setDismissedRecovery] = useState<string | null>(() => {
    try {
      return localStorage.getItem(RECOVERY_DISMISS_KEY)
    } catch {
      return null
    }
  })
  const [nowMs, setNowMs] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const sidebarDrag = useRef<{ origin: number; start: number } | null>(null)

  const onSidebarResizeDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    sidebarDrag.current = { origin: event.clientX, start: sidebarWidthRef.current }
  }

  const onSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = sidebarDrag.current
    if (drag === null) return
    setSidebarWidth(clampSidebarWidth(drag.start + event.clientX - drag.origin))
  }

  const onSidebarResizeUp = (): void => {
    if (sidebarDrag.current === null) return
    sidebarDrag.current = null
    writeSidebarWidth(sidebarWidthRef.current)
  }

  const workspace = useMemo(
    () => resolveWorkspace(snapshot.workspaces, storedWorkspace),
    [snapshot.workspaces, storedWorkspace],
  )

  const workspaceTasks = useMemo(
    () => tasksOfWorkspace(snapshot.tasks, workspace?.path ?? null),
    [snapshot.tasks, workspace],
  )

  const workspaceFlows = useMemo(
    () => flowsOfWorkspace(snapshot.flows, workspace?.path ?? null),
    [snapshot.flows, workspace],
  )

  const selectedFlowId = useMemo(() => {
    if (workspaceFlows.length === 0) return null
    const stored = storedFlow === null ? undefined : workspaceFlows.find(flow => flow.id === storedFlow)
    return stored?.id ?? workspaceFlows[0]?.id ?? null
  }, [workspaceFlows, storedFlow])

  const visibleTasks = useMemo(() => {
    const scoped = tasksOfSession(workspaceTasks, sessionFilter)
    if (archiveMode) return sortArchived(archiveTabTasks(scoped))
    return sortActive(activeTabTasks(scoped))
  }, [workspaceTasks, sessionFilter, archiveMode, nowMs])

  const focusedTask = useMemo(
    () => visibleTasks.find(task => task.id === focusedTaskId) ?? null,
    [visibleTasks, focusedTaskId],
  )

  const activeCount = useMemo(() => activeTabTasks(workspaceTasks).length, [workspaceTasks])
  const workspaceSessions = useMemo(
    () => sessionsOfWorkspace(snapshot.sessions, workspace?.id ?? null),
    [snapshot.sessions, workspace],
  )
  // Session directory mirrors the harness sidebar exactly: a session is
  // active (workspace sidebar, live or not) or archived (manually archived in
  // the workspace). Attach state (session.live) is a runtime status dot only,
  // never a partition key.
  const activeSessions = useMemo(
    () => workspaceSessions.filter(session => !session.archived),
    [workspaceSessions],
  )
  const archivedSessions = useMemo(
    () => workspaceSessions.filter(session => session.archived),
    [workspaceSessions],
  )
  const historicalAgents = useMemo(
    () => archiveAgents(workspaceTasks, snapshot.sessions),
    [workspaceTasks, snapshot.sessions],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (dagEscRef.current?.()) return
      if (focusedTaskId !== null) {
        setFocusedTaskId(null)
        setFloatAnchor(null)
        return
      }
      if (launcherOpen) {
        setLauncherOpen(false)
        setWsMenu(false)
        setDagWsMenu(false)
        return
      }
      if (front === 'dag' && dagNote.open && !dagNote.geom.pinned) {
        dagNote.setOpen(false)
        setDagWsMenu(false)
        return
      }
      if (taskNote.open && !taskNote.geom.pinned) {
        taskNote.setOpen(false)
        setWsMenu(false)
        setFocusedTaskId(null)
        setFloatAnchor(null)
        return
      }
      if (dagNote.open && !dagNote.geom.pinned) {
        dagNote.setOpen(false)
        setDagWsMenu(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [
    focusedTaskId,
    launcherOpen,
    front,
    taskNote.open,
    taskNote.geom.pinned,
    dagNote.open,
    dagNote.geom.pinned,
    taskNote,
    dagNote,
  ])

  useEffect(() => {
    if (!launcherOpen) return
    const onPointer = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (target instanceof Element && target.closest(`.${css.abPLauncher}`)) return
      if (target instanceof Element && target.closest(`.${css.abPCapsule}`)) return
      setLauncherOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [launcherOpen])

  useEffect(() => {
    if (focusedTaskId === null) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (floatRef.current?.contains(target)) return
      if (target instanceof Element && target.closest(`.${css.abPTask}`)) return
      setFocusedTaskId(null)
      setFloatAnchor(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [focusedTaskId])

  useEffect(() => {
    if (!taskNote.open && !dagNote.open) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [taskNote.open, dagNote.open])

  const openFeature = (id: FeatureId): void => {
    if (id === 'tasks') taskNote.setOpen(true)
    else dagNote.setOpen(true)
    setFront(id)
    setLauncherOpen(false)
  }

  const closeTaskNote = (): void => {
    taskNote.setOpen(false)
    setWsMenu(false)
    setFocusedTaskId(null)
    setFloatAnchor(null)
  }

  const closeDagNote = (): void => {
    dagNote.setOpen(false)
    setDagWsMenu(false)
  }

  const selectWorkspace = (id: string): void => {
    setStoredWorkspace(id)
    writeStoredWorkspace(id)
    setSessionFilter(null)
    setArchiveMode(false)
    setSessionsOpen(true)
    setArchiveOpen(false)
    setFocusedTaskId(null)
    setWsMenu(false)
    setDagWsMenu(false)
  }

  const selectAllSessions = (): void => {
    setArchiveMode(false)
    setSessionFilter(null)
    setSessionsOpen(true)
    setFocusedTaskId(null)
  }

  const toggleSessionList = (): void => {
    if (sessionsOpen) {
      setSessionsOpen(false)
      return
    }
    setSessionsOpen(true)
    setArchiveMode(false)
    setSessionFilter(null)
  }

  const toggleSession = (id: string): void => {
    setArchiveMode(false)
    setSessionFilter(current => !archiveMode && current === id ? null : id)
    setSessionsOpen(true)
  }

  const selectArchive = (): void => {
    setArchiveMode(true)
    setSessionFilter(null)
    setArchiveOpen(true)
    setFocusedTaskId(null)
  }

  const toggleArchiveList = (): void => {
    if (archiveOpen) {
      setArchiveOpen(false)
      return
    }
    setArchiveOpen(true)
    setArchiveMode(true)
    setSessionFilter(null)
  }

  const toggleArchiveAgent = (id: string): void => {
    setArchiveMode(true)
    setSessionFilter(current => archiveMode && current === id ? null : id)
    setArchiveOpen(true)
  }

  const wsTitle = workspace?.title ?? '未选择工作区'
  // Decision 7 hint: the running host predates the latest build. A dismissed
  // message stays hidden until a NEW update produces a different message.
  const staleMessage = snapshot.instanceStale === true ? (snapshot.staleMessage ?? null) : null
  const showStale = staleMessage !== null && dismissedStale !== staleMessage
  // Decision 10 C hint: this boot re-woke stranded workers. Dismissed once per
  // recovery batch (keyed by recoveryAt), so a later recovery shows again.
  const recoveryCount = snapshot.recoveredWorkers ?? 0
  const recoveryKey = snapshot.recoveryAt == null ? null : String(snapshot.recoveryAt)
  const showRecovery = recoveryCount > 0
    && recoveryKey !== null
    && dismissedRecovery !== recoveryKey
  const emptyLabel = archiveMode
    ? (sessionFilter === null ? '暂无归档任务' : '该会话暂无归档任务')
    : (sessionFilter === null ? '暂无活跃任务' : '该会话暂无活跃任务')
  const emptyHint = archiveMode
    ? '已完成超过 24 小时的任务会列在这里'
    : '进行中和已完成的任务会列在这里'

  return (
    <div className={css.abPRoot} ref={rootRef} data-agent-bus-panel>
      <button
        type="button"
        className={css.abPCapsule}
        data-loading={loading || undefined}
        data-open={launcherOpen || undefined}
        aria-expanded={launcherOpen}
        aria-label={`工作台，${activeCount} 个活跃任务`}
        onClick={() => setLauncherOpen(value => !value)}
      >
        {activeCount === 0
          ? <span className={css.abPCapsuleDot} />
          : <span className={css.abPCapsuleCount}>{activeCount}</span>}
        <span className={css.abPCapsuleMeta}>{snapshot.workspaces.length} ws</span>
        {snapshot.dag === 'paused' && (
          <span className={css.abPBadge} data-tone="warning" title="DAG 派发已暂停,恢复后自动补投">DAG ⏸</span>
        )}
        {snapshot.instanceStale === true && (
          <span
            className={css.abPStaleBadge}
            title={snapshot.staleMessage ?? '代码已更新,需重启生效'}
          >
            !
          </span>
        )}
      </button>

      {launcherOpen && (
        <div className={css.abPLauncher} role="menu" aria-label="工作台">
          {LAUNCHER_TILES.map(tile => (
            <button
              key={tile.id}
              type="button"
              className={css.abPLaunchTile}
              role="menuitem"
              disabled={!tile.ready}
              data-active={
                (tile.id === 'tasks' && taskNote.open)
                || (tile.id === 'dag' && dagNote.open)
                || undefined
              }
              onClick={() => {
                if (tile.id === 'tasks' || tile.id === 'dag') openFeature(tile.id)
              }}
            >
              <span className={css.abPLaunchMark}>{tile.mark}</span>
              {tile.label}
            </button>
          ))}
        </div>
      )}

      {taskNote.open && (
        <div
          className={css.abPNote}
          data-pinned={taskNote.geom.pinned || undefined}
          data-front={front === 'tasks' || undefined}
          style={{ left: taskNote.geom.x, top: taskNote.geom.y, width: taskNote.geom.w, height: taskNote.geom.h }}
          onPointerDown={() => setFront('tasks')}
        >
          <div
            className={css.abPNoteBar}
            onPointerDown={taskNote.onDragDown}
            onPointerMove={taskNote.onDragMove}
            onPointerUp={taskNote.onDragUp}
            onPointerCancel={taskNote.onDragUp}
          >
            <span className={css.abPNoteTitle}>任务</span>
            <button
              type="button"
              className={`${css.abPClose} ${css.abPNotePin}`}
              data-on={taskNote.geom.pinned || undefined}
              aria-pressed={taskNote.geom.pinned}
              aria-label={taskNote.geom.pinned ? '取消钉选' : '钉选窗口'}
              onClick={() => taskNote.persist({ ...taskNote.geomRef.current, pinned: !taskNote.geomRef.current.pinned })}
            >
              钉
            </button>
            <button
              type="button"
              className={css.abPClose}
              aria-label="关闭任务窗口"
              onClick={closeTaskNote}
            >
              <IconCloseOutline16 size={16} />
            </button>
          </div>
          <div className={css.abPNoteBody}>
            {showRecovery && (
              <div className={css.abPRecovery} role="status">
                <span className={css.abPRecoveryText}>
                  {`上次启动已自动恢复 ${recoveryCount} 个滞留任务的工作会话,工具已恢复完整`}
                </span>
                <button
                  type="button"
                  className={css.abPStaleClose}
                  aria-label="关闭恢复提示"
                  onClick={() => {
                    setDismissedRecovery(recoveryKey)
                    try {
                      localStorage.setItem(RECOVERY_DISMISS_KEY, recoveryKey)
                    } catch {
                      /* private mode */
                    }
                  }}
                >
                  <IconCloseOutline16 size={14} />
                </button>
              </div>
            )}
            {showStale && (
              <div className={css.abPStale} role="status">
                <span className={css.abPStaleText}>{staleMessage}</span>
                <button
                  type="button"
                  className={css.abPStaleClose}
                  aria-label="关闭更新提示"
                  onClick={() => {
                    setDismissedStale(staleMessage)
                    try {
                      localStorage.setItem(STALE_DISMISS_KEY, staleMessage ?? '')
                    } catch {
                      /* private mode */
                    }
                  }}
                >
                  <IconCloseOutline16 size={14} />
                </button>
              </div>
            )}
      <aside className={css.abPDrawer}>
        <div className={css.abPTop}>
          <div className={css.abPWs}>
            <button
              type="button"
              className={css.abPWsBtn}
              aria-haspopup="listbox"
              aria-expanded={wsMenu}
              onClick={() => setWsMenu(value => !value)}
            >
              <span className={css.abPWsTitle}>{wsTitle}</span>
              <span className={css.abPWsChevron}>
                <IconChevronDownOutline14 size={14} />
              </span>
            </button>
            {wsMenu && snapshot.workspaces.length > 0 && (
              <div className={css.abPWsMenu} role="listbox">
                {snapshot.workspaces.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={css.abPWsItem}
                    role="option"
                    data-active={item.id === workspace?.id || undefined}
                    aria-selected={item.id === workspace?.id}
                    onClick={() => selectWorkspace(item.id)}
                  >
                    <span>{item.title}</span>
                    <span className={css.abPWsItemPath}>{item.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className={css.abPBody}>
          <nav
            className={css.abPSessions}
            aria-label="会话"
            style={{ width: sidebarWidth }}
          >
            <div
              className={css.abPResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="调节侧栏宽度"
              onPointerDown={onSidebarResizeDown}
              onPointerMove={onSidebarResizeMove}
              onPointerUp={onSidebarResizeUp}
              onPointerCancel={onSidebarResizeUp}
            />
            <div className={css.abPAll}>
              <button
                type="button"
                className={css.abPAllBtn}
                data-active={!archiveMode && sessionFilter === null || undefined}
                onClick={selectAllSessions}
              >
                活跃任务
              </button>
              <button
                type="button"
                className={css.abPAllToggle}
                data-open={sessionsOpen || undefined}
                aria-expanded={sessionsOpen}
                aria-label={sessionsOpen ? '折叠活跃任务列表' : '展开活跃任务'}
                onClick={toggleSessionList}
              >
                <IconChevronDownOutline14 size={14} />
              </button>
            </div>
            {sessionsOpen && (
              <div className={css.abPSessionList}>
                {activeSessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={css.abPSession}
                    data-active={!archiveMode && sessionFilter === session.id || undefined}
                    data-current={session.id === currentSessionId || undefined}
                    onClick={() => toggleSession(session.id)}
                  >
                    <span className={css.abPLive} data-on={session.live || undefined} />
                    <span className={css.abPSessionText}>
                      <span className={css.abPSessionTitle}>{session.title}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className={css.abPGroup}>
              <div className={css.abPAll}>
                <button
                  type="button"
                  className={css.abPAllBtn}
                  data-active={archiveMode && sessionFilter === null || undefined}
                  onClick={selectArchive}
                >
                  归档任务
                </button>
                <button
                  type="button"
                  className={css.abPAllToggle}
                  data-open={archiveOpen || undefined}
                  aria-expanded={archiveOpen}
                  aria-label={archiveOpen ? '折叠归档任务列表' : '展开归档任务'}
                  onClick={toggleArchiveList}
                >
                  <IconChevronDownOutline14 size={14} />
                </button>
              </div>
              {archiveOpen && (
                <div className={css.abPSessionList}>
                  {historicalAgents.filter(agent => agent.live).map(agent => (
                    <button
                      key={agent.sessionId}
                      type="button"
                      className={css.abPSession}
                      data-active={archiveMode && sessionFilter === agent.sessionId || undefined}
                      data-current={agent.sessionId === currentSessionId || undefined}
                      onClick={() => toggleArchiveAgent(agent.sessionId)}
                    >
                      <span className={css.abPLive} data-on />
                      <span className={css.abPSessionText}>
                        <span className={css.abPSessionTitle}>{agent.title}</span>
                      </span>
                    </button>
                  ))}
                  {archivedSessions.length > 0 && (
                    <>
                      <button
                        type="button"
                        className={css.abPOfflineToggle}
                        data-open={offlineOpen || undefined}
                        aria-expanded={offlineOpen}
                        onClick={() => {
                          setOfflineOpen(value => !value)
                          setArchiveMode(true)
                          setSessionFilter(null)
                          setFocusedTaskId(null)
                        }}
                      >
                        <span>归档 {archivedSessions.length}</span>
                        <IconChevronDownOutline14 size={14} />
                      </button>
                      {offlineOpen && archivedSessions.map(session => (
                        <button
                          key={session.id}
                          type="button"
                          className={css.abPSession}
                          data-active={archiveMode && sessionFilter === session.id || undefined}
                          data-current={session.id === currentSessionId || undefined}
                          onClick={() => toggleArchiveAgent(session.id)}
                        >
                          <span className={css.abPLive} data-on={session.live || undefined} />
                          <span className={css.abPSessionText}>
                            <span className={css.abPSessionTitle}>{session.title}</span>
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </nav>
          <div className={css.abPMain}>
            {visibleTasks.length === 0
              ? (
                <div className={css.abPEmpty}>
                  <div className={css.abPEmptyTitle}>{emptyLabel}</div>
                  {sessionFilter === null && (
                    <div className={css.abPEmptyHint}>{emptyHint}</div>
                  )}
                </div>
              )
              : visibleTasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  nowMs={nowMs}
                  currentSessionId={currentSessionId}
                  focused={task.id === focusedTaskId}
                  onFocusTask={el => {
                    setFocusedTaskId(task.id)
                    setFloatAnchor(el.getBoundingClientRect())
                  }}
                />
              ))}
          </div>
        </div>
      </aside>
          </div>
          <div
            className={css.abPNoteGrip}
            aria-label="缩放窗口"
            onPointerDown={taskNote.onResizeDown}
            onPointerMove={taskNote.onResizeMove}
            onPointerUp={taskNote.onResizeUp}
            onPointerCancel={taskNote.onResizeUp}
          />
        </div>
      )}
      {dagNote.open && (
        <div
          className={css.abPNote}
          data-pinned={dagNote.geom.pinned || undefined}
          data-front={front === 'dag' || undefined}
          style={{ left: dagNote.geom.x, top: dagNote.geom.y, width: dagNote.geom.w, height: dagNote.geom.h }}
          onPointerDown={() => setFront('dag')}
        >
          <div
            className={css.abPNoteBar}
            onPointerDown={dagNote.onDragDown}
            onPointerMove={dagNote.onDragMove}
            onPointerUp={dagNote.onDragUp}
            onPointerCancel={dagNote.onDragUp}
          >
            <span className={css.abPNoteTitle}>流程</span>
            <button
              type="button"
              className={`${css.abPClose} ${css.abPNotePin}`}
              data-on={dagNote.geom.pinned || undefined}
              aria-pressed={dagNote.geom.pinned}
              aria-label={dagNote.geom.pinned ? '取消钉选' : '钉选窗口'}
              onClick={() => dagNote.persist({ ...dagNote.geomRef.current, pinned: !dagNote.geomRef.current.pinned })}
            >
              钉
            </button>
            <button
              type="button"
              className={css.abPClose}
              aria-label="关闭流程窗口"
              onClick={closeDagNote}
            >
              <IconCloseOutline16 size={16} />
            </button>
          </div>
          <div className={css.abPNoteBody}>
            <aside className={css.abPDrawer}>
              <div className={css.abPTop}>
                <div className={css.abPWs}>
                  <button
                    type="button"
                    className={css.abPWsBtn}
                    aria-haspopup="listbox"
                    aria-expanded={dagWsMenu}
                    onClick={() => setDagWsMenu(value => !value)}
                  >
                    <span className={css.abPWsTitle}>{wsTitle}</span>
                    <span className={css.abPWsChevron}>
                      <IconChevronDownOutline14 size={14} />
                    </span>
                  </button>
                  {dagWsMenu && snapshot.workspaces.length > 0 && (
                    <div className={css.abPWsMenu} role="listbox">
                      {snapshot.workspaces.map(item => (
                        <button
                          key={item.id}
                          type="button"
                          className={css.abPWsItem}
                          role="option"
                          data-active={item.id === workspace?.id || undefined}
                          aria-selected={item.id === workspace?.id}
                          onClick={() => selectWorkspace(item.id)}
                        >
                          <span>{item.title}</span>
                          <span className={css.abPWsItemPath}>{item.path}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <DagView
                tasks={workspaceTasks}
                flows={workspaceFlows}
                selectedFlowId={selectedFlowId}
                onSelectFlow={id => {
                  setStoredFlow(id)
                  try {
                    localStorage.setItem(FLOW_KEY, id)
                  } catch {
                    /* private mode */
                  }
                }}
                onArchiveFlow={(id, archived) => { void archiveToggle('flow', id, archived) }}
                sidebarWidth={sidebarWidth}
                onSidebarResizeDown={onSidebarResizeDown}
                onSidebarResizeMove={onSidebarResizeMove}
                onSidebarResizeUp={onSidebarResizeUp}
                nowMs={nowMs}
                consumeEscRef={dagEscRef}
              />
            </aside>
          </div>
          <div
            className={css.abPNoteGrip}
            aria-label="缩放窗口"
            onPointerDown={dagNote.onResizeDown}
            onPointerMove={dagNote.onResizeMove}
            onPointerUp={dagNote.onResizeUp}
            onPointerCancel={dagNote.onResizeUp}
          />
        </div>
      )}
      {focusedTask !== null && floatAnchor !== null && (
        <TaskFloat
          task={focusedTask}
          nowMs={nowMs}
          anchor={floatAnchor}
          onReady={el => { floatRef.current = el }}
          onClose={() => { setFocusedTaskId(null); setFloatAnchor(null) }}
          onArchive={archived => { void archiveToggle('task', focusedTask.id, archived) }}
        />
      )}
    </div>
  )
}

/** Decision-7 stale-hint styles, appended to the injected sheet. */
const PANEL_STALE_CSS = `
.abPStaleBadge {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.abPStale {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.4;
}

.abPStaleText {
  flex: 1;
}

.abPStaleClose {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
}

.abPStaleClose:hover {
  color: var(--dsw-alias-label-primary);
}

.abPRecovery {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.4;
}

.abPRecoveryText {
  flex: 1;
}
`

/** Fallback sheet used when the CSS-module import is not a raw stylesheet. */
const PANEL_CSS = "/* v1.1 task panel. Class prefix abP* stays clear of the host. Colors are\r\n   --dsw-alias-* tokens only; motion stays ≤150ms. */\r\n\r\n\r\n\r\n.abPRoot {\r\n  position: contents;\r\n  font-family: var(--dsw-font-family);\r\n  color: var(--dsw-alias-label-primary);\r\n  line-height: 1.45;\r\n}\r\n\r\n.abPCapsule {\r\n  position: fixed;\r\n  top: 50%;\r\n  right: 0;\r\n  z-index: 40;\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 6px;\r\n  width: 48px;\r\n  min-height: 84px;\r\n  padding: 14px 6px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-right: none;\r\n  border-radius: 12px 0 0 12px;\r\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, transparent);\r\n  color: var(--dsw-alias-label-primary);\r\n  box-shadow: -6px 0 20px var(--dsw-alias-bg-mask-2);\r\n  backdrop-filter: blur(12px);\r\n  cursor: pointer;\r\n  transform: translateY(-50%);\r\n  transition: transform 150ms var(--ds-ease-in-out, ease);\r\n}\r\n\r\n.abPCapsule:focus-visible {\r\n  outline: 2px solid var(--dsw-alias-state-business-primary);\r\n  outline-offset: 2px;\r\n}\r\n\r\n.abPCapsule[data-open] {\r\n  border-color: var(--dsw-alias-state-business-primary);\r\n}\r\n\r\n.abPCapsuleCount {\r\n  font-size: 22px;\r\n  font-weight: 600;\r\n  line-height: 28px;\r\n  font-variant-numeric: tabular-nums;\r\n  letter-spacing: -0.03em;\r\n}\r\n\r\n.abPCapsuleMeta {\r\n  font-size: 11px;\r\n  line-height: 14px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPCapsuleDot {\r\n  width: 8px;\r\n  height: 8px;\r\n  border-radius: 50%;\r\n  background: var(--dsw-alias-label-tertiary);\r\n  opacity: 0.65;\r\n}\r\n\r\n.abPCapsule[data-loading] .abPCapsuleDot,\r\n.abPCapsule[data-loading] .abPCapsuleCount {\r\n  animation: abPPulse 1.2s var(--ds-ease-in-out, ease) infinite;\r\n}\r\n\r\n.abPPreview {\r\n  position: fixed;\r\n  top: 50%;\r\n  right: 58px;\r\n  z-index: 41;\r\n  width: 280px;\r\n  padding: 14px 16px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 12px;\r\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent);\r\n  box-shadow: -8px 6px 24px var(--dsw-alias-bg-mask-2);\r\n  backdrop-filter: blur(12px);\r\n  transform: translateY(-50%);\r\n  pointer-events: none;\r\n}\r\n\r\nhtml[data-agent-bus-panel-open] .abPPreview {\r\n  display: none;\r\n}\r\n\r\n.abPPreviewHead {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  margin-bottom: 12px;\r\n  padding-bottom: 10px;\r\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\r\n}\r\n\r\n.abPPreviewWs {\r\n  font-size: 13px;\r\n  font-weight: 600;\r\n  line-height: 20px;\r\n  color: var(--dsw-alias-label-primary);\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.abPPreviewStats {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.abPPreviewList {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 10px;\r\n}\r\n\r\n.abPPreviewRow {\r\n  display: grid;\r\n  grid-template-columns: 8px minmax(0, 1fr);\r\n  gap: 10px;\r\n  align-items: start;\r\n}\r\n\r\n.abPPreviewTo {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.abPPreviewText {\r\n  font-size: 13px;\r\n  line-height: 20px;\r\n  color: var(--dsw-alias-label-primary);\r\n  overflow: hidden;\r\n  display: -webkit-box;\r\n  -webkit-line-clamp: 2;\r\n  -webkit-box-orient: vertical;\r\n}\r\n\r\n.abPPreviewEmpty {\r\n  font-size: 13px;\r\n  line-height: 20px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPLauncher {\r\n  position: fixed;\r\n  right: 60px;\r\n  top: 50%;\r\n  z-index: 45;\r\n  display: grid;\r\n  grid-template-columns: repeat(3, 1fr);\r\n  gap: 8px;\r\n  width: 228px;\r\n  padding: 12px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 16px;\r\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);\r\n  box-shadow: -8px 8px 28px var(--dsw-alias-bg-mask-2);\r\n  backdrop-filter: blur(14px);\r\n  transform: translateY(-50%);\r\n}\r\n\r\n.abPLaunchTile {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 4px;\r\n  aspect-ratio: 1;\r\n  padding: 6px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 12px;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  color: var(--dsw-alias-label-primary);\r\n  font: inherit;\r\n  font-size: 12px;\r\n  line-height: 16px;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPLaunchTile:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPLaunchTile[data-active] {\r\n  border-color: var(--dsw-alias-state-business-primary);\r\n}\r\n\r\n.abPLaunchTile:disabled {\r\n  opacity: 0.38;\r\n  cursor: default;\r\n}\r\n\r\n.abPLaunchMark {\r\n  font-size: 16px;\r\n  font-weight: 600;\r\n  line-height: 22px;\r\n  color: var(--dsw-alias-state-business-primary);\r\n}\r\n\r\n.abPNote {\r\n  position: fixed;\r\n  z-index: 48;\r\n  box-sizing: border-box;\r\n  display: flex;\r\n  flex-direction: column;\r\n  min-width: 360px;\r\n  min-height: 320px;\r\n  overflow: hidden;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 12px;\r\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent);\r\n  box-shadow: 0 16px 40px var(--dsw-alias-bg-mask-2);\r\n  backdrop-filter: blur(12px);\r\n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);\r\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);\r\n}\r\n\r\n.abPNote[data-pinned] {\r\n  z-index: 49;\r\n  box-shadow: 0 18px 44px var(--dsw-alias-bg-mask-1);\r\n}\r\n\r\n.abPNote[data-front] {\r\n  z-index: 50;\r\n}\r\n\r\n.abPNoteBar {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n  flex: none;\r\n  min-height: 36px;\r\n  padding: 4px 8px 4px 12px;\r\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\r\n  cursor: grab;\r\n  user-select: none;\r\n  touch-action: none;\r\n}\r\n\r\n.abPNoteBar:active {\r\n  cursor: grabbing;\r\n}\r\n\r\n.abPNoteTitle {\r\n  min-width: 0;\r\n  flex: 1;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  font-size: 13px;\r\n  font-weight: 600;\r\n  line-height: 20px;\r\n}\r\n\r\n.abPNotePin[data-on] {\r\n  color: var(--dsw-alias-state-business-primary);\r\n}\r\n\r\n.abPNoteBody {\r\n  display: flex;\r\n  flex-direction: column;\r\n  min-height: 0;\r\n  flex: 1;\r\n}\r\n\r\n.abPNoteGrip {\r\n  position: absolute;\r\n  right: 2px;\r\n  bottom: 2px;\r\n  width: 14px;\r\n  height: 14px;\r\n  cursor: nwse-resize;\r\n  touch-action: none;\r\n  background:\r\n    linear-gradient(\r\n      135deg,\r\n      transparent 50%,\r\n      var(--dsw-alias-label-tertiary) 50%,\r\n      var(--dsw-alias-label-tertiary) 60%,\r\n      transparent 60%,\r\n      transparent 75%,\r\n      var(--dsw-alias-label-tertiary) 75%\r\n    );\r\n}\r\n\r\n.abPDrawer {\r\n  display: flex;\r\n  flex-direction: column;\r\n  min-height: 0;\r\n  flex: 1;\r\n}\r\n\r\n.abPTop {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 10px;\r\n  flex: none;\r\n  min-height: 56px;\r\n  padding: 10px 12px 10px 14px;\r\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\r\n  background: var(--dsw-alias-bg-layer-1);\r\n}\r\n\r\n.abPWs {\r\n  position: relative;\r\n  min-width: 0;\r\n  flex: 1;\r\n}\r\n\r\n.abPWsBtn {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n  width: 100%;\r\n  min-height: 36px;\r\n  padding: 6px 10px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 10px;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  color: var(--dsw-alias-label-primary);\r\n  font: inherit;\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPWsBtn:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPWsBtn:focus-visible,\r\n.abPClose:focus-visible,\r\n.abPSession:focus-visible,\r\n.abPTask:focus-visible,\r\n.abPDagNode:focus-visible,\r\n.abPDagTool:focus-visible,\r\n.abPFlow:focus-visible,\r\n.abPWsItem:focus-visible,\r\n.abPAllBtn:focus-visible,\r\n.abPAllToggle:focus-visible,\r\n.abPOfflineToggle:focus-visible {\r\n  outline: 2px solid var(--dsw-alias-state-business-primary);\r\n  outline-offset: 1px;\r\n}\r\n\r\n.abPWsTitle {\r\n  min-width: 0;\r\n  flex: 1;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  font-size: 14px;\r\n  font-weight: 600;\r\n  line-height: 22px;\r\n}\r\n\r\n.abPWsChevron {\r\n  flex: none;\r\n  display: inline-flex;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPWsMenu {\r\n  position: absolute;\r\n  top: calc(100% + 6px);\r\n  left: 0;\r\n  right: 0;\r\n  z-index: 3;\r\n  max-height: 280px;\r\n  overflow: auto;\r\n  padding: 6px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 10px;\r\n  background: var(--dsw-alias-bg-layer-1);\r\n  box-shadow: 0 10px 24px var(--dsw-alias-bg-mask-2);\r\n}\r\n\r\n.abPWsItem {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n  width: 100%;\r\n  padding: 8px 10px;\r\n  border: none;\r\n  border-radius: 8px;\r\n  background: transparent;\r\n  color: inherit;\r\n  font: inherit;\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPWsItem:hover,\r\n.abPWsItem[data-active] {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPWsItemPath {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.abPClose {\r\n  flex: none;\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  width: 32px;\r\n  height: 32px;\r\n  padding: 0;\r\n  border: none;\r\n  border-radius: 8px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-secondary);\r\n  cursor: pointer;\r\n}\r\n\r\n.abPClose:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.abPBody {\r\n  display: flex;\r\n  min-height: 0;\r\n  flex: 1;\r\n}\r\n\r\n.abPSessions {\r\n  position: relative;\r\n  display: flex;\r\n  flex-direction: column;\r\n  flex: none;\r\n  width: 160px;\r\n  min-width: 128px;\r\n  max-width: 280px;\r\n  padding: 10px 8px;\r\n  overflow: auto;\r\n  border-right: 1px solid var(--dsw-alias-border-l2);\r\n  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-module-platform));\r\n}\r\n\r\n.abPResize {\r\n  position: absolute;\r\n  top: 0;\r\n  right: -3px;\r\n  z-index: 3;\r\n  width: 6px;\r\n  height: 100%;\r\n  cursor: col-resize;\r\n  touch-action: none;\r\n}\r\n\r\n.abPResize:hover,\r\n.abPResize:active {\r\n  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);\r\n}\r\n\r\n.abPGroup {\r\n  display: flex;\r\n  flex-direction: column;\r\n  margin-top: 10px;\r\n  padding-top: 10px;\r\n  border-top: 1px solid var(--dsw-alias-border-l2);\r\n}\r\n\r\n.abPAll {\r\n  display: flex;\r\n  align-items: stretch;\r\n  gap: 2px;\r\n  margin-bottom: 6px;\r\n}\r\n\r\n.abPAllBtn {\r\n  display: flex;\r\n  align-items: center;\r\n  min-width: 0;\r\n  flex: 1;\r\n  min-height: 34px;\r\n  padding: 6px 8px;\r\n  border: none;\r\n  border-radius: 8px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-primary);\r\n  font: inherit;\r\n  font-size: 13px;\r\n  font-weight: 600;\r\n  line-height: 20px;\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPAllBtn:hover,\r\n.abPAllToggle:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPAllBtn[data-active],\r\n.abPSession[data-active] {\r\n  background: var(--dsw-alias-button-ghost-active-fill);\r\n}\r\n\r\n.abPAllToggle {\r\n  flex: none;\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  width: 28px;\r\n  border: none;\r\n  border-radius: 8px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-tertiary);\r\n  cursor: pointer;\r\n}\r\n\r\n.abPAllToggle[data-open] {\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.abPAllToggle[data-open] svg {\r\n  transform: rotate(180deg);\r\n}\r\n\r\n.abPAllToggle svg {\r\n  transition: transform 150ms var(--ds-ease-in-out, ease);\r\n}\r\n\r\n.abPSessionList {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n}\r\n\r\n.abPSession {\r\n  display: flex;\r\n  align-items: flex-start;\r\n  gap: 8px;\r\n  width: 100%;\r\n  min-height: 34px;\r\n  padding: 6px 8px;\r\n  border: none;\r\n  border-radius: 8px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-primary);\r\n  font: inherit;\r\n  font-size: 13px;\r\n  line-height: 20px;\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPSession:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPSession[data-current] .abPSessionTitle {\r\n  font-weight: 600;\r\n}\r\n\r\n.abPSessionText {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 1px;\r\n  min-width: 0;\r\n  flex: 1;\r\n}\r\n\r\n.abPSessionTitle {\r\n  min-width: 0;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.abPOffline {\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPOfflineToggle {\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: space-between;\r\n  gap: 6px;\r\n  width: 100%;\r\n  min-height: 30px;\r\n  margin-top: 4px;\r\n  padding: 4px 8px;\r\n  border: none;\r\n  border-radius: 8px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-tertiary);\r\n  font: inherit;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPOfflineToggle:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.abPOfflineToggle svg {\r\n  flex: none;\r\n  transition: transform 150ms var(--ds-ease-in-out, ease);\r\n}\r\n\r\n.abPOfflineToggle[data-open] svg {\r\n  transform: rotate(180deg);\r\n}\r\n\r\n.abPLive {\r\n  flex: none;\r\n  width: 7px;\r\n  height: 7px;\r\n  margin-top: 6px;\r\n  border-radius: 50%;\r\n  background: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPLive[data-on] {\r\n  background: var(--dsw-alias-state-success-primary);\r\n}\r\n\r\n.abPFlowHead {\r\n  padding: 2px 8px 6px;\r\n  font-size: 11px;\r\n  font-weight: 600;\r\n  line-height: 16px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPFlowList {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n}\r\n\r\n.abPFlowEmpty {\r\n  padding: 4px 8px 8px;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPFlow {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n  width: 100%;\r\n  min-height: 36px;\r\n  padding: 6px 8px;\r\n  border: none;\r\n  border-radius: 8px;\r\n  background: transparent;\r\n  color: inherit;\r\n  font: inherit;\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPFlow:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPFlow[data-active] {\r\n  background: var(--dsw-alias-button-ghost-active-fill);\r\n}\r\n\r\n.abPFlowName {\r\n  min-width: 0;\r\n  flex: 1;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  font-size: 13px;\r\n  line-height: 20px;\r\n}\r\n\r\n.abPFlow[data-archived] .abPFlowName {\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPFlowCount {\r\n  flex: none;\r\n  min-width: 20px;\r\n  padding: 0 6px;\r\n  border-radius: 999px;\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  color: var(--dsw-alias-label-secondary);\r\n  font-size: 11px;\r\n  line-height: 18px;\r\n  font-variant-numeric: tabular-nums;\r\n  text-align: center;\r\n}\r\n\r\n.abPFlow[data-active] .abPFlowCount {\r\n  color: var(--dsw-alias-state-business-primary);\r\n  background: var(--dsw-alias-state-business-tertiary);\r\n}\r\n\r\n.abPMain {\r\n  position: relative;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  min-width: 0;\r\n  flex: 1;\r\n  padding: 12px;\r\n  overflow: auto;\r\n}\r\n\r\n.abPEmpty {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 6px;\r\n  min-height: 160px;\r\n  padding: 24px 16px;\r\n  text-align: center;\r\n}\r\n\r\n.abPEmptyTitle {\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.abPEmptyHint {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPTask {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  width: 100%;\r\n  padding: 10px 12px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 10px;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  color: inherit;\r\n  font: inherit;\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPTask:hover,\r\n.abPTask[data-focused] {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPTask[data-focused],\r\n.abPTask[data-current] {\r\n  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-border-l2));\r\n}\r\n\r\n.abPTaskSummary {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 6px;\r\n  min-width: 0;\r\n}\r\n\r\n.abPTaskLine {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n  min-width: 0;\r\n}\r\n\r\n.abPTaskPreview {\r\n  min-width: 0;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n}\r\n\r\n.abPTaskMeta {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.abPDot {\r\n  width: 8px;\r\n  height: 8px;\r\n  margin-top: 7px;\r\n  border-radius: 50%;\r\n  background: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPDot[data-tone='business'] { background: var(--dsw-alias-state-business-primary); }\r\n.abPDot[data-tone='warning'] { background: var(--dsw-alias-state-warn-primary); }\r\n.abPDot[data-tone='success'] { background: var(--dsw-alias-state-success-primary); }\r\n.abPDot[data-tone='danger'] { background: var(--dsw-alias-state-error-primary); }\r\n.abPDot[data-tone='tertiary'] { background: var(--dsw-alias-label-tertiary); }\r\n\r\n.abPBadge {\r\n  flex: none;\r\n  padding: 0 7px;\r\n  border: 1px solid transparent;\r\n  border-radius: 5px;\r\n  font-size: 12px;\r\n  line-height: 20px;\r\n  color: var(--dsw-alias-label-secondary);\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPBadge[data-tone='business'] {\r\n  color: var(--dsw-alias-state-business-primary);\r\n  background: var(--dsw-alias-state-business-tertiary);\r\n}\r\n\r\n.abPBadge[data-tone='warning'] {\r\n  color: var(--dsw-alias-state-warn-label);\r\n  background: var(--dsw-alias-state-warn-tertiary);\r\n}\r\n\r\n.abPBadge[data-tone='success'] {\r\n  color: var(--dsw-alias-state-success-primary);\r\n  background: var(--dsw-alias-state-success-tertiary);\r\n}\r\n\r\n.abPBadge[data-tone='danger'] {\r\n  color: var(--dsw-alias-state-error-primary);\r\n  background: var(--dsw-alias-interactive-bg-hover-danger);\r\n}\r\n\r\n.abPBadge[data-kind='dashed'] {\r\n  border-color: var(--dsw-alias-state-warn-primary);\r\n  border-style: dashed;\r\n  background: transparent;\r\n}\r\n\r\n.abPBadge[data-kind='outline'] {\r\n  border-color: var(--dsw-alias-border-l3);\r\n  background: transparent;\r\n}\r\n\r\n.abPFloat {\r\n  position: fixed;\r\n  z-index: 50;\r\n  box-sizing: border-box;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 12px;\r\n  max-height: min(72vh, 560px);\r\n  overflow: auto;\r\n  padding: 14px 16px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 14px;\r\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);\r\n  box-shadow: 0 18px 40px var(--dsw-alias-bg-mask-2);\r\n  backdrop-filter: blur(14px);\r\n  pointer-events: auto;\r\n}\r\n\r\n.abPFloatTop {\r\n  display: grid;\r\n  grid-template-columns: 8px minmax(0, 1fr) auto;\r\n  gap: 10px;\r\n  align-items: start;\r\n}\r\n\r\n.abPFloatTitle {\r\n  min-width: 0;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n}\r\n\r\n.abPChainArrow {\r\n  margin: 0 6px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPCalls {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 10px;\r\n}\r\n\r\n.abPCall {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 6px;\r\n  padding: 10px 12px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 10px;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n}\r\n\r\n.abPCallHead {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  align-items: baseline;\r\n  gap: 2px 0;\r\n}\r\n\r\n.abPCallWho {\r\n  font-size: 14px;\r\n  font-weight: 600;\r\n  line-height: 22px;\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.abPCallRoles {\r\n  margin-left: 8px;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPCallSummary {\r\n  font-size: 13px;\r\n  line-height: 20px;\r\n  color: var(--dsw-alias-label-secondary);\r\n  overflow-wrap: anywhere;\r\n}\r\n\r\n.abPCallCost {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n}\r\n\r\n.abPCallCostName {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.abPContent {\r\n  max-height: 240px;\r\n  margin: 0;\r\n  padding: 10px 12px;\r\n  overflow: auto;\r\n  border-radius: 8px;\r\n  background: var(--dsw-alias-markdown-code-block);\r\n  color: var(--dsw-alias-label-secondary);\r\n  font-family: var(--ds-font-family-code);\r\n  font-size: 12px;\r\n  line-height: 20px;\r\n  white-space: pre-wrap;\r\n  word-break: break-word;\r\n}\r\n\r\n.abPZone {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPZone[data-missing] {\r\n  color: var(--dsw-alias-state-error-primary);\r\n}\r\n\r\n.abPStaff {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  padding-top: 8px;\r\n  border-top: 1px solid var(--dsw-alias-border-l1);\r\n}\r\n\r\n.abPStaffHead {\r\n  font-size: 13px;\r\n  font-weight: 600;\r\n  line-height: 20px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.abPStaffRow {\r\n  display: grid;\r\n  grid-template-columns: 2em minmax(3em, 1fr);\r\n  gap: 4px 10px;\r\n  align-items: baseline;\r\n  padding: 8px 0 0;\r\n  border-top: 1px solid var(--dsw-alias-border-l1);\r\n  font-size: 13px;\r\n  line-height: 20px;\r\n}\r\n\r\n.abPRole {\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPStaffTitle {\r\n  min-width: 2em;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.abPTriple {\r\n  grid-column: 1 / -1;\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: 6px 14px;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-secondary);\r\n  font-variant-numeric: tabular-nums;\r\n}\r\n\r\n@keyframes abPPulse {\r\n  50% { opacity: 0.4; }\r\n}\r\n\r\n@keyframes abPRelease {\r\n  0%,\r\n  100% { box-shadow: 0 0 0 0 transparent; }\r\n  25%,\r\n  70% { box-shadow: 0 0 0 2px var(--dsw-alias-state-success-primary); }\r\n}\r\n\r\n.abPDagPane {\r\n  display: flex;\r\n  flex-direction: column;\r\n  min-width: 0;\r\n  min-height: 0;\r\n  flex: 1;\r\n}\r\n\r\n.abPDagCanvas {\r\n  position: relative;\r\n  min-width: 0;\r\n  min-height: 72px;\r\n  flex: 1 1 42%;\r\n  overflow: hidden;\r\n  cursor: grab;\r\n  touch-action: none;\r\n  overscroll-behavior: none;\r\n  user-select: none;\r\n  background-color: var(--dsw-alias-bg-layer-1);\r\n  background-image: radial-gradient(circle, var(--dsw-alias-border-l2) 1px, transparent 1.2px);\r\n}\r\n\r\n.abPDagCanvas[data-panning],\r\n.abPDagCanvas[data-dragging] {\r\n  cursor: grabbing;\r\n}\r\n\r\n.abPDagWorld {\r\n  position: absolute;\r\n  left: 0;\r\n  top: 0;\r\n  transform-origin: 0 0;\r\n  will-change: transform;\r\n}\r\n\r\n.abPDagSvg {\r\n  position: absolute;\r\n  display: block;\r\n  overflow: visible;\r\n  color: var(--dsw-alias-label-tertiary);\r\n  pointer-events: none;\r\n}\r\n\r\n.abPDagTools {\r\n  position: absolute;\r\n  right: 10px;\r\n  top: 10px;\r\n  z-index: 2;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  padding: 4px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 10px;\r\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);\r\n  backdrop-filter: blur(10px);\r\n}\r\n\r\n.abPDagTool {\r\n  min-width: 28px;\r\n  height: 28px;\r\n  padding: 0 8px;\r\n  border: none;\r\n  border-radius: 7px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-primary);\r\n  font: inherit;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  cursor: pointer;\r\n}\r\n\r\n.abPDagTool:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPDagZoom {\r\n  min-width: 40px;\r\n  padding: 0 4px;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n  font-variant-numeric: tabular-nums;\r\n  text-align: center;\r\n}\r\n\r\n.abPDagEdge {\r\n  fill: none;\r\n  stroke: var(--dsw-alias-border-l3);\r\n  stroke-width: 1.5;\r\n  transition: stroke 150ms var(--ds-ease-in-out, ease), opacity 150ms var(--ds-ease-in-out, ease);\r\n}\r\n\r\n.abPDagEdge[data-tone='ok'] {\r\n  stroke: var(--dsw-alias-state-success-primary);\r\n  color: var(--dsw-alias-state-success-primary);\r\n}\r\n\r\n.abPDagEdge[data-tone='wait'] {\r\n  stroke: var(--dsw-alias-state-warn-primary);\r\n  color: var(--dsw-alias-state-warn-primary);\r\n}\r\n\r\n.abPDagEdge[data-tone='fail'] {\r\n  stroke: var(--dsw-alias-state-error-primary);\r\n  color: var(--dsw-alias-state-error-primary);\r\n}\r\n\r\n.abPDagEdge[data-tone='self'],\r\n.abPDagEdge[data-tone='down'] {\r\n  stroke: var(--dsw-alias-state-business-primary);\r\n  color: var(--dsw-alias-state-business-primary);\r\n}\r\n\r\n.abPDagEdge[data-dim] {\r\n  opacity: 0.22;\r\n}\r\n\r\n.abPDagNode {\r\n  position: absolute;\r\n  box-sizing: border-box;\r\n  display: flex;\r\n  flex-direction: column;\r\n  justify-content: center;\r\n  gap: 2px;\r\n  height: 64px;\r\n  padding: 6px 8px;\r\n  overflow: hidden;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 8px;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  color: inherit;\r\n  font: inherit;\r\n  text-align: left;\r\n  cursor: grab;\r\n  touch-action: none;\r\n  transition:\r\n    border-color 150ms var(--ds-ease-in-out, ease),\r\n    box-shadow 150ms var(--ds-ease-in-out, ease),\r\n    opacity 150ms var(--ds-ease-in-out, ease);\r\n}\r\n\r\n.abPDagNode:hover,\r\n.abPDagNode[data-chain='self'] {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n\r\n.abPDagNode[data-ready] {\r\n  border-style: dashed;\r\n  border-color: var(--dsw-alias-state-business-primary);\r\n}\r\n\r\n.abPDagNode[data-blocked] {\r\n  border-color: var(--dsw-alias-state-warn-primary);\r\n}\r\n\r\n.abPDagNode[data-fail] {\r\n  border-color: var(--dsw-alias-state-error-primary);\r\n}\r\n\r\n.abPDagNode[data-ok] {\r\n  border-color: var(--dsw-alias-state-success-primary);\r\n}\r\n\r\n.abPDagNode[data-chain='self'] {\r\n  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent);\r\n}\r\n\r\n.abPDagNode[data-flare] {\r\n  animation: abPRelease 2s var(--ds-ease-in-out, ease);\r\n}\r\n\r\n.abPDagNode[data-dragging] {\r\n  z-index: 2;\r\n  cursor: grabbing;\r\n}\r\n\r\n.abPDagNode[data-archived] {\r\n  opacity: 0.55;\r\n  cursor: default;\r\n  pointer-events: none;\r\n}\r\n\r\n.abPDagNode[data-dim] {\r\n  opacity: 0.4;\r\n}\r\n\r\n.abPDagNode[data-archived][data-dim] {\r\n  opacity: 0.4;\r\n}\r\n\r\n.abPDagNode[data-current] {\r\n  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-border-l2));\r\n}\r\n\r\n.abPDagNodeTop {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n  min-width: 0;\r\n  overflow: hidden;\r\n}\r\n\r\n.abPDagNode .abPDot {\r\n  margin-top: 0;\r\n  flex: none;\r\n}\r\n\r\n.abPDagNode .abPBadge {\r\n  padding: 0 5px;\r\n  font-size: 11px;\r\n  line-height: 18px;\r\n}\r\n\r\n.abPDagMark {\r\n  min-width: 0;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.abPDagNode[data-fail] .abPDagMark {\r\n  color: var(--dsw-alias-state-error-primary);\r\n}\r\n\r\n.abPDagNodeLabel {\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n}\r\n\r\n.abPDagDetail {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  min-height: 0;\r\n  flex: 1 1 58%;\r\n  max-height: 70%;\r\n  overflow: hidden;\r\n  padding: 10px 12px 12px;\r\n  border-top: 1px solid var(--dsw-alias-border-l2);\r\n  background: var(--dsw-alias-bg-layer-1);\r\n}\r\n\r\n.abPReq {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  min-height: 6.5em;\r\n  flex: 1 1 auto;\r\n  overflow: auto;\r\n}\r\n\r\n.abPReq .abPContent {\r\n  min-height: 3.5em;\r\n  max-height: none;\r\n}\r\n\r\n.abPDagMore {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  flex: 0 1 auto;\r\n  min-height: 0;\r\n  max-height: 38%;\r\n  overflow: auto;\r\n}\r\n\r\n.abPDagDetail .abPContent,\r\n.abPFloat .abPContent {\r\n  max-height: none;\r\n}\r\n\r\n.abPDagFail {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-state-error-primary);\r\n}\r\n\r\n@media (prefers-reduced-motion: reduce) {\r\n  .abPCapsule,\r\n  .abPDrawer,\r\n  .abPAllToggle svg,\r\n  .abPOfflineToggle svg,\r\n  .abPDagEdge,\r\n  .abPDagNode,\r\n  .abPCapsule[data-loading] .abPCapsuleDot,\r\n  .abPCapsule[data-loading] .abPCapsuleCount,\r\n  .abPDagNode[data-flare] {\r\n    transition: none;\r\n    animation: none;\r\n  }\r\n}\r\n"
