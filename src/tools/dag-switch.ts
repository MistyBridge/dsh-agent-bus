/**
 * The DAG persistent switch (module-map §4): `set_dag_state` tool.
 *
 * A global durable switch `dag: 'running'|'paused'` on the ledger's domain
 * global gates **new** deliveries: `paused` suppresses every `dispatchOne`
 * (queued → submitted) with `{dispatched:false, reason:'dag-paused'}` and zero
 * side effects, until the switch returns to `running` — at which point the
 * ready-but-undelivered queued tasks are caught up via `dispatchReadyTasks`.
 *
 * @module dsh-agent-bus/tools/dag-switch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TaskLedger } from '../ledger/ledger.ts'
import { dispatchReadyTasks } from '../scheduler.ts'
import { checkedTool } from './checked-tool.ts'
import { requireCaller, type ToolsConfig, type ToolsDeps } from './common.ts'

/** The JSON input `set_dag_state` accepts. */
export interface SetDagStateInput {
  readonly dag: 'running' | 'paused'
}

/** The parsed plan the orchestrator drives. */
export interface SetDagStatePlan {
  readonly dag: 'running' | 'paused'
}

/** Parser outcome: a validated plan, or a field-naming refusal. */
export type SetDagStateParseResult =
  | { readonly ok: true; readonly plan: SetDagStatePlan }
  | { readonly ok: false; readonly error: string }

/**
 * The structural host port the orchestrator drives: the ledger (for the durable
 * switch) and an optional resume sweep that catches up queued tasks on resume.
 */
export interface SetDagStateHost {
  readonly ledger: TaskLedger
  /** Catch-up sweep run when the switch returns to `running` (default `dispatchReadyTasks`). */
  readonly resume?: () => Promise<number>
}

/** The result returned to the caller. */
export interface SetDagStateResult {
  readonly dag: 'running' | 'paused'
  /** Tasks caught up by the resume sweep (0 unless resuming). */
  readonly resumed: number
}

/**
 * Validate one raw `set_dag_state` argument object into a plan.
 *
 * @param raw - the tool arguments, already schema-validated at the wire.
 * @returns a validated plan, or a refusal naming the field.
 */
export function parseSetDagStateInput(raw: unknown): SetDagStateParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'set_dag_state: input must be a JSON object' }
  }
  const input = raw as Record<string, unknown>
  if (input.dag !== 'running' && input.dag !== 'paused') {
    return { ok: false, error: 'set_dag_state: field "dag" must be one of running|paused' }
  }
  return { ok: true, plan: { dag: input.dag } }
}

/**
 * Drive the switch against the host port.
 *
 * Sets the durable switch, and on `running` runs the resume sweep so a paused
 * backlog of ready-but-undelivered queued tasks is caught up immediately.
 *
 * @param host - the host port (live services or test mocks).
 * @param plan - the validated plan from {@link parseSetDagStateInput}.
 * @returns the new state and how many tasks the resume caught up.
 */
export async function setDagState(
  host: SetDagStateHost,
  plan: SetDagStatePlan,
): Promise<SetDagStateResult> {
  const result = await host.ledger.setDagState(plan.dag)
  if (!result.ok) throw new Error(result.message)
  let resumed = 0
  if (plan.dag === 'running' && host.resume !== undefined) {
    resumed = await host.resume()
  }
  return { dag: result.dag, resumed }
}

/**
 * Register `set_dag_state`, gated by `checkedTool`.
 *
 * @param ctx - context carrying the tool registry.
 * @param config - resolved tunables.
 * @param deps - the opened ledger.
 */
export function registerDagTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  ctx.tools.register(checkedTool({
    name: 'set_dag_state',
    description:
      'Set the durable DAG dispatch switch. `running` (default) auto-dispatches every queued task '
      + 'whose dependencies are settled; `paused` suppresses ALL new deliveries (running and queued '
      + 'tasks are untouched) until the switch returns to `running`, which immediately catches up '
      + 'the ready-but-undelivered queued tasks. Use this to freeze new work (e.g. before a wide '
      + 'refactor) without disturbing tasks already in flight.',
    parameters: {
      dag: {
        type: 'string',
        enum: ['running', 'paused'],
        required: true,
        description: 'The new dispatch state: running (auto-dispatch) or paused (suppress new deliveries).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dag: { type: 'string', required: true },
          resumed: { type: 'number', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `DAG dispatch ${result.dag}` + (result.resumed > 0 ? `; 已补投 ${result.resumed} 个就绪任务` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:设置DAG开关', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:设置DAG开关', rawInput: result }),
    async execute(args, exec) {
      requireCaller(exec.agent, 'set_dag_state')
      const parsed = parseSetDagStateInput(args)
      if (!parsed.ok) throw new Error(parsed.error)
      const host: SetDagStateHost = {
        ledger: deps.ledger,
        resume: () => dispatchReadyTasks(ctx, deps.ledger),
      }
      return setDagState(host, parsed.plan)
    },
  }))
}
