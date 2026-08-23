/**
 * DAG board for the v1.4 flow window: pick a flow, then a canvas of that
 * flow's tasks. Archived ancestors fade; live nodes stay interactive.
 *
 * @module dsh-agent-bus/client/DagView
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  blockedByOf,
  callSteps,
  chainToneOf,
  dagOf,
  dependencyChainOf,
  failureReasonOf,
  formatTokenUsage,
  hasFailedDependency,
  hasUnreadableTokens,
  isDagFaded,
  layoutDag,
  relativeTime,
  statusLabel,
  statusTone,
  tasksOfFlow,
  tokensForSession,
  truncateCodePoints,
  visibleDagTasks,
  type ChainTone,
  type FlowView,
  type TaskView,
  type TokenBuckets,
} from './panel-model.ts'

const ROLE_LABEL = {
  initiator: '发起',
  executor: '执行',
  reviewer: '验收',
} as const

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
  return <div className="abPTriple" title={hint}>{formatTokenUsage(tokens)}</div>
}

function StatusDot({ task }: { task: TaskView }): JSX.Element {
  return <span className="abPDot" data-tone={statusTone(task.status, task.outcome)} aria-hidden="true" />
}

function StatusBadge({ task }: { task: TaskView }): JSX.Element {
  return (
    <span className="abPBadge" data-tone={statusTone(task.status, task.outcome)} data-kind={badgeKind(task)}>
      {statusLabel(task.status, task.outcome)}
    </span>
  )
}

function nodeMark(task: TaskView, tasks: readonly TaskView[]): string | null {
  if (isDagFaded(task)) return '已归档'
  const propagated = failureReasonOf(task)
  if (propagated !== null) return propagated
  if (hasFailedDependency(task, tasks)) return '依赖失败'
  if (blockedByOf(task, tasks).length > 0) return '等待依赖'
  return null
}

const ZOOM_MIN = 0.25
const ZOOM_MAX = 2.5
const ZOOM_STEP = 1.12
const DRAG_PX = 5
const GRID_PX = 20
const POS_KEY = 'dsh-agent-bus.dag.pos'
const VIEW_KEY = 'dsh-agent-bus.dag.view'

interface Point {
  readonly x: number
  readonly y: number
}

interface View {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

function readPos(): Record<string, Point> {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, Point>
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePos(pos: Record<string, Point>): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    /* private mode */
  }
}

function readView(): View | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<View>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number' || typeof parsed.zoom !== 'number') {
      return null
    }
    return { x: parsed.x, y: parsed.y, zoom: clampZoom(parsed.zoom) }
  } catch {
    return null
  }
}

function writeView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    /* private mode */
  }
}

function edgePath(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): string {
  const fromCx = from.x + from.w / 2
  const fromCy = from.y + from.h / 2
  const toCx = to.x + to.w / 2
  const toCy = to.y + to.h / 2
  const dx = toCx - fromCx
  const dy = toCy - fromCy
  if (Math.abs(dx) >= Math.abs(dy)) {
    const rightward = dx >= 0
    const sx = rightward ? from.x + from.w : from.x
    const sy = fromCy
    const tx = rightward ? to.x : to.x + to.w
    const ty = toCy
    const curve = Math.max(24, Math.abs(tx - sx) * 0.45)
    const dir = rightward ? 1 : -1
    return `M ${sx} ${sy} C ${sx + dir * curve} ${sy} ${tx - dir * curve} ${ty} ${tx} ${ty}`
  }
  const downward = dy >= 0
  const sx = fromCx
  const sy = downward ? from.y + from.h : from.y
  const tx = toCx
  const ty = downward ? to.y : to.y + to.h
  const curve = Math.max(24, Math.abs(ty - sy) * 0.45)
  const dir = downward ? 1 : -1
  return `M ${sx} ${sy} C ${sx} ${sy + dir * curve} ${tx} ${ty - dir * curve} ${tx} ${ty}`
}

function TaskDetail({
  task,
  nowMs,
  onClose,
}: {
  task: TaskView
  nowMs: number
  onClose: () => void
}): JSX.Element {
  const zone = reportZoneLabel(task.reportZone)
  const steps = callSteps(task)
  const propagated = failureReasonOf(task)
  const criteria = task.acceptanceCriteria
  return (
    <article className="abPDagDetail">
      <div className="abPFloatTop">
        <StatusDot task={task} />
        <div className="abPTaskSummary">
          <div className="abPTaskLine">
            <StatusBadge task={task} />
          </div>
          <div className="abPTaskMeta">
            {`任务时间 ${relativeTime(task.updatedMs, nowMs)}`}
            {task.retries > 0 ? ` · 重做 ${task.retries}` : ''}
            {task.auto ? ' · 自动派发' : ''}
          </div>
        </div>
        <button type="button" className="abPClose" aria-label="关闭任务详情" onClick={onClose}>
          <IconCloseOutline16 size={16} />
        </button>
      </div>
      {propagated !== null && <div className="abPDagFail">{propagated}</div>}
      {task.blockedBy.length > 0 && (
        <div className="abPTaskMeta">{`等待依赖 ${task.blockedBy.join(' · ')}`}</div>
      )}
      <div className="abPReq">
        <div className="abPStaffHead">任务要求</div>
        <pre className="abPContent">{task.content}</pre>
        {criteria !== null && criteria !== '' && (
          <>
            <div className="abPStaffHead">验收标准</div>
            <pre className="abPContent">{criteria}</pre>
          </>
        )}
      </div>
      <div className="abPDagMore">
      <div className="abPStaffHead">
        本任务合计
        {hasUnreadableTokens(task.staff) ? ' · 部分会话不可读' : ''}
      </div>
      <TokenTriple tokens={task.taskTokensTotal} />
      <div className="abPCalls" aria-label="调用过程">
        {steps.map((step, index) => (
          <div key={`${step.from.sessionId}:${step.to.sessionId}:${index}`} className="abPCall">
            <div className="abPCallHead">
              <span className="abPCallWho">{step.from.title}</span>
              <span className="abPChainArrow" aria-hidden="true">→</span>
              <span className="abPCallWho">{step.to.title}</span>
              <span className="abPCallRoles">
                {`${ROLE_LABEL[step.from.role]} · ${ROLE_LABEL[step.to.role]}`}
              </span>
            </div>
            <div className="abPCallSummary">{step.summary}</div>
            <div className="abPCallCost">
              <span className="abPCallCostName">{step.from.title}</span>
              <TokenTriple tokens={tokensForSession(task, step.from.sessionId)} />
            </div>
            <div className="abPCallCost">
              <span className="abPCallCostName">{step.to.title}</span>
              <TokenTriple tokens={tokensForSession(task, step.to.sessionId)} />
            </div>
          </div>
        ))}
      </div>
      {zone !== null && (
        <div className="abPZone" data-missing={task.reportZone === 'missing' || undefined}>
          {zone}
        </div>
      )}
      </div>
    </article>
  )
}

export interface DagViewProps {
  readonly tasks: readonly TaskView[]
  readonly flows: readonly FlowView[]
  readonly selectedFlowId: string | null
  readonly onSelectFlow: (id: string) => void
  readonly onArchiveFlow: (id: string, archived: boolean) => void
  readonly sidebarWidth: number
  readonly onSidebarResizeDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  readonly onSidebarResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  readonly onSidebarResizeUp: () => void
  readonly nowMs: number
  /** Return true when Escape was consumed (pin / detail). */
  readonly consumeEscRef: MutableRefObject<(() => boolean) | null>
}

/**
 * Session rail + layered DAG canvas + detail strip.
 * Empty-canvas drag pans; wheel zooms toward the cursor; nodes drag freely.
 */
export function DagView({
  tasks,
  flows,
  selectedFlowId,
  onSelectFlow,
  onArchiveFlow,
  sidebarWidth,
  onSidebarResizeDown,
  onSidebarResizeMove,
  onSidebarResizeUp,
  nowMs,
  consumeEscRef,
}: DagViewProps): JSX.Element {
  const flowTasks = useMemo(
    () => visibleDagTasks(tasksOfFlow(tasks, selectedFlowId)),
    [tasks, selectedFlowId],
  )
  const graph = useMemo(() => dagOf(flowTasks), [flowTasks])
  const layout = useMemo(() => layoutDag(graph), [graph])
  const [pos, setPos] = useState<Record<string, Point>>(readPos)
  const posRef = useRef(pos)
  posRef.current = pos
  const [view, setView] = useState<View>(() => readView() ?? { x: 24, y: 24, zoom: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const canvasRef = useRef<HTMLDivElement>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [flare, setFlare] = useState<ReadonlySet<string>>(() => new Set())
  const [panning, setPanning] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const seenSuccess = useRef<Set<string> | null>(null)
  const panDrag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const nodeDrag = useRef<{
    id: string
    startX: number
    startY: number
    origX: number
    origY: number
    moved: boolean
  } | null>(null)

  const boxes = useMemo(() => layout.boxes.map(box => {
    const placed = pos[box.id]
    return placed === undefined ? box : { ...box, x: placed.x, y: placed.y }
  }), [layout.boxes, pos])

  const byId = useMemo(() => new Map(boxes.map(box => [box.id, box])), [boxes])
  const taskById = useMemo(() => new Map(layout.boxes.map(box => [box.id, box.task])), [layout.boxes])

  const bbox = useMemo(() => {
    if (boxes.length === 0) return { x: 0, y: 0, w: 1, h: 1 }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const box of boxes) {
      minX = Math.min(minX, box.x)
      minY = Math.min(minY, box.y)
      maxX = Math.max(maxX, box.x + box.w)
      maxY = Math.max(maxY, box.y + box.h)
    }
    const pad = 80
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
  }, [boxes])

  const setViewLive = (next: View, persist: boolean): void => {
    viewRef.current = next
    setView(next)
    if (persist) writeView(next)
  }

  const persistPos = (next: Record<string, Point>): void => {
    posRef.current = next
    setPos(next)
    writePos(next)
  }

  const fitTo = (items: readonly { x: number; y: number; w: number; h: number }[]): void => {
    const el = canvasRef.current
    if (el === null || items.length === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const box of items) {
      minX = Math.min(minX, box.x)
      minY = Math.min(minY, box.y)
      maxX = Math.max(maxX, box.x + box.w)
      maxY = Math.max(maxY, box.y + box.h)
    }
    const pad = 80
    const area = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
    const rect = el.getBoundingClientRect()
    const inset = 28
    const scale = Math.min(
      (rect.width - inset * 2) / Math.max(area.w, 1),
      (rect.height - inset * 2) / Math.max(area.h, 1),
      1.25,
    )
    const zoom = clampZoom(scale)
    setViewLive({
      zoom,
      x: (rect.width - area.w * zoom) / 2 - area.x * zoom,
      y: (rect.height - area.h * zoom) / 2 - area.y * zoom,
    }, true)
  }

  const fitView = (): void => {
    fitTo(boxes)
  }

  const zoomBy = (factor: number, origin?: Point): void => {
    const el = canvasRef.current
    const current = viewRef.current
    const nextZoom = clampZoom(current.zoom * factor)
    if (nextZoom === current.zoom) return
    const rect = el?.getBoundingClientRect()
    const sx = origin?.x ?? (rect === undefined ? 0 : rect.width / 2)
    const sy = origin?.y ?? (rect === undefined ? 0 : rect.height / 2)
    const worldX = (sx - current.x) / current.zoom
    const worldY = (sy - current.y) / current.zoom
    setViewLive({
      zoom: nextZoom,
      x: sx - worldX * nextZoom,
      y: sy - worldY * nextZoom,
    }, true)
  }

  const resetLayout = (): void => {
    const next: Record<string, Point> = {}
    for (const box of layout.boxes) next[box.id] = { x: box.x, y: box.y }
    persistPos(next)
    fitTo(layout.boxes)
  }

  useEffect(() => {
    setPos(current => {
      let changed = false
      const next = { ...current }
      for (const box of layout.boxes) {
        if (next[box.id] !== undefined) continue
        next[box.id] = { x: box.x, y: box.y }
        changed = true
      }
      if (!changed) return current
      writePos(next)
      return next
    })
  }, [layout.boxes])

  useLayoutEffect(() => {
    if (boxes.length === 0) return
    fitTo(boxes)
  }, [selectedFlowId])

  useEffect(() => {
    const el = canvasRef.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      zoomBy(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [flowTasks.length])

  const focusId = pinnedId ?? hoverId
  const chain = useMemo(() => {
    if (focusId === null) return null
    return dependencyChainOf(focusId, graph.nodes)
  }, [focusId, graph.nodes])

  const chainTone = useMemo(() => {
    const tones = new Map<string, ChainTone | 'self' | 'down'>()
    if (focusId === null || chain === null) return tones
    tones.set(focusId, 'self')
    for (const task of chain.upstream) tones.set(task.id, chainToneOf(task))
    for (const task of chain.downstream) tones.set(task.id, 'down')
    return tones
  }, [focusId, chain])

  const detailTask = detailId === null ? null : (taskById.get(detailId) ?? null)

  useEffect(() => {
    consumeEscRef.current = (): boolean => {
      if (pinnedId !== null || detailId !== null) {
        setPinnedId(null)
        setDetailId(null)
        setHoverId(null)
        return true
      }
      return false
    }
    return () => {
      consumeEscRef.current = null
    }
  }, [consumeEscRef, pinnedId, detailId])

  useEffect(() => {
    const success = new Set(
      flowTasks.filter(task => task.status === 'completed' && task.outcome === 'success').map(task => task.id),
    )
    const previous = seenSuccess.current
    seenSuccess.current = success
    if (previous === null) return
    const released = new Set<string>()
    for (const id of success) {
      if (previous.has(id)) continue
      const task = taskById.get(id)
      for (const dep of task?.dependents ?? []) released.add(dep)
    }
    if (released.size === 0) return
    setFlare(current => new Set([...current, ...released]))
    const timer = window.setTimeout(() => {
      setFlare(current => {
        const next = new Set(current)
        for (const id of released) next.delete(id)
        return next
      })
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [flowTasks, taskById])

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.abPDagNode') !== null || target.closest('.abPDagTools') !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panDrag.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: viewRef.current.x,
      origY: viewRef.current.y,
    }
    setPanning(true)
  }

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panDrag.current
    if (pan === null) return
    setViewLive({
      zoom: viewRef.current.zoom,
      x: pan.origX + event.clientX - pan.startX,
      y: pan.origY + event.clientY - pan.startY,
    }, false)
  }

  const onCanvasPointerUp = (): void => {
    if (panDrag.current !== null) writeView(viewRef.current)
    panDrag.current = null
    setPanning(false)
  }

  const onNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string): void => {
    if (event.button !== 0) return
    const task = taskById.get(id)
    if (task !== undefined && isDagFaded(task)) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const box = byId.get(id)
    nodeDrag.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      origX: box?.x ?? 0,
      origY: box?.y ?? 0,
      moved: false,
    }
    setHoverId(id)
  }

  const onNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = nodeDrag.current
    if (drag === null) return
    const zoom = viewRef.current.zoom
    const dx = (event.clientX - drag.startX) / zoom
    const dy = (event.clientY - drag.startY) / zoom
    if (!drag.moved && (dx * dx + dy * dy) * zoom * zoom < DRAG_PX * DRAG_PX) return
    drag.moved = true
    setDraggingId(drag.id)
    const next = {
      ...posRef.current,
      [drag.id]: { x: drag.origX + dx, y: drag.origY + dy },
    }
    posRef.current = next
    setPos(next)
  }

  const onNodePointerUp = (id: string): void => {
    const drag = nodeDrag.current
    nodeDrag.current = null
    setDraggingId(null)
    if (drag === null || drag.id !== id) return
    if (drag.moved) {
      writePos(posRef.current)
      return
    }
    setPinnedId(current => current === id ? null : id)
    setDetailId(id)
  }

  const activeFlows = flows.filter(flow => !flow.archived)
  const archivedFlows = flows.filter(flow => flow.archived)
  const selectedFlow = flows.find(flow => flow.id === selectedFlowId) ?? null
  const grid = GRID_PX * view.zoom

  return (
    <div className="abPBody">
      <nav className="abPSessions" aria-label="流程" style={{ width: sidebarWidth }}>
        <div
          className="abPResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="调节侧栏宽度"
          onPointerDown={onSidebarResizeDown}
          onPointerMove={onSidebarResizeMove}
          onPointerUp={onSidebarResizeUp}
          onPointerCancel={onSidebarResizeUp}
        />
        <div className="abPFlowHead">活跃</div>
        <div className="abPFlowList">
          {activeFlows.length === 0 && (
            <div className="abPFlowEmpty">暂无活跃流程</div>
          )}
          {activeFlows.map(flow => (
            <button
              key={flow.id}
              type="button"
              className="abPFlow"
              data-active={selectedFlowId === flow.id || undefined}
              onClick={() => onSelectFlow(flow.id)}
            >
              <span
                className="abPFlowName"
                style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {flow.name}
              </span>
            </button>
          ))}
        </div>
        {archivedFlows.length > 0 && (
          <div className="abPGroup">
            <div className="abPFlowHead">归档</div>
            <div className="abPFlowList">
              {archivedFlows.map(flow => (
                <button
                  key={flow.id}
                  type="button"
                  className="abPFlow"
                  data-active={selectedFlowId === flow.id || undefined}
                  data-archived
                  onClick={() => onSelectFlow(flow.id)}
                >
                  <span
                    className="abPFlowName"
                    style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {flow.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>
      <div className="abPDagPane">
        {selectedFlow !== null && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l2)',
            }}
          >
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
              }}
            >
              {selectedFlow.name}
            </span>
            <button
              type="button"
              style={{
                flex: 'none',
                marginLeft: 'auto',
                height: 28,
                padding: '0 10px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 12,
                lineHeight: 1,
                cursor: 'pointer',
              }}
              onClick={() => onArchiveFlow(selectedFlow.id, selectedFlow.archived !== true)}
            >
              {selectedFlow.archived === true ? '取消归档' : '归档'}
            </button>
          </div>
        )}
        {selectedFlow === null ? (
          <div className="abPEmpty">
            <div className="abPEmptyTitle">选择一个流程</div>
            <div className="abPEmptyHint">左侧点选后，这里会画出它的任务图</div>
          </div>
        ) : flowTasks.length === 0 ? (
          <div className="abPEmpty">
            <div className="abPEmptyTitle">{`${selectedFlow.name} 还没有任务`}</div>
            <div className="abPEmptyHint">归入这个流程的任务会出现在画布上</div>
          </div>
        ) : (
          <div
            ref={canvasRef}
            className="abPDagCanvas"
            data-panning={panning || undefined}
            data-dragging={draggingId !== null || undefined}
            style={{
              backgroundSize: `${grid}px ${grid}px`,
              backgroundPosition: `${view.x}px ${view.y}px`,
            }}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={onCanvasPointerUp}
            onDoubleClick={event => {
              if (event.target instanceof Element && event.target.closest('.abPDagNode') !== null) return
              fitView()
            }}
            onMouseLeave={() => {
              if (draggingId === null) setHoverId(null)
            }}
          >
            <div
              className="abPDagWorld"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
            >
              <svg
                className="abPDagSvg"
                width={bbox.w}
                height={bbox.h}
                viewBox={`${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`}
                style={{ left: bbox.x, top: bbox.y }}
                aria-hidden="true"
              >
                <defs>
                  <marker id="abPDagArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
                  </marker>
                </defs>
                {graph.edges.map(edge => {
                  const from = byId.get(edge.from)
                  const to = byId.get(edge.to)
                  if (from === undefined || to === undefined) return null
                  const inChain = focusId !== null && chainTone.has(edge.from) && chainTone.has(edge.to)
                  const tone = inChain ? (chainTone.get(edge.from) ?? 'wait') : undefined
                  return (
                    <path
                      key={`${edge.from}:${edge.to}`}
                      className="abPDagEdge"
                      d={edgePath(from, to)}
                      data-tone={tone}
                      data-dim={focusId !== null && !inChain || undefined}
                      markerEnd="url(#abPDagArrow)"
                    />
                  )
                })}
              </svg>
              {boxes.map(box => {
                const faded = isDagFaded(box.task)
                const mark = nodeMark(box.task, flowTasks)
                const ready = box.task.status === 'queued'
                const failedDep = hasFailedDependency(box.task, flowTasks) || failureReasonOf(box.task) !== null
                const blocked = blockedByOf(box.task, flowTasks).length > 0
                const settledOk = box.task.status === 'completed' && box.task.outcome === 'success'
                const tone = chainTone.get(box.id)
                const dim = !faded && focusId !== null && tone === undefined
                return (
                  <button
                    key={box.id}
                    type="button"
                    className="abPDagNode"
                    style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                    data-tone={statusTone(box.task.status, box.task.outcome)}
                    data-chain={tone}
                    data-blocked={blocked || undefined}
                    data-ready={ready || undefined}
                    data-fail={failedDep || undefined}
                    data-ok={settledOk || undefined}
                    data-flare={flare.has(box.id) || undefined}
                    data-dim={dim || undefined}
                    data-archived={faded || undefined}
                    data-dragging={draggingId === box.id || undefined}
                    disabled={faded}
                    aria-pressed={pinnedId === box.id}
                    aria-label={`${statusLabel(box.task.status, box.task.outcome)} ${box.task.title ?? box.task.contentPreview}`}
                    onMouseEnter={() => { if (!faded) setHoverId(box.id) }}
                    onFocus={() => { if (!faded) setHoverId(box.id) }}
                    onPointerDown={event => onNodePointerDown(event, box.id)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={() => onNodePointerUp(box.id)}
                    onPointerCancel={() => onNodePointerUp(box.id)}
                  >
                    <span className="abPDagNodeTop">
                      <StatusDot task={box.task} />
                      <StatusBadge task={box.task} />
                    </span>
                    <span className="abPDagNodeLabel">
                      {truncateCodePoints(box.task.title ?? box.task.contentPreview, 18)}
                    </span>
                    {mark !== null && <span className="abPDagMark">{mark}</span>}
                  </button>
                )
              })}
            </div>
            <div className="abPDagTools" onPointerDown={event => event.stopPropagation()}>
              <button type="button" className="abPDagTool" aria-label="缩小" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
              <span className="abPDagZoom">{`${Math.round(view.zoom * 100)}%`}</span>
              <button type="button" className="abPDagTool" aria-label="放大" onClick={() => zoomBy(ZOOM_STEP)}>+</button>
              <button type="button" className="abPDagTool" aria-label="适应画布" onClick={fitView}>适应</button>
              <button type="button" className="abPDagTool" aria-label="恢复自动布局" onClick={resetLayout}>复位</button>
            </div>
          </div>
        )}
        {detailTask !== null && (
          <TaskDetail
            task={detailTask}
            nowMs={nowMs}
            onClose={() => {
              setDetailId(null)
              setPinnedId(null)
            }}
          />
        )}
      </div>
    </div>
  )
}
