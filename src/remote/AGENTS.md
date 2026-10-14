# Remote agents — an external system's session as a thread

A **remote agent** is a catalog agent whose session runs in an external
system; its thread in Balabash is the **mirror** of that session. The
agent's replies, tool calls and questions appear in the thread as the
platform's own events, everything sent into the thread reaches the session
as the owner's word, and the thread's state follows the session's phase.
The core knows "a remote dialogue" in general; a concrete system arrives
as an installation extension with a driver — the repository names no
system.

## The pieces

- **The kind** — `data/remote-agents/<name>.ts` (outside git, per
  installation) exports `start(ctx)` returning a `RemoteAgentDeclaration`
  (`src/core/contract.ts`): `kind: 'remote'`, the description, `options`
  (an object JSON Schema of the launch parameters — the one exception to
  "every agent's input is one prompt"), `secrets` (installation secrets the
  driver reads through `ctx.secrets`; a kind with secrets is listed among
  the installation services on the Connections page), `driver`. Loaded at
  boot after the repository's agents (`src/capabilities/remote-agent-source.ts`),
  never shadowing them; a module that fails is skipped with one
  `system.exception` — the boot goes on.
- **The driver** — `RemoteDriver` in `src/core/contract.ts`: `open`,
  `describe` (adoption), `read` by an opaque cursor, `say`, `answer`,
  `stop`, optional `fetchFile` and `list`. It translates one system into
  the neutral vocabulary of `RemoteItem` and back; it keeps no state beyond
  the cursor; `read` is idempotent and has no side effects; `open`, `say`
  and `answer` are idempotent by our message / ask id (the engine may
  repeat them after a crash). Every verb is bounded in time by the engine.
- **The engine** — `src/remote/engine.ts` (the design in its head
  comment), `mirror.ts` (one read → the journal events and the next watch,
  a pure function), `store.ts` (the `remote_threads` row and the one write
  that advances it), `facade.ts` (what the router registers in place of a
  run — stateless, a wake).

## The invariants

- **No run.** A remote thread holds nothing in memory: the row (the
  session's reference, the driver's cursor, the engine's watch, the inbound
  position) is the whole state. It survives a restart, is no obstacle to
  the restart window and is not tombstoned at boot (`src/core/threads.ts`).
- **Two durable positions.** The cursor over the session (the mirror) and
  `inboundSeq` over the thread's inbound events (the owner's messages and
  the commands). Each advances in one log transaction with its effect;
  nothing is trusted to memory — a wake only says "look again".
- **One live thread per session.** `(kind, ref)` is unique among the rows
  whose phase is not closed/gone (a partial unique index, by hand in the
  migration); a session whose thread ended can be adopted again.
- **The owner is whoever spawned the thread**: the secretary's remote
  thread talks to the user; another agent's is headless and talks to its
  parent. The owner's end cancels a headless child (the platform's
  cascade).
- **Three ways to close, three words.** `thread.interrupt` stops the turn
  in flight (the thread waits on); `thread.cancel` closes the thread, the
  session untouched; `thread.finish` asks the session for a closing
  summary in a turn of text alone — its text completes the thread (a
  deadline completes it with the session's last words when no summary
  comes). A terminal the process never routed (a cancel after a restart, a
  parent's cascade) is found by the thread's status before any read or
  verb.
- **A question of the agent** (`agent.ask`: an approval, a sign-in) needs
  a human: `thread.decide` carries the decision, no agent of ours decides;
  a sign-in is completed by its link.
- **The state derives from the phase**: `run` / `wait` / `act` /
  `paused` (idle for half an hour, or `thread.pause` while waiting). A
  failing watch is not a state: backoff, one word to the owner after two
  hours.
- **Bytes cross only through the driver**: an attachment of the owner's
  message is streamed into the session; a file of the session is fetched
  by path on an explicit ask (`remote_fetch_file`) and stored here.

## Working here

Tests: `engine.test.ts` (the engine over a fake driver on the stand),
`mirror.test.ts`, `src/runtime/router.test.ts` (the facade's lazy rise),
`src/core/threads.test.ts` (the restart exclusions),
`src/api/thread-commands.test.ts` (finish / pause / decide). A change to
the driver contract is a change for every installation's drivers: keep
the vocabulary neutral and the comments in `contract.ts` the truth.
