// The node `web_perplexity`: web search and web-grounded answers of
// Perplexity, on the API key of the installation. Perplexity is an external
// MCP server: the fields of the inputs are named as the server names them,
// the texts and the output types are ours. The server glues its results
// into one string, so a value is that string under the name the server
// gives it.

import { z } from 'zod';
import { CapabilityError, capability, node, secretAuthority, type CallContext, type JsonObject, type Node } from '../catalog/index.ts';
import { CredentialsRefusedError, callServerTool, type ToolAnswer } from './external-server.ts';
import { secretsAccepted, secretsRefused } from './services.ts';

export const PERPLEXITY_MCP_URL = 'https://api.perplexity.ai/mcp';
const SERVICE = 'perplexity';
const API_KEY = 'PERPLEXITY_API_KEY';

const recency = z.enum(['hour', 'day', 'week', 'month', 'year']).optional().describe('Only results from this period.');
const domains = z.array(z.string()).optional().describe('Only these domains; a "-" prefix excludes a domain.');
const messages = z
  .array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
  .describe('The conversation; the question is the last user message.');
const answerInput = z.strictObject({
  messages,
  search_recency_filter: recency,
  search_domain_filter: domains,
  search_context_size: z.enum(['low', 'medium', 'high']).optional().describe('How much web context is retrieved.'),
});
const answerOutput = z.strictObject({
  response: z.string().describe('Prose with citation marks [n], then the list of cited URLs.'),
});

// A call of the server on the key of the installation. How the server took
// the key is the state of the service (`connections_list`): a key it does
// not take is the operator's to replace, a call it answered shows the key
// is good. A refusal of another kind — a quota, a bad request — says nothing
// about the key.
async function onKey(url: string, tool: string, input: JsonObject, ctx: CallContext): Promise<ToolAnswer> {
  const server = { title: 'Perplexity', url, headers: { Authorization: `Bearer ${secretAuthority(ctx).secrets[API_KEY]}` } };

  try {
    const answer = await callServerTool(server, tool, input, { signal: ctx.signal });

    secretsAccepted(SERVICE);

    return answer;
  } catch (error) {
    if (error instanceof CredentialsRefusedError) {
      secretsRefused(SERVICE, 'Perplexity refused the API key (HTTP 401)');

      throw new CapabilityError(
        'auth_required',
        'Perplexity refused the API key of the installation (HTTP 401): the operator has to enter it again.',
      );
    }

    throw error;
  }
}

// The string a tool of the server answers with: the field of its structured
// content, or — from a server that gives none — its text. An answer with
// neither does not fit the output type.
async function ask(url: string, tool: string, field: string, input: JsonObject, ctx: CallContext): Promise<string> {
  const answer = await onKey(url, tool, input, ctx);
  const structured = answer.structured?.[field];
  const text = typeof structured === 'string' && structured ? structured : answer.text;

  if (!text) {
    throw new CapabilityError('external_error', `Perplexity answered \`${tool}\` with no text.`);
  }

  return text;
}

// The node over an endpoint: the server of Perplexity, or — in a test — a
// server of the test's own.
export function perplexityNode(url: string = PERPLEXITY_MCP_URL): Node {
  const answer = (name: string, summary: string, description: string, input: z.ZodObject = answerInput) =>
    capability({
      name,
      summary,
      description,
      input,
      output: answerOutput,
      run: async (args, ctx) => ({ response: await ask(url, `perplexity_${name}`, 'response', args as JsonObject, ctx) }),
    });

  return node({
    name: 'perplexity',
    summary:
      'Perplexity: web search and web-grounded generated answers. Search is the default way to research a topic.',
    external: true,
    connection: {
      type: 'secret',
      service: SERVICE,
      summary: 'Web search and web-grounded answers of Perplexity, on the API key of the installation.',
      secrets: [API_KEY],
    },
    guide: [
      {
        text: 'To research a topic, run several `web_perplexity_search` queries with different wording, read the excerpts, open the promising pages and do the analysis yourself.',
      },
      {
        text: 'A generated answer costs more than a search. `web_perplexity_ask` suits a narrow factual question. `web_perplexity_reason` is rarely needed: you can reason over search results yourself. `web_perplexity_research` is slow and the most expensive: only when the user explicitly asks for a Perplexity deep-research report.',
      },
    ],
    children: [
      capability({
        name: 'search',
        summary: 'Search the web and get ranked results with page excerpts',
        description:
          'Search the web and get a ranked list of results, each with its title, URL and an excerpt of the page; no answer is generated.',
        input: z.strictObject({
          query: z.string(),
          max_results: z.number().min(1).max(20).default(10),
          max_tokens_per_page: z.number().min(256).max(2048).default(1024).describe('Tokens extracted from each page.'),
          country: z.string().optional().describe('ISO 3166-1 alpha-2 code, for regional results.'),
          search_recency_filter: recency,
          search_domain_filter: domains,
          search_type: z.enum(['web', 'fast']).default('web').describe('fast has lower latency and cost.'),
        }),
        output: z.strictObject({
          results: z
            .string()
            .describe('Formatted text: the numbered results, each with its title, URL and page excerpt.'),
        }),
        run: async (input, ctx) => ({ results: await ask(url, 'perplexity_search', 'results', input, ctx) }),
      }),
      answer(
        'ask',
        'Get a quick web-grounded answer with citations',
        'Get a generated answer to a question, grounded in a web search, with numbered citations.',
      ),
      answer(
        'reason',
        'Get a step-by-step reasoned web-grounded answer with citations',
        'Get a generated answer built by step-by-step reasoning over a web search, with numbered citations.',
      ),
      answer(
        'research',
        'Get a long multi-source research report with citations',
        'Get a long generated report from deep multi-source research, with numbered citations. It can take minutes.',
        z.strictObject({ messages }),
      ),
    ],
  });
}
