/**
 * Wake-on-delivery (v1.5): activate a persisted session that is not
 * currently live, so a tool call never fails just because the target's
 * browser tab is closed.
 *
 * The harness exposes `AgentRegistry.resume()` — load a persisted session
 * and run an agent on it (the same mechanism sub-agents use for cold
 * resume). Delivery paths try it before falling back to queued / offline
 * queueing.
 *
 * Model resolution: a browser-attached session's model is injected by the
 * frontend's model-selection (the `{{model}}` persona variable), which a
 * headless resume does not have — without `agentOptions.provider/model`
 * the first prompt assembly fails. The waker therefore inherits the route
 * from a live session's persisted request header, or uses the configured
 * `wakeProvider` / `wakeModel` fallback. Without either, the wake is
 * refused (the caller falls back to queued / offline queueing).
 *
 * Lifecycle: an activated session STAYS live for the process lifetime. The
 * resume handle is a capability — disposing it would remove the session
 * from the store — so the plugin holds it without ever tearing it down; a
 * restart returns the session to dormant and the next delivery wakes it
 * again. Wake is therefore a process-scoped affordance, exactly like the
 * rate limiter.
 *
 * @module dsh-agent-bus/wake
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** Handles of sessions this plugin resumed; a session is never resumed twice. */
const resumed = new Map<string, { agent: Agent }>()

/** Configured fallback route (from plugin config `wakeProvider`/`wakeModel`). */
let configuredRoute: { provider?: string; model?: string } = {}

/** Set the configured fallback route once at plugin mount. */
export function setWakeRoute(route: { provider?: string; model?: string }): void {
  configuredRoute = route
}

/**
 * Inherit the model route from a live session's persisted request header.
 * Any live agent in the process carries the provider/model the frontend
 * selected for it; reusing that route keeps the woken session on the same
 * provider family the workspace is already talking to.
 */
function inheritRoute(ctx: Context): { provider?: string; model?: string } {
  for (const agent of ctx.agents.list()) {
    try {
      const header = agent.session.requestHeader?.()
      const config = header?.config
      if (config?.provider !== undefined && config?.model !== undefined) {
        return { provider: config.provider, model: config.model }
      }
    } catch {
      // A live agent without a readable header is skipped.
    }
  }
  return {}
}

/** Structural face of the session-persistence service (optional at runtime). */
interface PersistenceLike {
  inspect(id: string): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}

/** Structural face of the agent-presets service (optional at runtime). */
interface AgentPresetsLike {
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/**
 * The preset a session actually runs, newest selection winning.
 *
 * The header supplies the creation-time value; every later selection is a
 * logged `agent-preset/selected` event, so the last one is the answer —
 * reading the header alone would rebuild a switched session under the
 * composition it was created with, not the one its history ran under. Same
 * rule as the official resolver (`dsh-agent-presets/session`).
 *
 * @param header - the session's creation header.
 * @param events - the session's event log, oldest first.
 * @returns the preset id, or `undefined` when the deployment composes none.
 */
export function resolveSessionPreset(
  header: SessionHeader,
  events: readonly SessionEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    // The preset-selection event is declared in dsh-agent-presets/session;
    // agent-bus does not depend on that package, so the tag is read through
    // the open event record (a structurally identical `type` string) without
    // narrowing the typed union, which does not know this tag.
    const record = event as unknown as { type?: unknown; data?: { agentPreset?: unknown } }
    if (record.type !== 'agent-preset/selected') continue
    if (typeof record.data?.agentPreset === 'string') return record.data.agentPreset
  }
  return header.agentPreset
}

/**
 * Build the agent-scope setup that restores a dormant session's composition:
 * mount the preset its history ran under (tools, persona, skills). Mirrors
 * the official cold-resume path (`composeAgent` in the host api-proxy):
 * without it a resumed agent runs on host tools only, and the worker's file
 * and shell tools silently disappear after a restart.
 *
 * @param ctx - plugin context carrying the optional agent-presets service.
 * @param header - the session's creation header.
 * @param events - the session's event log.
 * @returns the setup callback, or `undefined` when no preset roster is composed.
 */
export async function composeWakeSetup(
  ctx: Context,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<((agentCtx: Context) => Promise<void>) | undefined> {
  const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (presets === undefined) return undefined
  const presetId = resolveSessionPreset(header, events)
  return async (agentCtx: Context): Promise<void> => {
    await presets.mount(agentCtx, presetId)
  }
}

/**
 * Resolve a session to a live agent, waking it if it is dormant.
 *
 * A live session resolves as-is; a dormant-but-persisted session is resumed
 * through the harness agent registry with an inherited model route AND the
 * preset setup it recorded (so its tools and persona come back intact); a
 * session that cannot be woken (never existed, resume failed, or no model
 * route is available) resolves `undefined` and the caller falls back to its
 * offline behavior (queued task, queued note, refusal).
 *
 * @param ctx - plugin context carrying the agent registry.
 * @param sessionId - the session to make live.
 * @returns the live agent, or `undefined` when the session cannot be woken.
 */
export async function wakeSession(ctx: Context, sessionId: SessionId): Promise<Agent | undefined> {
  const existing = ctx.agents.get(sessionId)
  if (existing !== undefined) return existing
  const cached = resumed.get(String(sessionId))
  if (cached !== undefined) return cached.agent
  const route = configuredRoute.provider !== undefined && configuredRoute.model !== undefined
    ? configuredRoute
    : inheritRoute(ctx)
  if (route.provider === undefined || route.model === undefined) {
    // No model route: a resumed agent's first prompt assembly would fail on
    // the `{{model}}` persona variable. Refuse to wake; the caller queues.
    return undefined
  }
  try {
    // Restore the composition the session recorded, like the official
    // cold-resume path: inspect first, then resume with that setup.
    let setup: ((agentCtx: Context) => Promise<void>) | undefined
    const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
    if (persistence !== undefined) {
      const inspected = await persistence.inspect(String(sessionId))
      setup = await composeWakeSetup(ctx, inspected.meta, inspected.events)
    }
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: route.provider, model: route.model },
      ...(setup === undefined ? {} : { setup }),
    })
    resumed.set(String(sessionId), { agent: handle.agent })
    return handle.agent
  } catch {
    // Corrupt or vanished session: the caller degrades (queued / refused).
    return undefined
  }
}
