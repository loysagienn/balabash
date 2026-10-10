// Codex SDK implementation of the provider-neutral AgentSdkSession contract.
// Inputs are accepted synchronously into a FIFO at any time. Codex turns run
// sequentially over one SDK thread: a push never interrupts the active turn,
// and the next queued input is delivered after that turn finishes.
//
// A codex session is always 'full': the native tool set (shell, file edits,
// web search) is Codex's by construction, and the Balabash bridge joins it as
// the session's one MCP server. What the session must NOT see is the host
// user's personal Codex layer — that is cut off by running in the app's own
// CODEX_HOME (codex-home.ts) and by explicit feature overrides below.

import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Codex } from '@openai/codex-sdk';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AgentSdkSession, SdkSessionOptions, SdkTurn, ToolsApi } from '../../core/contract.ts';
import { createBridgeServer } from '../claude-sdk/bridge.ts';
import { mergeEnv } from '../env.ts';
import { ensureCodexHome } from './codex-home.ts';
import { codexSessionConfig } from './session-config.ts';
import { emitCodexEvent, emitCodexSessionEnd } from './stream-tap.ts';
import { DEFAULT_EFFORT } from '../default-effort.ts';

export type CodexSessionDeps = {
  tools: ToolsApi;
  // Fallback working directory — the run's stateDir; options.cwd wins.
  cwd: string;
  // When set, every ThreadEvent of the inner stream is published on the
  // Codex stream tap under this thread (the session journal's feed), and
  // the session's end on close().
  threadId?: string;
};

type InputWaiter = {
  resolve: (result: IteratorResult<string>) => void;
};

function createInputQueue(initialInput: string) {
  const inputs = [initialInput];
  const waiters: InputWaiter[] = [];
  let ended = false;

  const push = (input: string) => {
    if (ended) {
      throw new Error('Codex session input is already closed');
    }

    const waiter = waiters.shift();

    if (waiter) {
      waiter.resolve({ value: input, done: false });
    } else {
      inputs.push(input);
    }
  };

  const end = () => {
    if (ended) {
      return;
    }

    ended = true;

    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  };

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<string>> => {
          const input = inputs.shift();

          if (input !== undefined) {
            return { value: input, done: false };
          }

          if (ended) {
            return { value: undefined, done: true };
          }

          return new Promise(resolve => {
            waiters.push({ resolve });
          });
        },
      };
    },
  };

  return { iterable, push, end };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  return raw ? JSON.parse(raw) : undefined;
}

async function startBridgeHttpServer(deps: CodexSessionDeps, extraTools: SdkSessionOptions['extraTools']) {
  const httpServer = http.createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }),
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let bridge: Awaited<ReturnType<typeof createBridgeServer>> | null = null;

    try {
      bridge = await createBridgeServer({
        tools: deps.tools,
        extraTools: extraTools ?? [],
      });
      const body = await readJsonBody(request);

      await bridge.server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            id: null,
          }),
        );
      }
    } finally {
      await transport.close().catch(() => {});
      await bridge?.server.close().catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    throw new Error('Codex MCP bridge did not receive a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

export function createCodexSession(options: SdkSessionOptions, deps: CodexSessionDeps): AgentSdkSession {
  const queue = createInputQueue(options.initialMessage);
  let closed = false;
  let activeTurn: AbortController | null = null;

  async function* turns(): AsyncGenerator<SdkTurn> {
    const bridge = await startBridgeHttpServer(deps, options.extraTools);

    try {
      const codexHome = ensureCodexHome();
      const codex = new Codex({
        // SDK `env` replaces the subprocess environment entirely, so merge the
        // extra variables over the inherited app environment. CODEX_HOME is
        // the app's isolated home, never the host user's ~/.codex.
        env: mergeEnv({ ...options.env, CODEX_HOME: codexHome }),
        // Every override rides each `codex exec` invocation (a turn is one
        // invocation, resumed by thread id), so the whole session sees them
        // (session-config.ts: the brief, the bridge, reasoning summaries on,
        // the host layer off).
        config: codexSessionConfig(options.instructions, bridge.url),
      });
      const thread = codex.startThread({
        ...(options.model ? { model: options.model } : {}),
        // Reasoning effort: the platform scale is a subset of Codex's, so the
        // value passes through; the platform default is explicit
        // (default-effort.ts).
        modelReasoningEffort: options.effort ?? DEFAULT_EFFORT,
        workingDirectory: options.cwd ?? deps.cwd,
        skipGitRepoCheck: true,
        // Parity with the Claude sessions (bypassPermissions): the host is
        // fully accessible and the network is open; the workbench boundary is
        // held by the brief, not by a sandbox.
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        webSearchMode: 'live',
      });

      for await (const input of queue.iterable) {
        if (closed) {
          return;
        }

        const turnController = new AbortController();
        activeTurn = turnController;

        try {
          const streamed = await thread.runStreamed(input, { signal: turnController.signal });

          for await (const event of streamed.events) {
            if (deps.threadId) {
              emitCodexEvent(deps.threadId, event);
            }

            if (event.type === 'item.completed' && event.item.type === 'agent_message') {
              yield { text: event.item.text.trim() };
            } else if (event.type === 'turn.failed') {
              throw new Error(`Codex SDK session turn failed: ${event.error.message}`);
            } else if (event.type === 'error') {
              throw new Error(`Codex SDK session failed: ${event.message}`);
            }
          }

          // A turn can end with a bridge-tool call (end_thread) and no trailing
          // agent_message; consumers detect completion on yielded turns, so
          // every turn closes with an empty boundary turn.
          yield { text: '' };
        } finally {
          if (activeTurn === turnController) {
            activeTurn = null;
          }
        }
      }
    } finally {
      activeTurn?.abort();
      await bridge.close();
    }
  }

  return {
    push: text => queue.push(text),
    turns: turns(),
    // The HTTP bridge builds its MCP server from the current ToolsApi for
    // every request, so the next list/call observes the latest catalog.
    syncTools: async () => {},
    close: () => {
      if (closed) {
        return;
      }

      closed = true;
      queue.end();
      activeTurn?.abort();

      if (deps.threadId) {
        emitCodexSessionEnd(deps.threadId);
      }
    },
  };
}
