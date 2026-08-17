// Codex SDK implementation of the provider-neutral AgentSdkSession contract.
// Inputs are accepted synchronously into a FIFO at any time. Codex turns run
// sequentially over one SDK thread: a push never interrupts the active turn,
// and the next queued input is delivered after that turn finishes.

import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Codex } from '@openai/codex-sdk';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AgentSdkSession, SdkSessionOptions, SdkTurn, ToolsApi } from '../../core/contract.ts';
import { createBridgeServer } from '../claude-sdk/bridge.ts';

export type CodexSessionDeps = {
  tools: ToolsApi;
  cwd: string;
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

function initialInput(options: SdkSessionOptions): string {
  return `${options.instructions}\n\n---\n\n${options.initialMessage}`;
}

// process.env values can be undefined; the SDK wants Record<string, string>.
function mergeEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }

  return { ...env, ...extra };
}

export function createCodexSession(options: SdkSessionOptions, deps: CodexSessionDeps): AgentSdkSession {
  const queue = createInputQueue(initialInput(options));
  let closed = false;
  let activeTurn: AbortController | null = null;

  async function* turns(): AsyncGenerator<SdkTurn> {
    const bridge = await startBridgeHttpServer(deps, options.extraTools);

    try {
      const codex = new Codex({
        // SDK `env` replaces the subprocess environment entirely, so merge the
        // extra variables over the inherited app environment.
        ...(options.env ? { env: mergeEnv(options.env) } : {}),
        config: {
          mcp_servers: {
            balabash: {
              url: bridge.url,
              required: true,
              default_tools_approval_mode: 'approve',
            },
          },
        },
      });
      const thread = codex.startThread({
        ...(options.model ? { model: options.model } : {}),
        workingDirectory: deps.cwd,
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
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
            if (event.type === 'item.completed' && event.item.type === 'agent_message') {
              yield { text: event.item.text.trim() };
            } else if (event.type === 'turn.failed') {
              throw new Error(`Codex SDK session turn failed: ${event.error.message}`);
            } else if (event.type === 'error') {
              throw new Error(`Codex SDK session failed: ${event.message}`);
            }
          }

          // A turn can end with a bridge-tool call (end_codex) and no trailing
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
    },
  };
}
