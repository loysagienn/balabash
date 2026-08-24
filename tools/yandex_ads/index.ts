// Yandex advertising capability (Direct + Metrika) with per-user Yandex OAuth.
// This local MCP server is an OAuth protected resource, following the gmail
// module's shape: a loopback HTTP server, a fresh McpServer per request bound
// to that request's access token, RFC 9728 protected-resource metadata, 401 +
// WWW-Authenticate on a dead token so the Balabash MCP client refreshes and
// retries transparently.
//
// One Yandex peculiarity forces one extra piece: oauth.yandex.ru answers
// 200 + an HTML stub on /.well-known/oauth-authorization-server, which the
// MCP SDK would try to parse as JSON and die. So this loopback server itself
// publishes an RFC 8414 authorization-server metadata FACADE pointing at the
// real Yandex endpoints: the protected-resource metadata names the loopback
// origin as the authorization server, and GET /.well-known/oauth-authorization-server
// here returns proper JSON with oauth.yandex.ru/authorize|token inside. The
// SDK then runs the ordinary code+PKCE flow against real Yandex.

import crypto from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { toErrorResult, toStructuredResult } from '../../src/capabilities/tool-result.ts';
import type { FileRef } from '../../src/core/contract.ts';
import {
  describeCatalog,
  directEntityKeys,
  directWriteMethodNames,
  resolveReadCall,
  resolveWriteCall,
  METRIKA_GET_RESOURCES,
  REPORT_DATE_RANGES,
  REPORT_TYPES,
} from './catalog.ts';
import { directCall } from './direct.ts';
import { fetchReport } from './reports.ts';
import { metrikaGet } from './metrika.ts';

type ToolFilesApi = {
  ingest: (input: {
    body: NodeJS.ReadableStream | Buffer | Uint8Array | string;
    userId?: string | null;
    originalFilename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
  }) => Promise<FileRef>;
};

const YANDEX_AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const YANDEX_TOKEN_URL = 'https://oauth.yandex.ru/token';
const YANDEX_LOGIN_INFO_URL = 'https://login.yandex.ru/info';

// direct:api is indivisible (read and write alike — a Yandex constraint, not
// a choice); metrika:read keeps Metrika eyes-only by construction.
const SCOPES = ['direct:api', 'metrika:read'];

// ---------------------------------------------------------------------------
// Yandex passport (login.yandex.ru/info): token validation and whoami
// ---------------------------------------------------------------------------

type YandexLoginInfo = {
  id?: string;
  login?: string;
  display_name?: string;
  default_email?: string;
};

async function fetchLoginInfo(accessToken: string): Promise<YandexLoginInfo> {
  const response = await fetch(YANDEX_LOGIN_INFO_URL, {
    headers: { authorization: `OAuth ${accessToken}`, accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');

    throw new Error(`login.yandex.ru/info answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }

  return (await response.json()) as YandexLoginInfo;
}

// Cache keyed by token hash so no token value sits in module state. Yandex
// does not report expiry here, so entries live a short fixed TTL.
const tokenValidityCache = new Map<string, number>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_CACHE_MAX_ENTRIES = 500;

function pruneTokenCache(): void {
  const now = Date.now();

  for (const [key, validUntil] of tokenValidityCache) {
    if (validUntil <= now) {
      tokenValidityCache.delete(key);
    }
  }

  while (tokenValidityCache.size > TOKEN_CACHE_MAX_ENTRIES) {
    const oldest = tokenValidityCache.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    tokenValidityCache.delete(oldest);
  }
}

async function isAccessTokenValid(accessToken: string): Promise<boolean> {
  const key = crypto.createHash('sha256').update(accessToken).digest('base64');
  const cached = tokenValidityCache.get(key);

  if (cached !== undefined && cached > Date.now()) {
    return true;
  }

  let response: Response;

  try {
    response = await fetch(YANDEX_LOGIN_INFO_URL, {
      headers: { authorization: `OAuth ${accessToken}`, accept: 'application/json' },
    });
  } catch {
    // Passport unreachable: fail open — a genuinely bad token will be
    // reported clearly by the Direct/Metrika API call itself.
    return true;
  }

  await response.body?.cancel().catch(() => {});

  if (response.status === 401 || response.status === 403) {
    return false;
  }

  pruneTokenCache();
  tokenValidityCache.set(key, Date.now() + TOKEN_CACHE_TTL_MS);

  return true;
}

// ---------------------------------------------------------------------------
// MCP server per request, bound to the request's access token
// ---------------------------------------------------------------------------

// The calling run's identity rides in the MCP request _meta (set by the tool
// manager for local servers): an ingested report file must belong to that
// workspace.
function callerUserId(extra: { _meta?: Record<string, unknown> }): string | null {
  const balabash = extra._meta?.balabash;
  const userId =
    balabash && typeof balabash === 'object' && !Array.isArray(balabash)
      ? (balabash as Record<string, unknown>).userId
      : undefined;

  return typeof userId === 'string' && userId ? userId : null;
}

// Reports up to this size return inline; larger ones land in file storage.
const REPORT_INLINE_LIMIT = 16_000;

function createMcpServer(accessToken: string, filesApi: ToolFilesApi): McpServer {
  const server = new McpServer({ name: 'yandex_ads', version: '1.0.0' });

  server.registerTool(
    'yandex_ads_describe',
    {
      description:
        'The Yandex Ads reference (progressive disclosure). No arguments: the map of every entity with its read/write operations. With entity: its operations, field names and notes. With entity + operation: the payload form and a working example. Entity "reports" describes yandex_direct_report (types, fields, date ranges). Consult it before building an unfamiliar call.',
      inputSchema: {
        entity: z
          .string()
          .nullable()
          .optional()
          .describe('Entity key from the overview (e.g. "campaigns"), or "reports". Omit for the overview.'),
        operation: z
          .string()
          .nullable()
          .optional()
          .describe('Operation name of the entity (e.g. "get") for its payload form and example.'),
      },
    },
    async ({ entity, operation }) => {
      try {
        return { content: [{ type: 'text' as const, text: describeCatalog(entity, operation) }] };
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'yandex_direct_get',
    {
      description:
        'Read Yandex Direct objects: campaigns, ad groups, ads, keywords, bids and every other v5 entity. Most entities use method "get" with params { SelectionCriteria?, FieldNames, Page? }; some have other read methods (changes.check*, keywordsresearch.hasSearchVolume). Strictly read-only — write operations live in a separate tool. Unsure about the payload? Ask yandex_ads_describe first.',
      inputSchema: {
        entity: z.enum(directEntityKeys() as [string, ...string[]]).describe('The Direct entity to read.'),
        method: z
          .string()
          .nullable()
          .optional()
          .describe('Read method of the entity. Default "get" (or the entity\'s only read method).'),
        params: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional()
          .describe('The v5 "params" object verbatim, e.g. { "SelectionCriteria": {...}, "FieldNames": [...] }.'),
      },
    },
    async ({ entity, method, params }) => {
      try {
        const resolved = resolveReadCall(entity, method);
        const callParams = params ?? {};

        if (resolved.method === 'get' && entity !== 'dictionaries' && !Array.isArray((callParams as Record<string, unknown>).FieldNames)) {
          throw new Error(
            `"${entity}.get" requires params.FieldNames (an array of field names). See yandex_ads_describe("${entity}").`,
          );
        }

        const { result, units } = await directCall(accessToken, resolved.entity.service, resolved.method, callParams);

        return toStructuredResult({ entity, method: resolved.method, result, units });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'yandex_direct_report',
    {
      description:
        'Yandex Direct statistics (Reports service): impressions, clicks, cost, conversions and more, sliced by campaign/ad/keyword/query/device/date. Returns TSV — inline when small, as a stored file otherwise. Field names and report types: yandex_ads_describe("reports").',
      inputSchema: {
        report_type: z.enum(REPORT_TYPES).describe('Report type; CUSTOM_REPORT allows free slice/metric combinations.'),
        date_range_type: z.enum(REPORT_DATE_RANGES).describe('Reporting period; CUSTOM_DATE needs date_from/date_to.'),
        date_from: z.string().nullable().optional().describe('YYYY-MM-DD, with date_range_type CUSTOM_DATE.'),
        date_to: z.string().nullable().optional().describe('YYYY-MM-DD, with date_range_type CUSTOM_DATE.'),
        field_names: z
          .array(z.string())
          .min(1)
          .describe('Report columns: slices and metrics, e.g. ["Date","CampaignName","Impressions","Clicks","Cost"].'),
        filter: z
          .array(z.record(z.string(), z.unknown()))
          .nullable()
          .optional()
          .describe('Optional filters: [{ "Field": "CampaignId", "Operator": "IN", "Values": ["123"] }].'),
        goal_ids: z
          .array(z.string())
          .nullable()
          .optional()
          .describe('Metrika goal ids to split conversion metrics by.'),
        include_vat: z.enum(['YES', 'NO']).nullable().optional().describe('Include VAT in money fields. Default YES.'),
      },
    },
    async (args, extra) => {
      try {
        const { tsv, reportName } = await fetchReport(accessToken, {
          reportType: args.report_type,
          dateRangeType: args.date_range_type,
          dateFrom: args.date_from ?? null,
          dateTo: args.date_to ?? null,
          fieldNames: args.field_names,
          filter: args.filter ?? null,
          goalIds: args.goal_ids ?? null,
          includeVat: args.include_vat ?? 'YES',
        });
        const rows = tsv.trim() ? tsv.trim().split('\n').length - 1 : 0;

        if (tsv.length <= REPORT_INLINE_LIMIT) {
          return toStructuredResult({ report_type: args.report_type, rows, tsv });
        }

        const file = await filesApi.ingest({
          body: tsv,
          userId: callerUserId(extra),
          originalFilename: `${args.report_type.toLowerCase()}_${args.date_range_type.toLowerCase()}_${reportName.slice(-8)}.tsv`,
          contentType: 'text/tab-separated-values',
          sizeBytes: Buffer.byteLength(tsv, 'utf8'),
        });

        return toStructuredResult({ report_type: args.report_type, rows, file });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'yandex_direct_action',
    {
      description:
        'Execute ONE write operation in Yandex Direct: add/update/delete/suspend/resume/archive/moderate campaigns, ads, keywords, set bids and so on. This spends real advertising budgets and changes live campaigns — confirm the exact change with the user before calling. Check the payload form via yandex_ads_describe(entity, operation) first; read current state with yandex_direct_get before modifying it.',
      inputSchema: {
        entity: z.enum(directEntityKeys() as [string, ...string[]]).describe('The Direct entity to modify.'),
        operation: z
          .enum(directWriteMethodNames() as [string, ...string[]])
          .describe('The write operation; must belong to the entity (see yandex_ads_describe).'),
        params: z
          .record(z.string(), z.unknown())
          .describe('The v5 "params" object verbatim, e.g. { "SelectionCriteria": { "Ids": [123] } } for suspend.'),
      },
    },
    async ({ entity, operation, params }) => {
      try {
        const resolved = resolveWriteCall(entity, operation);
        const { result, units } = await directCall(accessToken, resolved.entity.service, resolved.method, params);

        return toStructuredResult({ entity, operation: resolved.method, result, units });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'yandex_metrika_counters',
    {
      description:
        'List the Metrika counters visible to the addressed account — its own and guest ones (permission: own/view/edit). This is the discovery step: every other Metrika tool takes a counter_id from here.',
      inputSchema: {},
    },
    async () => {
      try {
        const answer = await metrikaGet(accessToken, '/management/v1/counters', { per_page: 1000 });
        const counters = Array.isArray(answer.counters) ? (answer.counters as Array<Record<string, unknown>>) : [];

        return toStructuredResult({
          counters: counters.map(counter => ({
            id: counter.id ?? null,
            name: counter.name ?? null,
            site: counter.site2 && typeof counter.site2 === 'object' ? ((counter.site2 as Record<string, unknown>).site ?? null) : (counter.site ?? null),
            permission: counter.permission ?? null,
            status: counter.status ?? null,
            owner_login: counter.owner_login ?? null,
          })),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'yandex_metrika_get',
    {
      description:
        'Read Metrika counter settings: the counter itself, its goals (goal ids feed conversion metrics), segments, filters, operations. Read-only.',
      inputSchema: {
        counter_id: z.number().int().describe('Counter id from yandex_metrika_counters.'),
        resource: z
          .enum(METRIKA_GET_RESOURCES)
          .describe('What to read: counter (settings), goals, segments, filters, operations.'),
      },
    },
    async ({ counter_id, resource }) => {
      try {
        const path =
          resource === 'counter'
            ? `/management/v1/counter/${counter_id}`
            : `/management/v1/counter/${counter_id}/${resource}`;

        return toStructuredResult(await metrikaGet(accessToken, path));
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'yandex_metrika_report',
    {
      description:
        'Metrika statistics (Stats API): visits, users, conversions, revenue and more, sliced by source/campaign/region/date. Metric and dimension names: yandex_ads_describe("metrika"). ym:ad:directOrder joins Metrika conversions to Direct campaigns.',
      inputSchema: {
        counter_id: z.number().int().describe('Counter id from yandex_metrika_counters.'),
        metrics: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Metric names, e.g. ["ym:s:visits","ym:s:goal12345reaches"]. One namespace (ym:s / ym:ad) per query.'),
        dimensions: z
          .array(z.string())
          .max(10)
          .nullable()
          .optional()
          .describe('Slice names, e.g. ["ym:s:date","ym:s:trafficSource"].'),
        date1: z.string().nullable().optional().describe('Period start: YYYY-MM-DD or relative (today, 7daysAgo). Default: week ago.'),
        date2: z.string().nullable().optional().describe('Period end: YYYY-MM-DD or relative (today). Default: today.'),
        filters: z.string().nullable().optional().describe("Filter expression, e.g. \"ym:s:trafficSource=='ad'\"."),
        sort: z.string().nullable().optional().describe('Sort field; "-" prefix = descending. Default: -<first metric>.'),
        limit: z.number().int().min(1).max(100000).nullable().optional().describe('Row limit. Default 100.'),
        accuracy: z
          .string()
          .nullable()
          .optional()
          .describe('Sampling accuracy: low/medium/high/full or a share like 0.1. Default: Metrika decides.'),
      },
    },
    async (args, extra) => {
      try {
        const answer = await metrikaGet(accessToken, '/stat/v1/data', {
          ids: args.counter_id,
          metrics: args.metrics.join(','),
          dimensions: args.dimensions?.length ? args.dimensions.join(',') : undefined,
          date1: args.date1,
          date2: args.date2,
          filters: args.filters,
          sort: args.sort,
          limit: args.limit,
          accuracy: args.accuracy,
        });
        const data = Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : [];
        const compact = {
          counter_id: args.counter_id,
          metrics: args.metrics,
          dimensions: args.dimensions ?? [],
          total_rows: answer.total_rows ?? data.length,
          sampled: answer.sampled ?? false,
          sample_share: answer.sample_share ?? 1,
          totals: answer.totals ?? null,
          rows: data.map(row => ({
            dimensions: Array.isArray(row.dimensions)
              ? (row.dimensions as Array<Record<string, unknown>>).map(dimension => dimension.name ?? dimension.id ?? null)
              : [],
            metrics: row.metrics ?? [],
          })),
        };
        const serialized = JSON.stringify(compact);

        if (serialized.length <= REPORT_INLINE_LIMIT) {
          return toStructuredResult(compact);
        }

        const file = await filesApi.ingest({
          body: JSON.stringify(compact, null, 1),
          userId: callerUserId(extra),
          originalFilename: `metrika_${args.counter_id}_${(args.date1 ?? 'week').replace(/[^a-z0-9-]/gi, '')}.json`,
          contentType: 'application/json',
          sizeBytes: Buffer.byteLength(serialized, 'utf8'),
        });

        return toStructuredResult({ counter_id: args.counter_id, total_rows: compact.total_rows, rows_in_file: compact.rows.length, file });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'yandex_ads_whoami',
    {
      description:
        'Diagnostic: reports which Yandex login the addressed account is authorized as (id, login, display name). Use to verify a connection end to end.',
      inputSchema: {},
    },
    async () => {
      try {
        const info = await fetchLoginInfo(accessToken);

        return toStructuredResult({
          id: info.id ?? null,
          login: info.login ?? null,
          display_name: info.display_name ?? null,
          default_email: info.default_email ?? null,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP endpoint: protected-resource metadata + AS facade + authenticated /mcp
// ---------------------------------------------------------------------------

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');

  return body ? JSON.parse(body) : undefined;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown, headers?: Record<string, string>): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

function sendUnauthorized(response: http.ServerResponse, origin: string, description: string): void {
  sendJson(
    response,
    401,
    { error: 'invalid_token', error_description: description },
    {
      'www-authenticate':
        `Bearer error="invalid_token", error_description="${description}", ` +
        `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  );
}

export async function start(ctx: { filesApi: ToolFilesApi }) {
  const httpServer = http.createServer(async (request, response) => {
    const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
    const pathname = new URL(request.url ?? '/', origin).pathname;

    // RFC 9728 protected-resource metadata. The authorization server it names
    // is THIS loopback origin — the facade below — because the real
    // oauth.yandex.ru serves no machine-readable metadata.
    if (
      request.method === 'GET' &&
      (pathname === '/.well-known/oauth-protected-resource/mcp' || pathname === '/.well-known/oauth-protected-resource')
    ) {
      sendJson(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
      });
      return;
    }

    // RFC 8414 authorization-server metadata FACADE for Yandex OAuth: real
    // authorize/token endpoints, code+PKCE(S256), client_secret_post — the
    // dialect Yandex actually speaks.
    if (request.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
      sendJson(response, 200, {
        issuer: origin,
        authorization_endpoint: YANDEX_AUTHORIZE_URL,
        token_endpoint: YANDEX_TOKEN_URL,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
      return;
    }

    if (pathname !== '/mcp' || request.method !== 'POST') {
      sendJson(response, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
      return;
    }

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
    const accessToken = bearerMatch?.[1]?.trim();

    if (!accessToken) {
      sendUnauthorized(response, origin, 'Missing bearer token');
      return;
    }

    if (!(await isAccessTokenValid(accessToken))) {
      // An expired access token: the 401 makes the Balabash MCP client
      // refresh it with the stored refresh token and retry transparently.
      sendUnauthorized(response, origin, 'Yandex access token is invalid or expired');
      return;
    }

    const server = createMcpServer(accessToken, ctx.filesApi);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      const body = await readJsonBody(request);

      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
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
      auth: 'user' as const,
      description:
        'Yandex advertising: Yandex Direct (campaign observation and management) and Yandex Metrika (analytics, read-only) under one Yandex login per account. Supports several independent Yandex logins — each is a separate named account; every tool call addresses one account. Operator prerequisite (one-time): an OAuth app at oauth.yandex.ru ("Web services" platform) with redirect URI https://<balabash-domain>/oauth/callback and permissions "Yandex.Direct API" (direct:api) plus "Yandex.Metrika read" (metrika:read); provision its ClientID and Client secret via request_oauth_client_credentials. For the live Direct API each connecting Yandex login must additionally have Direct API access approved by Yandex (application form) and the API user agreement accepted in its Direct cabinet.',
      clientRegistration: 'manual' as const,
      scope: SCOPES.join(' '),
      // Identity probe: Yandex passport answers who authorized — machine id
      // plus login for display. Same endpoint the loopback uses to validate
      // incoming bearer tokens.
      identityProbe: {
        url: YANDEX_LOGIN_INFO_URL,
        idField: 'id',
        labelField: 'login',
        authScheme: 'OAuth' as const,
      },
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
