// Playwright MCP inside an agent's run: the official Playwright MCP server
// connected in-process over an in-memory transport, its tools re-exposed to
// the inner model as bridge tools. Shared by the agents that carry a browser
// (browser, designer) — one conversion of results, not a clone per agent.
//
// Bridge tools carry text, never bytes (SdkBridgeTool), so an image in a
// Playwright result (a screenshot) goes to the agent's sink, which decides
// where the pixels live and returns the line the model reads instead.
//
// browser_take_screenshot returns the image only when the call passes no
// `filename` — with one, Playwright writes the file under its own output
// directory and says nothing visual. The parameter is hidden from the model
// entirely, so every screenshot reaches the sink. The text of a screenshot
// result is dropped as well: it is a code echo naming Playwright's own copy
// of the file by a path relative to the app process — a trap for a model
// that would Read it. The sink's line is the whole result.

import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BrowserContext } from 'playwright';
import type { JsonObject, SdkBridgeTool } from '../../src/core/contract.ts';

const PLAYWRIGHT_CALL_TIMEOUT_MS = 5 * 60_000;

export type PlaywrightImage = { data: Buffer; mimeType: string };

// Takes the image, returns the text line that stands for it in the result.
export type PlaywrightImageSink = (image: PlaywrightImage) => Promise<string>;

export type PlaywrightMcp = {
  client: Client;
  close(): Promise<void>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function imageExtension(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
    return 'jpg';
  }

  return 'png';
}

// The server's own output directory is for its artifacts (snapshots, console
// logs, the files behind the results) — the caller treats it as disposable.
export async function connectPlaywrightMcp(options: {
  outputDir: string;
  clientName: string;
  context(): Promise<BrowserContext>;
}): Promise<PlaywrightMcp> {
  const connection = await createConnection({ outputDir: options.outputDir, imageResponses: 'allow' }, options.context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: options.clientName, version: '2.0.0' });

  await connection.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, close: () => connection.close() };
}

// Birth contract: data or throw. Text blocks join into one string (unless
// dropped — see the header); images go through the sink.
async function convertResult(
  raw: Record<string, unknown>,
  sink: PlaywrightImageSink,
  options: { dropText: boolean },
): Promise<string> {
  const content = Array.isArray(raw.content) ? raw.content : [];
  const lines: string[] = [];

  for (const item of content) {
    if (!isObject(item)) {
      continue;
    }

    if (item.type === 'text' && typeof item.text === 'string') {
      if (!options.dropText || raw.isError) {
        lines.push(item.text);
      }

      continue;
    }

    if (item.type === 'image' && typeof item.data === 'string') {
      const mimeType = typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'image/png';

      lines.push(await sink({ data: Buffer.from(item.data, 'base64'), mimeType }));
    }
  }

  const text = lines.join('\n');

  if (raw.isError) {
    throw new Error(text || 'Browser tool call failed');
  }

  return text;
}

function sanitizeToolSchema(toolName: string, schema: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== 'browser_take_screenshot' || !isObject(schema.properties)) {
    return schema;
  }

  const { filename: _dropped, ...properties } = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required.filter(name => name !== 'filename') : undefined;

  return { ...schema, properties, ...(required ? { required } : {}) };
}

export async function createPlaywrightBridgeTools(client: Client, sink: PlaywrightImageSink): Promise<SdkBridgeTool[]> {
  const { tools } = await client.listTools();

  return tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: sanitizeToolSchema(
      tool.name,
      (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    ),
    handler: async (args: JsonObject) => {
      if (tool.name === 'browser_take_screenshot') {
        delete args.filename;
      }

      const raw = (await client.callTool({ name: tool.name, arguments: args }, undefined, {
        timeout: PLAYWRIGHT_CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      })) as Record<string, unknown>;

      return convertResult(raw, sink, { dropText: tool.name === 'browser_take_screenshot' });
    },
  }));
}
