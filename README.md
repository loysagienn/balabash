# Balabash

A self-hosted personal AI assistant: a team of agents over one append-only event log, run
by one person on their own server.

Balabash is a single Node.js process that owns a PostgreSQL event log and talks to the
user through three surfaces — a web console, a Telegram forum group and the Claude app's
remote sessions. A secretary agent answers in the main thread and hands substantial work
to specialist agents, each in a thread of its own; agents operate integrations (Gmail,
Google Drive, Notion, Perplexity, a real browser, any MCP server), keep data in a
per-workspace workbench (SQLite + a file area + a script runner), run scheduled tasks,
publish mini-apps, and change Balabash's own code — the engineer agent works on the live
system and requests its restart. Every message, tool call, spawned thread and completed
task is an immutable event in the log; everything else is a projection of it.

Setup and operation: [SETUP.md](SETUP.md). Working on the code: [DEVELOPMENT.md](DEVELOPMENT.md).

## Surfaces

- **Web console** (`CONSOLE_DOMAIN`) — a browser SPA served by the core itself. The main
  thread's chat, every thread live (stream, tool calls, files, the agent's state), the agent
  catalog, projects and the workspace file area, mini-apps, scheduled tasks and their runs,
  connections and installation secrets, settings, plan limits of the Claude and Codex
  accounts, the system journal and the machine's readings. Sign-in is a one-time code — from
  the bot (`/auth_code`) or, for the operator, printed to the server log by the `/login` page;
  no passwords. Installable on a phone's home screen.
- **Telegram forum group** — a group with Topics is a workspace. The secretary answers in
  General; every spawned agent gets a forum topic, where the user talks to the specialist
  directly. When a thread ends, its topic is renamed after the work, closed with a summary
  and any result files, and stays as the archive. Documents and photos flow both ways.
  Every member of the group is a user of the workspace; messages carry the speaker's
  identity into the agents' context.
- **Claude app remote sessions** (CCR) — every thread of a Claude-based agent (engineer,
  manager, architect, …) is mirrored as a remote-control session of the operator's Claude
  app: the agent's live stream, the Stop button, messages from the phone.

## The agent team

| Agent | What it does |
|---|---|
| **secretary** | Owns the main thread. Answers directly, operates tools, spawns everyone else; interprets scheduled notes. |
| 🎩 **manager** | General-purpose task executor over the connected integrations; drives the browser and the image generator through sub-agents. |
| 🤖 **codex** | The manager on OpenAI Codex: the same brief, tools and workbench, run as a Codex session. |
| 🛠 **engineer** | Software engineering on the host with the native toolset (shell, files, web, git) in whatever repository a task or a project points to — Balabash's own included, where it builds and requests a restart of itself. |
| 📐 **architect** | Architectural reasoning and audits at maximum reasoning effort; advises, never implements. |
| ⏰ **scheduler** | Engineers scheduled tasks that need code: workspace jobs and `run(ctx)` bodies. |
| 🎨 **designer** | Design work in Claude Design on claude.ai (Artifacts): design canvases of UI screens, landing pages and option boards, design systems, decks; verifies its renders in its own browser with a fresh-eyes verifier. |
| 🌿 **gardener** | One care pass over a project library: drains the inbox into the settled files and the journal, consolidates, reports every removal. |
| 🔑 **auth** | Connects, re-authorizes and provisions integrations. Sends links only — credential values never pass through it. |
| **browser** | A headless sub-agent driving a real Chromium through Playwright; headful on a virtual display so the user can watch and take over (logins, CAPTCHAs) through VNC. |
| 🖼️ **image_generator** | A headless sub-agent on Codex making raster images with its built-in image generation; results arrive as stored files. |

Three model vendors run side by side behind one session contract. The secretary runs on
the configured LLM backend — OpenAI's Responses API, any OpenAI-compatible server, or
Anthropic's Messages API; the other agents run on Claude (Claude Agent SDK, the host's
Claude login) or on OpenAI Codex (Codex SDK, the host's ChatGPT login). An agent picks its
backend with a one-line declaration.

**Remote agents.** A catalog agent may also be a session in an external system, mirrored as
a thread: its replies, tool calls and questions appear in the thread, what is sent into the
thread reaches the session as the user's word, questions (an approval, a sign-in) wait for
the user. A system arrives as an installation driver, not as repository code.

## Capabilities

**Integrations out of the box**
- **Gmail** — search, read, threads, attachments, drafts, send; per-user Google OAuth.
- **Google Drive** — search across My Drive and shared drives, folder listing, Docs/Sheets/
  Slides as text, download into and upload from file storage, replace a file's content;
  the same Google OAuth client as Gmail.
- **Notion** — the official hosted MCP server; each user connects their own workspace.
- **Perplexity** — search, ask, reason, deep research on the installation's key.
- **Qase** — test management through the official MCP server on the operator's token.
- **Claude Code Artifacts** — the harness's Artifact tools, on for the designer agent: design
  canvases, design systems and decks published to claude.ai under the host's Claude login.
- **Web** — fetch pages and download files into storage, with SSRF protection (DNS/IP
  blocklists, redirect and size caps).
- **Browser** — a persistent per-user Chromium profile for anything without an API.
- **Any MCP server** (stdio or HTTP) added with a JSON file — the platform runs OAuth
  (discovery, dynamic client registration, PKCE), per-user connections with several
  accounts of one service, and `${secret:NAME}` installation credentials. In-process tool
  servers are TypeScript modules; an installation adds its own next to the repository's
  (Yandex Direct and Metrika run this way on the original installation).

**A data workbench per workspace** — a private SQLite database, a scoped file area and a
script runner (Python/Node), so bulk data moves disk-to-disk instead of through model
context. Data goes to tables and files; the model sees short summaries. A background indexer
annotates every file with a title and a description.

**Projects** — named long-lived work contexts: a folder in the file area with `AGENTS.md`
as the entry point, an inbox for new facts, a journal kept by the gardener. Any thread may
work on a project; the project is not tied to a thread.

**Scheduling** — a durable registry of named tasks: recurring (cron with alarm-clock
semantics), one-shot ("not before T", consumed by firing) or trigger-less. A task is a
**note** fired into the main thread for the secretary to interpret, a **command** — a script
in the workspace run as a job with its runs journaled, or **code** — a TypeScript body in the
workspace, live without a build. Every agent can operate the registry.

**Mini-apps** — a workspace folder with a manifest and `.tsx` sources, run in the browser at
its own URL without a build step and bridged to the workspace SQLite through SQL endpoints
the manifest declares. Owner pages live behind the console session; a published app is
public at its slug.

**Files** — one file storage behind two drivers (an S3-compatible object store or the local
disk with signed links); files cross every boundary as ids, with descriptive names.

**Self-extension** — Balabash's repository is one more codebase the engineer agent works
in. A restart is an event: requested into the log, waited for until a structurally safe
window (no active task threads, no turn in flight, a quiet log), then performed by the
supervisor, which boots the fresh bundle, applies pending schema migrations and rolls back to
the last good bundle if the new one crash-loops — the fresh process reports the rollback
into the log.

## Security posture

- **Credentials never touch the chat, the model or the log.** API keys, OAuth client
  secrets and installation credentials are entered through one-time web forms that submit
  straight to the database; the log records only sanitized facts. OAuth tokens live in one
  table and nowhere else.
- **Re-authorization is automatic.** An expired token opens an auth thread and notifies the
  user — one active auth thread per workspace.
- **Every grant is explicit.** Each agent declares the exact list of tool servers it gets;
  sensitive servers (auth, restart) reach only the agents that list them. A spawner may
  narrow a child's tool bundle, and narrowing only shrinks. Spawning is a declared right:
  an agent starts only the sub-agents named in its declaration.
- **Workspace isolation at every model-facing edge.** A file or thread id of another
  workspace yields the same "not found" as a missing one. Caller identity comes from the
  platform, never from model-visible arguments.
- **Everything is auditable.** Every tool call of every model loop is journaled into the
  event log — started, completed with the verbatim result, or failed.

## Architecture

The thesis: **the system is a set of parallel agent runs over one append-only event log;
each run owns a thread — its context and its visibility boundary.**

- **The log is the only source of truth.** Events are immutable rows in PostgreSQL with a
  global sequence. The threads table is a memoization rebuilt from the log by a plain fold;
  cascade cancellations write one explicit event per descendant, so replay is deterministic.
- **One append point owns all invariants**, transactionally with row locks: one main thread
  per workspace, exactly one terminal event per thread, workspace isolation, one-hop
  addressing.
- **Threads form a tree with hard visibility boundaries.** A thread's transcript is the
  events it authored plus the events addressed to it; an event may address only its author's
  parent or a direct child. A parent never sees a grandchild's inner work — only lifecycle
  and summaries. Context management is a data invariant, not a prompt convention.
- **Runs are ephemeral; the log is durable.** In-memory runs are never persisted; on boot,
  orphaned threads are tombstoned and events addressed to dead threads are redirected to the
  main thread. A remote agent's thread holds no run at all: its row is its whole state.
- **Agents are declarations.** An agent module declares its SDK, prompt, tools and spawn
  rights; the platform supplies the session lifecycle, event-to-message rendering, live
  tool-catalog sync and the standard verbs (`end_thread`, `send_file`, spawning). Prompts
  are assembled from a world library — one file per fact, every prompt imports instead of
  retelling.
- **The console is one more projection.** The browser hydrates from a snapshot of the
  server's projections and lives on the event tail over SSE; every event is a Redux action.
- **Degrade loudly.** A failed migration boots the old schema with a loud journal entry; a
  bad tool schema is skipped; a failing consumer is journaled and skipped; a broken agent
  declaration fails the boot atomically — where the supervisor's rollback can act on it.

## Stack

TypeScript on Node.js ≥ 24, one process, esbuild-bundled (the console SPA included).
PostgreSQL through Prisma for the event log; S3-compatible object storage or the local disk
for files; grammY for Telegram; Koa for the web surface; React/Redux for the console; MCP
as the tool protocol; the Claude Agent SDK, the Codex SDK and the OpenAI/Anthropic APIs as
model backends; Playwright for the browser.

## Status

A personal system, built for its own operator and developed live — by its own agents, among
others. Expect sharp edges; read the log.
