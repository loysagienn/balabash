# Balabash

A self-hosted personal AI assistant that lives in a Telegram group — built as a team of
agents working over a single append-only event log.

You talk to it like you talk to people: the secretary answers in the General topic,
and every substantial task gets its own specialist agent in its own forum topic. When a
task is done, the topic is renamed after the work, closed with a summary, and becomes
part of a readable archive. Under the hood, everything — every message, tool call,
spawned thread, completed task — is an immutable event in one Postgres log, and the rest
of the system is a projection of it.

## What it feels like to use

**A Telegram group is the workspace.** Add the bot to a group with Topics enabled and
the group becomes a shared workspace: everyone in the group talks to the same assistant,
and every message carries the speaker's identity into the agents' context — the system
is multi-voice by design.

- **General topic** — the secretary: a fast dispatcher that answers directly, uses
  tools, and delegates real work to specialist agents.
- **One forum topic per task** — each spawned agent gets its own topic; you talk to the
  specialist directly, without the secretary relaying. When the thread ends, the topic
  is renamed to describe the work, a summary (with any result files) is posted, and the
  topic is closed. Closed topics are the archive.
- **Files flow both ways** — send documents and photos into any topic; agents send back
  reports, downloads, screenshots, and email attachments as documents.
- **Notifications know their place** — routine notifications respect your per-topic mute
  settings; urgent ones additionally break out into General with a deep link to the
  topic that needs you.

## The agent team

| Agent | What it does |
|---|---|
| **secretary** | Owns the main thread. Dispatches, answers quick questions, operates tools, spawns everyone else. |
| 🎩 **manager** | General-purpose task executor working through the connected integrations; can drive the browser. |
| **browser** | A real Chromium session driven via Playwright — a headless sub-agent operated by other agents. Runs headful on a virtual display, so you can watch it (and take over for logins or CAPTCHAs) through VNC. |
| 🔑 **auth** | Connects and re-authorizes integrations. Only ever sends links — credential values never pass through it. |
| ⏰ **scheduler** | Engineers scheduled code tasks: writes the task body, registers it, rebuilds, requests a restart. |
| 🛠 **engineer** | Balabash's own engineer — edits the system's source code in a live session, builds, and requests a restart of itself. |
| 📐 **architect** | Design analysis and audits at maximum reasoning effort; advises, never implements. |
| 🤖 **codex** | An autonomous OpenAI Codex session with the full Balabash toolset. |

Agents that can change the system (engineer, scheduler, architect) are **consent-gated**:
no agent can spawn them as a side effect of its plan — only the secretary starts them,
on an explicit user request, and that rule is enforced in code, not in prompts.

Three model vendors run side by side behind one session contract: the secretary runs
on an OpenAI model, most agents on Claude (via the Claude Agent SDK), and the codex
agent on OpenAI Codex. An agent picks its backend with a one-line declaration.

## Capabilities

**Integrations out of the box**
- **Gmail** — search, read, threads, attachments, drafts, send; per-user Google OAuth.
- **Notion** — the official hosted MCP server; each user connects their own workspace.
- **Perplexity** — ask / search / reason / deep research.
- **Web** — fetch pages and download files into storage, with SSRF protection
  (DNS/IP blocklists, redirect and size caps).
- **Browser** — a persistent per-user Chromium profile for anything without an API.
- Any other **MCP server** (stdio or HTTP) can be added with a JSON file; OAuth
  (discovery + dynamic client registration + PKCE) and `${secret:NAME}` credentials are
  handled by the platform.

**A data workbench per user** — agents get a private SQLite database, a scoped file
area, and a script runner (Python/Node), so bulk data moves disk-to-disk instead of
through model context. The iron rule: data goes to tables and files, the model sees only
short summaries.

**Scheduling — the organ of initiative.** A durable registry of named tasks: recurring
(cron, alarm-clock semantics), one-shot ("not before T", consumed by firing), or
trigger-less stored procedures. A task is either a **note** — fired into the main thread
for the secretary to interpret ("remind me", "check X every morning") — or **code** —
a TypeScript body shipped in the repo and written by the scheduler agent. Every agent
can operate the registry; the event log is the audit trail.

**Self-extension.** The engineer agent works in the Balabash repository itself, with the
running system as its subject. A restart is a first-class event: it is *requested* into
the log, then waits for a structurally safe window — no active task threads, no turn in
flight, a quiet log — before the process exits and the supervisor relaunches it. If a
new build crash-loops, the supervisor rolls back to the last good bundle, and the fresh
process reports the rollback honestly into the log.

**A web window.** A minimal web UI accompanies the chat: log in with a one-time code
from the bot (no passwords), browse threads with status filters, and inspect any
thread's raw event feed — every event, payload included, exactly as stored.

## Security posture

- **Credentials never touch the chat, the model, or the log.** API keys and OAuth
  client secrets are entered through one-time web forms that submit straight to storage;
  the event log records only sanitized facts ("secrets provisioned: field names").
  OAuth tokens live in one table and nowhere else.
- **Re-authorization is automatic.** When a token expires, a detector opens an auth
  thread and notifies you — one active auth thread per workspace, no flooding.
- **Consent is structural.** Sensitive tool servers (auth, restart) are excluded from
  the default bundle and reach only agents that name them explicitly; consent-gated
  agents cannot be spawned by other agents. A spawner may narrow a child's tool bundle,
  and narrowing only ever shrinks.
- **Workspace isolation is enforced at every model-facing edge.** A file or thread id
  from another workspace yields the same "not found" as a missing one — existence is
  never leaked. Caller identity comes from the platform, never from model-visible
  arguments.
- **Everything is auditable.** Every tool call from every model loop is journaled into
  the event log — started, completed with the verbatim result, or failed.

## Architecture

The design thesis: **the system is a set of parallel agent runs over one append-only
event log; each run owns a thread — its context and its visibility boundary.**

- **The log is the only source of truth.** Events are immutable rows in Postgres with a
  global sequence. The threads table is a private memoization that can be truncated and
  rebuilt from the log by a plain fold; even cascade cancellations write one explicit
  event per descendant so replay stays deterministic.
- **One append point owns all invariants** — transactionally, with row locks: one main
  thread per workspace, exactly one terminal event per thread (first wins), workspace
  isolation, one-hop addressing.
- **Threads form a tree with hard visibility boundaries.** A thread's transcript is the
  events it authored plus the events addressed to it; an event may only address its
  author's parent or a direct child. A parent never sees a grandchild's inner work —
  only lifecycle and summaries. Context management is a data invariant, not a prompt
  convention.
- **Runs are ephemeral; the log is durable.** In-memory runs are never persisted; on
  boot, orphaned threads are tombstoned and events addressed to dead threads are
  redirected to the main thread so no fact is lost.
- **Agents are declarations.** An agent is a small module declaring its SDK, tools,
  spawn rights, and consent requirements; the platform supplies the session lifecycle,
  the event-to-message rendering, live tool-catalog sync, and the standard verbs
  (`end_thread`, `send_file`, spawning). An imperative `run()` exists as the escape
  hatch (the browser agent uses it).
- **Degrade loudly, roll back automatically.** A failed migration boots the old schema
  with a loud exception; a bad tool schema is skipped; a failing consumer is journaled
  and skipped — but a broken agent declaration fails the boot atomically, exactly where
  the supervisor's bundle rollback can act on it.

## Stack

TypeScript on Node.js ≥ 24, single process, esbuild-bundled. PostgreSQL (Prisma) for
the event log, S3-compatible object storage for files, grammY for Telegram, Koa +
Next.js for the web surface, MCP as the tool protocol, Claude Agent SDK / OpenAI
Responses API / Codex SDK as model backends.

## Status

A personal system, built for its own operator and developed live — by its own agents,
among others. Expect sharp edges; read the log.
