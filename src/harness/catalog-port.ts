// The catalog view for a port that assembles the model's context.
import { catalogContext, catalogInstructions, grantKey, grantedCapabilities, guideForLeaf, portActions, vertexLine } from './catalog-context.ts';
import {
  ACTION_NAMES, FileRef, expandSchema, grantedVertex, ruleText, toCapabilityError, typeText,
  type Catalog, type CatalogCapability, type FileRefValue, type Grant, type JsonSchema, type JsonValue,
} from '../catalog/index.ts';
import type { AgentPassport } from '../core/contract.ts';
import { getFileDownloadUrl, openFileContent } from '../files/index.ts';
import { dispatchCatalogCall } from '../tree/call-journal.ts';
import { viewKind, VIEW_TEXT_MAX_CHARS } from '../tree/files.ts';
import type { CatalogOpeningContext, CatalogResult, FunctionCall, FunctionDefinition } from './turn-contract.ts';

const PREVIEW_CHARS = 16_000;

function preview(grant: Grant, value: JsonValue, seq: bigint, field: 'value' | 'error'): string {
  const json = JSON.stringify(value);
  if (json.length <= PREVIEW_CHARS) return json;
  const path = `(await call("get_event", {seq: ${seq}})).payload.${field}`;
  const hint = grant.vertices.has('get_event') ? ` Use run_program to select the part you need from ${path}.` : '';
  return `${json.slice(0, PREVIEW_CHARS)}\n[Preview of event ${seq}.${hint}]`;
}

function definition(tree: Catalog, name: string, description: string, input: JsonSchema): FunctionDefinition {
  return { type: 'function', name, description, parameters: expandSchema(tree, input), strict: false };
}

function capabilityDefinition(tree: Catalog, vertex: CatalogCapability): FunctionDefinition {
  return definition(tree, vertex.fullName, vertex.description, vertex.input);
}

export async function createCatalogPort(agent: AgentPassport, workspaceId: string, threadId: string, opening: 'function' | 'signature') {
  const actions = opening === 'signature' ? ACTION_NAMES : portActions;
  const { grant, connections } = await catalogContext(agent, workspaceId, threadId, actions);
  const tree = grant.catalog;
  const tools = actions.map(name => {
    const action = tree.actions.get(name)!;
    return definition(tree, name, action.description, action.input);
  });

  async function dispatch(call: FunctionCall, openings: CatalogOpeningContext): Promise<CatalogResult> {
    let input: JsonValue;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      input = call.arguments;
    }

    try {
      const result = await dispatchCatalogCall(grant, connections, { callId: call.callId, name: call.name, input });
      if ('error' in result) return { kind: 'catalog', isError: true, text: preview(grant, result.error, result.seq, 'error') };
      const { value, seq, opened } = result;
      const accounts = opened?.accounts.length ? ['Accounts: ' + JSON.stringify(opened.accounts)] : [];
      if (opened?.kind === 'node') {
        openings.seenNodes.add(opened.name);
        const children = opened.children.map(child => vertexLine(child.kind, child.name, child.summary));
        return { kind: 'catalog', text: [opened.summary, ...opened.guide, ...children, ...accounts].join('\n') };
      }
      if (opened?.kind === 'capability') {
        const vertex = grantedVertex(grant, opened.name);
        if (vertex?.kind !== 'capability') throw new Error('Missing described capability');
        const guide = guideForLeaf(grant, vertex.parent, openings.seenNodes);
        if (opening === 'signature') {
          return { kind: 'catalog', text: [...guide, opened.description, opened.signature, ...opened.types, ...accounts].join('\n') };
        }
        const text = [
          ...guide, 'Returns: ' + typeText(vertex.output, 0), ...vertex.inputRules.map(ruleText), ...opened.types, ...accounts,
        ].join('\n');
        const tool = capabilityDefinition(tree, vertex);
        return { kind: 'catalog', text, ...(openings.introduce(call.callId, tool, text) ? { definition: tool } : {}) };
      }
      const text = preview(grant, value, seq, 'value');
      return result.name === 'view_file' ? showFile(text, FileRef.parse(value)) : { kind: 'catalog', text };
    } catch (error) {
      return { kind: 'catalog', isError: true, text: JSON.stringify(toCapabilityError(error).toValue()) };
    }
  }
  function capabilityDefinitions(): FunctionDefinition[] {
    return Array.from(grantedCapabilities(grant), vertex => capabilityDefinition(tree, vertex));
  }

  const instructions = catalogInstructions(grant,
    opening === 'signature' ? 'If only the capability name remains in the transcript, describe it again to read its signature.' :
    'Use describe to add a capability to the available functions. If its name appears only in the transcript, describe it again. Call the function by its catalog name.');
  return { instructions, tools, capabilityDefinitions, dispatch, grantKey: grantKey(grant) };
}

async function showFile(text: string, file: FileRefValue): Promise<CatalogResult> {
  try {
    const kind = viewKind({ contentType: file.contentType, originalFilename: file.name });
    if (kind === 'text') {
      const reader = (await openFileContent(file.id)).getReader();
      const decoder = new TextDecoder();
      let content = '';
      try {
        while (content.length <= VIEW_TEXT_MAX_CHARS) {
          const chunk = await reader.read();
          content += decoder.decode(chunk.value, { stream: !chunk.done });
          if (chunk.done) break;
        }
      } finally {
        await reader.cancel();
      }
      const cutoff = content.length > VIEW_TEXT_MAX_CHARS ? `\n[First ${VIEW_TEXT_MAX_CHARS} characters shown.]` : '';
      return { kind: 'catalog', text: text + '\n' + content.slice(0, VIEW_TEXT_MAX_CHARS) + cutoff };
    }

    const { url } = await getFileDownloadUrl(file.id);
    return { kind: 'catalog', text, attachment: { kind: kind === 'image' ? 'image' : 'pdf', url } };
  } catch (error) {
    return { kind: 'catalog', text: text + '\nFile content unavailable: ' + toCapabilityError(error).message };
  }
}
