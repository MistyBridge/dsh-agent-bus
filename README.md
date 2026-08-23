# dsh-agent-bus

**English** | [中文](README.zh.md)

<p>
  <a href="https://github.com/MistyBridge/dsh-agent-bus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
  <a href="https://github.com/MistyBridge/dsh-agent-bus"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-1a73e8" alt="DeepSeek Harness"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933" alt="Node.js"></a>
</p>

**Multi-agent orchestration for DeepSeek Harness.** Stop being the messenger.

dsh-agent-bus is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns live sessions in one workspace into an orchestra: they assign work, review each other’s output, and run multi-step DAG workflows — on the inbox you already have.

You keep the specialists. You stop copy-pasting.

## What the plugin does

Two live screens from a real team running on the bus:

![Task workbench](docs/images/agent-bus-test.png)

*Task workbench: every job's state, its parties, and its tokens at a glance.*

![Flow (DAG) board](docs/images/QQ_1787487778189.png)

*Flow (DAG) board: a flow's nodes, delivered only after their predecessors settle.*

- **Assign work, not messages** — `create_task` gives one peer a deliverable with an acceptance bar and a reviewer; `send_note` stays a lightweight ping with no lifecycle. The right channel for the right ask, and the panel shows every job’s state at a glance.
- **Run plans without you in the loop** — `create_flow` builds a named DAG: each task dispatches only after its predecessors settle, and a terminal failure propagates down the chain. The flow board renders one flow at a time with archived ancestors faded.
- **Staff real specialists** — every peer is a normal dsh session with its own skills, MCP servers, permission preset, and model. `create_member` onboards a full team member (workspace binding, naming, role, skills, permissions, capability card) in one call, with rollback on failure.
- **Recover from crashes automatically** — after a restart the plugin re-wakes every stranded worker with its full tool set and posts one recovery notice each. No one has to pull the team back online by hand.
- **Keep the team honest** — completed and archived tasks are public history; live tasks are readable only by their parties. PMs review their workers' approvals; workers claim their own re-deliveries; flows get names you can manage (`rename_flow`).

## Why this exists

Harness already runs several agents in one workspace. It does not let them *collaborate*.

Without this plugin:

- A planner cannot give a coder a job. You paste the brief.
- A coder cannot wait for a reviewer. You paste the patch.
- When step 3 fails, you reconstruct steps 1–2 from chat logs.

Let the bus run the team. Don’t be the messenger.

## What you actually get

**Talk stays talk.** A question, a ping, a “look at this” is `send_note`. No ledger, no review, no timeout theatre. If the peer is offline, the note waits and delivers when they come back.

**Work stays work.** `create_task` is a job with a body, an optional acceptance bar, and a reviewer. The worker reports; the reviewer accepts or sends the *same* task back with feedback. The id never changes across rework.

**A plan can run without you in the loop.** `create_flow` is a named DAG. You (or the planner agent) write the plan, then create tasks with `flow_id` and `dependencies`. Task B is not even delivered until A is accepted. If A is canceled or fails for good, B and C fail with it — no orphaned workers.

**The next agent reads the chain, not the archaeology.** After settle, the executor can attach a handoff (numbers, decisions, caveats). Dispatch concatenates that into the downstream task. Step 3 does not have to `get_task` its way through step 1.

**You can see it.** On the web profile a capsule on the right opens a workbench: a task list, and a per-flow DAG canvas. Click a node for the full requirement. Archived ancestors stay on the graph, faded.

## The task log

Chat logs are a lousy work tracker. They mix pings with jobs, they vanish when a session is compacted, and the next agent cannot query “what was accepted yesterday.”

Agent-bus keeps a **task log** next to the conversation — a durable record of every real job, not a dump of every message.

**Notes stay in the session.** `send_note` is conversation. It does not create a ledger row, it does not show up on the panel, and it does not need a report. The jsonl of that session *is* the log.

**Tasks get a ledger row.** Each `create_task` writes who asked, who does it, who reviews, the requirement, optional acceptance criteria, dependencies, and later the verdict. Status moves on that row (`queued` → `submitted` → `working` → `completed` → settle). Rework is the same id; you can read the whole life of one job with `get_task`.

**The report is stored as a document, not as more chat.** Short reports sit inline on the row. Long ones spill to disk, keyed by task id — never by a filesystem path the model could leak:

| Zone | Where | What |
|---|---|---|
| Hot | `~/.dsh/agent-bus/cache/` | Active-task reports; unused files are swept after 7 days |
| Cold | `~/.dsh/agent-bus/archive/` | Terminal tasks (`completed` / `failed` / `canceled`); swept after 30 days |

`get_task` reads hot then cold. Agents never see the split. The ledger itself lives in the harness storage domain (`agent_bus`); every open also writes a JSON snapshot under `~/.dsh/agent-bus/backups/` (last 20 kept) so a schema rebuild cannot silently eat the table.

**What you browse vs what agents list.** The panel is the human log: active work, archive (settled more than 24 hours, or failed/canceled), tokens, and the DAG for a flow. `list_tasks` hides archived rows on purpose — the worker’s inbox is not a history dump. History is the panel, `get_task`, and the session log.

That is the point: the next specialist, the reviewer, and you all read the **same** record instead of reconstructing the job from three chat windows.

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

The web-app bundle already mounts storage and the workspace registry. A custom or headless profile must declare `storage`, `storage-json`, `storage-domain`, and `workspace` in its own `cordis.patch.yml` — load fails loudly otherwise. A gateway that cannot record must not boot as a silent prompt.

Requires Node.js `^22.19.0` or `>=24`.

## How it works

Delivery is the harness inbox: one `followup()` per turn, idle sessions take the next item. This plugin does **not** add a second queue.

The plugin’s job is the **ledger** — who asked, who does it, what “done” means, what depends on what — plus a panel that reads that ledger.

There is no receive-side tool. The worker sees an ordinary turn. They do the work and call `report_task`.

```
note     send_note              →  peer replies in prose (or not)
task     create_task            →  queued → submitted → working → completed → settle
flow     create_flow + tasks    →  DAG auto-dispatches each node after its predecessors settle
```

Pick the lightest channel that still matches the ask. Chat-as-task is how work gets stuck in `working`. Task-as-chat is how you lose review.

## Agent Bus vs sub-agents

### Why we did not build on sub-agents

Harness already ships **sub-agents**: the parent calls `spawn_subagent`, a child boots, does the job, and returns a **summary**. That is the right tool for “go explore this in isolation and come back.”

We did **not** put the team on that architecture. A child **inherits the parent’s permission group and session config** — skills, MCP servers, plugin set, model, allowlist. You can trim the toolbelt (agent type, capability mode, persona). You cannot give the coder a repo MCP, the researcher a web MCP, and the reviewer a tighter tenant allowlist as three different configurations. Fine-grained staffing is exactly what a specialist team needs, and inheritance makes it hard.

So every bus peer **is a normal DeepSeek Harness session** — the same object you already customize. It keeps its own **skills**, **MCP servers**, **plugin group**, **permission preset**, and **model**. That is how you staff a team, and it is the same session model a multi-tenant host hangs **permission groups** and **plugin groups** on: per tenant, per role, not “whatever the parent spawned.”

| | **Sub-agent** | **Agent Bus** |
|---|---|---|
| Unit of work | Child session spawned for one job, then gone | `followup()` into an existing peer session |
| What the worker *is* | A disposable child: type + capability mode + optional persona | A **first-class session instance** you configured in dsh |
| Skills / MCP / plugins | Inherited and usually trimmed for the spawn | **Per session**: its own skills, MCP servers, and plugin group |
| Permissions | Parent’s envelope, narrowed | **Per session** (and, in a multi-tenant host, per permission group) |
| Topology | Star: parent is the hub | Peers in one workspace + a durable ledger |
| Who reviews | The parent reads a summary | A first-class reviewer accepts or reworks the **same** task id |
| Ordering | Parent must orchestrate every next spawn | DAG: B is not delivered until A is settled |
| Failure | Parent has to notice | Terminal fail/cancel propagates down the chain |
| After restart | The play lives in the parent’s context | Ledger + inbox checkpoints survive |
| Parallelism | Many children at once from one parent | Many peers at once; each peer still one inbox item per turn |

### Where the cost actually goes

No fake speedup numbers — the difference is **where tokens and latency are spent**.

| Cost | Sub-agent | Agent Bus |
|---|---|---|
| **Prompt cache** | Every spawn pays a **cold** prefix (system prompt, tools, instructions). | A specialist is a long-lived session. The next task is another user turn on a **warm** prefix. |
| **Orchestrator context** | Each child’s summary lands **in the parent window**. N jobs → parent context grows with N summaries. | The initiator gets a short inbox notice. The full report lives in the ledger (and on disk when large). `get_task` is on demand. |
| **Time to first token** | Session boot + first decode on a cold cache. | Idle live peer: next turn **now**, no new process. |
| **Specialist memory** | Dies with the child. Job 4 does not remember job 3 unless the parent stuffed it into the next spawn prompt. | The same coder session still has job 3 in its window (and files in the workspace). Handoffs carry the rest. |
| **Throwaway explore** | **Use this.** Isolated window, parent cache untouched. | Don’t. A peer session is a person on the team, not a sandbox. |

**Rule of thumb:** spawn a sub-agent to protect the caller’s context for a one-shot. Use the bus when the callee **is** a named teammate — with their own skills, MCP, plugins, and permissions — who will take the next job after this one.

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
