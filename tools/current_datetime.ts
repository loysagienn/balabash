import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function createMcpServer() {
  const server = new McpServer({ name: 'current_datetime', version: '1.0.0' });

  server.registerTool(
    'get_current_datetime',
    {
      description:
        'Get the current date and time. Use when the user asks about the current date, time, or weekday, or when a task needs the present moment.',
      inputSchema: {
        timezone: z
          .string()
          .nullable()
          .describe('IANA timezone like "Europe/Moscow" or "UTC". Pass null to use UTC.'),
      },
    },
    async ({ timezone }) => {
      const timeZone = timezone ?? 'UTC';

      try {
        const text = new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone,
        }).format(new Date());

        return { content: [{ type: 'text' as const, text: `${text} (${timeZone})` }] };
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown timezone "${timeZone}". Use an IANA name like "Europe/Moscow".`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');

  return body ? JSON.parse(body) : undefined;
}

export async function start(_ctx: { filesApi: unknown }) {
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

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      const body = await readJsonBody(request);

      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
            id: null,
          }),
        );
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
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
    throw new Error('Local MCP server did not receive a TCP port');
  }

  return {
    config: {
      transport: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
    },
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
