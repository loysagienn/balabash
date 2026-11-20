// The secretary's in-process catalog port. One grant supplies the prompt,
// definitions and dispatch of this turn.
import { coordinator } from '../../agents/access.ts';
import { agentGrantPolicy, isRemoteAgent, startable } from '../capabilities/agent-catalog.ts';
import {
  CapabilityError,
  FileRef,
  computeGrant,
  describe,
  grantedChildren,
  grantedGuide,
  grantedVertex,
  invokeCapability,
  runProgram,
  toCapabilityError,
  type Catalog,
  type DescribeValue,
  type FileRefValue,
  type Grant,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from '../catalog/index.ts';
import { typeRefName } from '../catalog/schema.ts';
import { catalog } from '../tree/index.ts';
import { connectionsPort } from '../tree/services.ts';
import { journalCall, journalProgramCall, runDetails } from '../tree/call-journal.ts';
import type { DispatchResult, FunctionCall, FunctionDefinition } from '../harness/turn-contract.ts';
import { COORDINATOR_INSTRUCTIONS, END_TURN_FUNCTION } from './instructions.ts';
import { getFileDownloadUrl, openFileContent } from '../files/index.ts';
import { viewKind, VIEW_TEXT_MAX_CHARS } from '../tree/files.ts';

const actions = ['describe', 'run_program'] as const;
// A preview is a view of an event. Its seq can be used from a program
// to extract a small part of even a very large result without another preview.
const PREVIEW_CHARS = 16_000;

function preview(value: JsonValue, seq: bigint, field: 'value' | 'error'): string {
  const json = JSON.stringify(value);
  if (json.length <= PREVIEW_CHARS) return json;
  const path = `(await call("get_event", {seq: ${seq}})).payload.${field}`;
  return `${json.slice(0, PREVIEW_CHARS)}\n[Preview. Use run_program to select the part you need from ${path}.]`;
}

// Make the input schema self-contained, including the platform's account field.
function definition(tree: Catalog, name: string, description: string, input: JsonSchema): FunctionDefinition {
  function expand(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== 'object') return value;
    const schema = value as JsonSchema;
    const ref = typeRefName(schema);
    if (ref) {
      const { $ref, ...fields } = schema;
      return { ...(expand(tree.types.get(ref)!.schema) as JsonSchema), ...fields };
    }
    return Object.fromEntries(Object.entries(schema).map(([key, field]) => [key, expand(field)]));
  }
  return { type: 'function', name, description, parameters: expand(input) as JsonSchema, strict: false };
}

function coreText(grant: Grant): string {
  const root = grant.catalog.root;
  const agents = startable(coordinator.name).map(agent =>
    JSON.stringify({
      name: agent.name,
      description: agent.description,
      modes: agent.modes,
      defaultMode: agent.defaultMode,
      ...(isRemoteAgent(agent) ? { remote: true, options: agent.options ?? {} } : {}),
    }),
  );
  return [
    COORDINATOR_INSTRUCTIONS,
    ...grantedGuide(grant, root),
    ...grantedChildren(grant, root).map(child => child.fullName + ' — ' + child.summary),
    'Use describe to add a capability to the available functions. If its name appears only in the transcript, describe it again. Call the function by its catalog name.',
    'Agents you can start:',
    ...agents,
  ].join('\n');
}

export async function createCatalogPort(workspaceId: string, threadId: string) {
  const tree = catalog();
  const connections = connectionsPort();
  const caller = { workspaceId, threadId, agentName: coordinator.name };
  const grant = await computeGrant(tree, agentGrantPolicy(coordinator, actions), { caller, connections });
  const tools = actions.map(name => {
    const action = tree.actions.get(name)!;
    return definition(tree, name, action.description, action.input);
  });
  const seenNodes = new Set(['']);
  async function dispatch(call: FunctionCall): Promise<DispatchResult> {
    if (call.name === END_TURN_FUNCTION.name) return { kind: 'end' };
    let input: JsonValue;
    let malformed = false;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      input = call.arguments;
      malformed = true;
    }

    let run: JsonObject = {};
    let opened: DescribeValue | undefined;
    try {
      const result = await journalCall(
        { caller, callId: call.callId, name: call.name, input },
        async () => {
          if (malformed) throw new CapabilityError('invalid_input', 'Pass the arguments as a JSON object.');
          if (call.name === 'describe') {
            opened = await describe(grant, input, { connections });
            return opened;
          }
          if (call.name === 'run_program') {
            return runProgram(grant, input, {
              connections,
              // The outer call and its inner calls can be correlated from launch.
              start: { id: call.callId, startedAt: new Date() },
              traceCall: journalProgramCall,
              record: result => {
                run = runDetails(result);
              },
            });
          }
          return invokeCapability(grant, call.name, input, { connections });
        },
        () => run,
      );

      if ('error' in result) return { kind: 'catalog', text: preview(result.error, result.seq, 'error') };
      const { value, seq } = result;
      if (opened?.kind === 'node') seenNodes.add(opened.name);
      if (opened?.kind === 'capability') {
        const vertex = grantedVertex(grant, opened.name);
        if (vertex?.kind !== 'capability') throw new Error('Missing described capability');
        const guide = seenNodes.has(vertex.parent.fullName) ? [] : grantedGuide(grant, vertex.parent);
        seenNodes.add(vertex.parent.fullName);
        const text = [
          ...guide,
          opened.description,
          opened.signature,
          ...opened.types,
          ...(opened.accounts.length ? ['Accounts: ' + JSON.stringify(opened.accounts)] : []),
        ].join('\n');
        return {
          kind: 'catalog',
          text,
          definition: definition(tree, vertex.fullName, vertex.description, vertex.input),
        };
      }
      const text = preview(value, seq, 'value');
      return call.name === 'view_file' ? showFile(text, FileRef.parse(value)) : { kind: 'catalog', text };
    } catch (error) {
      return { kind: 'catalog', text: JSON.stringify(toCapabilityError(error).toValue()) };
    }
  }

  return {
    instructions: coreText(grant),
    tools: [...tools, END_TURN_FUNCTION],
    dispatch,
    grantKey: JSON.stringify([...grant.vertices]),
  };
}

async function showFile(text: string, file: FileRefValue): Promise<DispatchResult> {
  try {
    const kind = viewKind({ contentType: file.contentType, originalFilename: file.name });
    if (kind === 'text') {
      const reader = (await openFileContent(file.id)).getReader();
      const decoder = new TextDecoder();
      let content = '';
      try {
        while (content.length < VIEW_TEXT_MAX_CHARS) {
          const chunk = await reader.read();
          content += decoder.decode(chunk.value, { stream: !chunk.done });
          if (chunk.done) break;
        }
      } finally {
        await reader.cancel();
      }
      return { kind: 'catalog', text: text + '\n' + content.slice(0, VIEW_TEXT_MAX_CHARS) };
    }

    const { url } = await getFileDownloadUrl(file.id);
    return { kind: 'catalog', text, attachment: { kind: kind === 'image' ? 'image' : 'pdf', url } };
  } catch (error) {
    return { kind: 'catalog', text: text + '\nFile content unavailable: ' + toCapabilityError(error).message };
  }
}
