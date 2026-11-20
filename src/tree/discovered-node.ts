// A server with no authored node: publish its discovered tool contracts and
// translate the MCP result into one catalog value before it reaches the journal.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { CallToolResult, ContentBlock, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { capability, CapabilityError, JsonValue, node, type CallContext, type JsonObject } from '../catalog/index.ts';
import { fileRefValue, storeArrival } from './files.ts';

type InvokeTool = (name: string, args: JsonObject, signal: AbortSignal | null) => Promise<CallToolResult>;

function validator(schema: Tool['inputSchema']) {
  // Older servers can explicitly advertise draft 7. MCP defaults to 2020-12.
  const provider = schema.$schema?.toString().includes('draft-07')
    ? new AjvJsonSchemaValidator()
    : new AjvJsonSchemaValidator(new Ajv2020({ strict: false, allErrors: true, logger: false }));
  return provider.getValidator(schema);
}

async function blockValue(block: ContentBlock, tool: string, ctx: CallContext): Promise<JsonValue> {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource_link') {
    return { uri: block.uri, name: block.name, mimeType: block.mimeType ?? null };
  }
  let bytes: Buffer;
  let mime: string;
  let name = tool;
  if (block.type === 'resource') {
    const resource = block.resource;
    bytes = 'text' in resource ? Buffer.from(resource.text) : Buffer.from(resource.blob, 'base64');
    mime = resource.mimeType ?? ('text' in resource ? 'text/plain' : 'application/octet-stream');
    name = resource.uri.split(/[?#]/)[0].split('/').pop() || tool;
  } else {
    bytes = Buffer.from(block.data, 'base64');
    mime = block.mimeType;
  }
  const file = await storeArrival(ctx.caller.workspaceId, Readable.from([bytes]),
    () => ({ name, contentType: mime, scope: 'connector' }), ctx.signal);
  return fileRefValue(file);
}

async function fallbackValue(result: CallToolResult, tool: string, ctx: CallContext): Promise<JsonValue> {
  if (result.structuredContent !== undefined) return JsonValue.parse(result.structuredContent);
  const values: JsonValue[] = [];
  for (const block of result.content) values.push(await blockValue(block, tool, ctx));
  return values.length === 1 ? values[0]! : values;
}

function sentence(text: string, budget: number): string {
  const first = text.trim().split(/\n|(?<=[.!?])\s/)[0] ?? '';
  return first.length <= budget ? first.replace(/[.!?]+$/, '') : first.slice(0, budget - 1).trimEnd() + '…';
}

export function discoveredNode(
  settings: { name: string; description?: string; guide: string; recipients: string[] },
  tools: Tool[],
  invoke: InvokeTool,
  onInvalidOutput: () => void,
) {
  const { name, description, recipients } = settings;
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const summary = sentence(description || `Use the operator's ${name} connector`, 175);
  const guide = [{ text: settings.guide }];
  if (sorted.some(tool => !tool.outputSchema)) guide.push({
    text: 'A capability returning JsonValue gives the server’s structured JSON when supplied. Otherwise it gives text, stored file references or resource links in response order: a single item directly, zero or several as an array.',
  });
  const children = sorted.map(tool => {
    const normalized = tool.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
    const leaf = normalized.startsWith(name + '_') ? normalized.slice(name.length + 1) : normalized;
    const title = tool.title || tool.annotations?.title || tool.name;
    const action = tool.description?.trim() || `Call ${title}.`;
    const inputCheck = validator(tool.inputSchema);
    const outputCheck = tool.outputSchema && validator(tool.outputSchema);
    return capability({
      name: leaf,
      summary: sentence(tool.title || tool.annotations?.title || action, 90) || title,
      description: action,
      serverSchemas: { input: tool.inputSchema, output: tool.outputSchema },
      input: z.looseObject({}).superRefine((value, ctx) => {
        const checked = inputCheck(value);
        if (!checked.valid) ctx.addIssue({ code: 'custom', message: checked.errorMessage });
      }),
      output: JsonValue,
      async run(input, ctx) {
        const result = await invoke(tool.name, input as JsonObject, ctx.signal);
        if (!outputCheck) return fallbackValue(result, tool.name, ctx);
        const value = result.structuredContent;
        const checked = outputCheck(value);
        if (!checked.valid) {
          onInvalidOutput();
          throw new CapabilityError('external_error', `${title} returned an invalid structured result: ${checked.errorMessage}`,
            await fallbackValue(result, tool.name, ctx));
        }
        return JsonValue.parse(value);
      },
    });
  });
  const contracts = children.map((leaf, index) => [sorted[index].name, leaf.name, leaf.summary, leaf.description, leaf.serverSchemas]);
  const revision = createHash('sha256').update(JSON.stringify([summary, guide, contracts])).digest('hex');
  return node({ name, external: true, summary, guide, installation: { source: 'discovered', recipients, revision }, children });
}
