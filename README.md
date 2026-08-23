# dsh-agent-bus

**English** | [中文](README.zh.md)

<p>
  <a href="https://github.com/MistyBridge/dsh-agent-bus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
  <a href="https://github.com/MistyBridge/dsh-agent-bus"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-1a73e8" alt="DeepSeek Harness"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.0.0-339933" alt="Node.js"></a>
</p>

# Multi-agent orchestration for DeepSeek Harness

**Turn a workspace of isolated agents into a working team.** Assign work, review output, and run multi-step plans on the inbox you already have — without copy-pasting between them or babysitting the loop.

> dsh-agent-bus is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It gives live sessions in one workspace a durable task ledger, a review loop, and a DAG scheduler — so the **agents do the coordination**, not you.

![Task workbench](docs/images/agent-bus-test.png)

*Task workbench: every job's state, its parties, and its token cost at a glance.*

![Flow (DAG) board](docs/images/QQ_1787487778189.png)

*Flow (DAG) board: a flow's nodes, delivered only after their predecessors settle.*

---

## Why it matters

Harness already runs several agents in one workspace — but it does not let them *collaborate*. In practice that means you are the glue:

- **A planner has no way to hand a coder the brief.** You paste it.
- **A coder has no way to wait for a review.** You paste the patch and ping the reviewer.
- **When step 3 fails**, you reconstruct steps 1–2 from chat logs and re-orchestrate by hand.

agent-bus removes *you* from that loop. It makes the coordination **durable, reviewable, and automatic** — which is what makes it production-usable rather than a chat-based demo.

### What it gives you

| Capability | What you stop doing |
|---|---|
| **Real work items, not messages** | `create_task` is a job with a body, an acceptance bar, and a reviewer. `send_note` stays a lightweight ping. Chat-as-task is what gets work stuck; task-as-chat is what loses review. |
| **Plans that run by themselves** | `create_flow` builds a named DAG: each task dispatches **only after its predecessors settle**. A terminal failure propagates down the chain — no orphaned workers. |
| **A durable task log** | Every job is a ledger row, not buried chat. `get_task` reads a task's whole life; long reports spill to disk, never to a path the model could leak. |
| **Reviewers that actually review** | The worker reports; the reviewer accepts or sends the **same** task back with feedback. The id never changes across rework. |
| **Context that carries itself** | After settle, the executor attaches a handoff (numbers, decisions, caveats) that rides into the downstream task. The next agent reads the chain, not the archaeology. |
| **Memory that survives a crash** | Ledger + inbox checkpoints survive a restart; the plugin re-wakes stranded workers with their full tool set automatically. No one pulls the team back online. |
| **Real specialists, not children** | Every bus peer is a normal dsh session with its own skills, MCP servers, permission preset, and model. `create_member` onboards a full team member in one call, rollback-safe. |

## Where it pays off in production

agent-bus is built for teams that have outgrown "one agent and a lot of copy-paste":

- **A long-running multi-step build** — plan a release, split it into tasks the agents actually execute, and let the DAG dispatch each step only when its dependency is accepted. You watch the panel, not the transcript.
- **A specialist pool with different capabilities** — a coder with a repo MCP, a researcher with a web MCP, a reviewer with a tighter permission set. Each keeps its own config; the bus routes work between them.
- **A reproducible review gate** — every task has an acceptance bar and a reviewer. Nothing is "done" until a named reviewer settles it. This is the difference between a chat and a workflow.
- **An audit trail you can query** — every decision, verdict, and handoff is a ledger row or a stored report. "What was accepted yesterday?" is a `get_task`, not a grep through chat logs.
- **A team that survives a restart** — session compaction and process restarts do not lose the plan or strand a worker. The bus re-wakes everything.

## How it works

Delivery is the harness inbox: one `followup()` per turn, idle sessions take the next item. This plugin does **not** add a second queue.

The plugin's job is the **ledger** — who asked, who does it, what "done" means, what depends on what — plus a panel that reads that ledger.

There is no receive-side tool. The worker sees an ordinary turn. They do the work and call `report_task`.

```
note     send_note              →  peer replies in prose (or not)
task     create_task            →  queued → submitted → working → completed → settle
flow     create_flow + tasks    →  DAG auto-dispatches each node after its predecessors settle
```

Pick the lightest channel that still matches the ask.

## Agent Bus vs sub-agents

Harness already ships **sub-agents**: the parent calls `spawn_subagent`, a child boots, does the job, and returns a **summary**. That is the right tool for "go explore this in isolation and come back."

We did **not** put the team on that architecture. A child **inherits the parent's permission group and session config** — skills, MCP servers, plugin set, model, allowlist. You can trim the toolbelt, but you cannot give the coder a repo MCP, the researcher a web MCP, and the reviewer a tighter tenant allowlist as three different configurations. Fine-grained staffing is exactly what a specialist team needs, and inheritance makes it hard.

So every bus peer **is a normal DeepSeek Harness session** — the same object you already customize. It keeps its own **skills**, **MCP servers**, **plugin group**, **permission preset**, and **model**.

| | **Sub-agent** | **Agent Bus** |
|---|---|---|
| Unit of work | Child session spawned for one job, then gone | `followup()` into an existing peer session |
| What the worker *is* | A disposable child: type + capability mode + optional persona | A **first-class session instance** you configured in dsh |
| Skills / MCP / plugins | Inherited and usually trimmed for the spawn | **Per session**: its own skills, MCP servers, and plugin group |
| Permissions | Parent's envelope, narrowed | **Per session** (and, in a multi-tenant host, per permission group) |
| Topology | Star: parent is the hub | Peers in one workspace + a durable ledger |
| Who reviews | The parent reads a summary | A first-class reviewer accepts or reworks the **same** task id |
| Ordering | Parent must orchestrate every next spawn | DAG: B is not delivered until A is settled |
| Failure | Parent has to notice | Terminal fail/cancel propagates down the chain |
| After restart | The play lives in the parent's context | Ledger + inbox checkpoints survive |
| Parallelism | Many children at once from one parent | Many peers at once; each peer still one inbox item per turn |

**Rule of thumb:** spawn a sub-agent to protect the caller's context for a one-shot. Use the bus when the callee **is** a named teammate — with their own skills, MCP, plugins, and permissions — who will take the next job after this one.

## Quick start

```sh
dsh plugin --profile web add dsh-agent-bus
dsh web
```

From a local checkout:

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

Requires Node.js `^22.19.0` or `>=24.0.0` (same as the harness itself; CI runs on Node 24).

## Tools

| You want to… | Use |
|---|---|
| Ask a peer something that is not a job | `send_note` |
| Give one peer one deliverable to review | `create_task` |
| Run a multi-step plan in order | `create_flow`, then `create_task` with `flow_id` / `dependencies` |
| Finish / accept / rework / stop / ask back / move the job | `report_task` · `settle_task` · `cancel_task` · `request_input` · `reassign_task` |
| Claim a re-delivered task yourself | `claim_task` |
| Answer a worker's structured question | `answer_question` |
| Pass context down the chain | `submit_handoff` |
| Fix an undispatched node, or look things up | `edit_task` · `list_flows` · `list_tasks` · `get_task` |
| Rename a flow so task groups stay manageable | `rename_flow` |
| See who is live, declare what you can do | `list_peers` · `update_card` |
| Onboard a new team member into a workspace | `create_member` |

## Docs

| | |
|---|---|
| [`docs/usage.md`](docs/usage.md) | Handbook (Chinese): tools, state machine, templates |
| [`docs/v1.5-resilience-spec.md`](docs/v1.5-resilience-spec.md) | Offline notes, reassign, offline grace |
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | Event-driven dispatch, flows, handoffs |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A task-state alignment |

## License

MIT
