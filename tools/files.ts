import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

type FileDescriptor = {
  id: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  uploadedAt: Date | null;
};

type FilesApi = {
  get: (fileId: string) => Promise<FileDescriptor>;
  getDownloadUrl: (
    fileId: string,
    options?: { expiresInSeconds?: number },
  ) => Promise<{ url: string; expiresAt: Date }>;
};

function createMcpServer(filesApi: FilesApi) {
  const server = new McpServer({ name: 'files', version: '1.0.0' });

  // Named get_file_link (not v1's get_file): loading file contents into model
  // context is the builtin get_file's job in v2 — this tool's role is a
  // shareable presigned download URL.
  server.registerTool(
    'get_file_link',
    {
      description:
        'Get a presigned, time-limited download URL for a stored Balabash file. Use it when a link to the file is needed; to read the file contents into context use get_file instead.',
      inputSchema: {
        fileId: z.string().min(1).describe('The Balabash file ID from an event or tool result.'),
      },
    },
    async ({ fileId }) => {
      try {
        const file = await filesApi.get(fileId);
        const { url } = await filesApi.getDownloadUrl(fileId);
        const name = file.originalFilename || file.id;
        const mimeType = file.contentType || 'application/octet-stream';

        // Metadata goes into structuredContent (it reaches the log and the
        // model as structure, not a JSON string), the file itself — as a
        // resource_link block.
        return {
          content: [
            {
              type: 'resource_link' as const,
              uri: url,
              name,
              mimeType,
              ...(file.sizeBytes === null ? {} : { size: file.sizeBytes }),
            },
          ],
          structuredContent: {
            fileId: file.id,
            filename: file.originalFilename,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            width: file.width,
            height: file.height,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: error instanceof Error ? error.message : String(error),
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

export async function start(ctx: { filesApi: FilesApi }) {
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

    const server = createMcpServer(ctx.filesApi);
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
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
