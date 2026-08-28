/**
 * The web surface for `agent-bus:web`: the panel snapshot route, the
 * TaskChanged event stream (SSE), the event-driven dispatch endpoint, and the
 * manual archive endpoint, moved verbatim out of the composition root.
 *
 * `webServer` exists only in Web profiles and may bind after this plugin under
 * concurrent activation, so the route registers lazily: try now, then on each
 * service-binding event. A webless profile stays tool-only.
 *
 * @module dsh-agent-bus/web/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildPanelSnapshot, type RecoveryInfo, type StaleInfo } from './panel.ts'
import { dispatchOne } from '../scheduler.ts'
import type { TaskLedger } from '../ledger/ledger.ts'
import type { ReportStore } from '../external.ts'
import { TaskId } from '../domain/types.ts'

/** The web surface host: ledger, reports, and the mutable boot record. */
export interface WebHost {
  readonly ledger: TaskLedger
  readonly reports: ReportStore
  readonly boot: { readonly staleInfo: StaleInfo; readonly recoveryInfo: RecoveryInfo }
}

/**
 * Register the panel snapshot / events / dispatch / archive routes on the web
 * server, if one is present. `webServer` is read lazily via `ctx.get` so a
 * Web profile that binds it after this plugin still gets the routes, and a
 * webless profile never blocks boot.
 *
 * @param ctx - the sub-plugin context.
 * @param host - ledger, reports, and the mutable boot record.
 */
export function registerWebSurface(ctx: Context, host: WebHost): void {
  const { ledger, reports, boot } = host
  let webRegistered = false
  const register = (): void => {
    if (webRegistered) return
    const webServer = ctx.get('webServer') as
      | { register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void }
      | undefined
    if (webServer === undefined) return
    webRegistered = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/state',
      handler: async (_req, res) => {
        try {
          const snapshot = await buildPanelSnapshot(ctx, ledger, reports, Date.now(), boot.staleInfo, boot.recoveryInfo)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(snapshot))
        } catch (error: unknown) {
          ctx.logger.warn(`agent-bus: state route failed: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'snapshot-failed' }))
        }
      },
    }), 'agent-bus: panel route')
    // TaskChanged event stream (SSE) for the client event-driven scheduler.
    // Every ledger mutation emits after the durable write; the panel holds
    // one connection and drives dispatch decisions from these events.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/events',
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        const listener = (event: unknown): void => {
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        const dispose = ctx.on('agent-bus/task-changed', listener)
        req.on('close', dispose)
      },
    }), 'agent-bus: events route')
    // Dispatch endpoint: the client scheduler posts a queued task id once its
    // dependencies have all settled. Idempotent — dispatchOne skips any task
    // that is no longer queued, so concurrent posts and the server backstop
    // sweep can race safely.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/dispatch',
      handler: async (req, res) => {
        const send = (status: number, body: object): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method !== 'POST') {
            send(405, { error: 'method-not-allowed' })
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { taskId?: unknown }
          if (typeof parsed.taskId !== 'string' || parsed.taskId === '') {
            send(400, { error: 'taskId required' })
            return
          }
          const taskId = TaskId(parsed.taskId)
          const task = ledger.get(taskId)
          if (task === undefined) {
            send(404, { error: 'no such task' })
            return
          }
          if (task.status !== 'queued') {
            // Idempotent no-op: already delivered or terminal.
            send(200, { taskId: String(taskId), status: task.status, dispatched: false })
            return
          }
          const outcome = await dispatchOne(ctx, ledger, taskId)
          if (outcome.dispatched) {
            send(200, { taskId: String(taskId), status: 'submitted', dispatched: true })
          } else if (outcome.reason === 'dag-paused') {
            // The DAG switch is paused: the task stays queued and will be
            // picked up when the switch returns to running.
            send(200, { taskId: String(taskId), status: 'queued', dispatched: false, dag: 'paused' })
          } else {
            // no-worker / raced: the row stays where dispatchOne left it (queued).
            send(200, { taskId: String(taskId), status: task.status, dispatched: false })
          }
        } catch (error: unknown) {
          send(500, { error: String(error) })
        }
      },
    }), 'agent-bus: dispatch route')
    // Manual archive endpoint (decision 12): the panel's archive/unarchive
    // buttons POST here. User-driven, never automatic — mirrors the workspace
    // session-archive UX. Archiving is a reversible visibility toggle.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-bus/archive',
      handler: async (req, res) => {
        const send = (status: number, body: object): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method !== 'POST') {
            send(405, { error: 'method-not-allowed' })
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as
            { kind?: unknown; id?: unknown; archived?: unknown }
          if (typeof parsed.kind !== 'string' || typeof parsed.id !== 'string' || parsed.id === '') {
            send(400, { error: 'kind and id required' })
            return
          }
          const archived = parsed.archived !== false
          if (parsed.kind === 'task') {
            const taskId = TaskId(parsed.id)
            const task = ledger.get(taskId)
            if (task === undefined) {
              send(404, { error: 'no such task' })
              return
            }
            const result = await ledger.archiveTask(taskId, archived)
            if (!result.ok) {
              send(400, { error: result.message })
              return
            }
            send(200, { taskId: String(taskId), status: result.task.status, archived })
            return
          }
          if (parsed.kind === 'flow') {
            const flowId = parsed.id
            const flow = ledger.getFlow(flowId)
            if (flow === undefined) {
              send(404, { error: 'no such flow' })
              return
            }
            const result = await ledger.archiveFlow(flowId, archived)
            if (!result.ok) {
              send(400, { error: result.message })
              return
            }
            send(200, { flowId, name: result.flow.name, archived })
            return
          }
          send(400, { error: 'kind must be task or flow' })
        } catch (error: unknown) {
          ctx.logger.warn(`agent-bus: archive route failed: ${String(error)}`)
          send(500, { error: 'archive-failed' })
        }
      },
    }), 'agent-bus: archive route')
  }
  register()
  ctx.on('internal/service', (name) => {
    if (name === 'webServer') register()
  })
}
