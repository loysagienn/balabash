// Installation MCP nodes: discovery transport, credentials, description and recipients.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INSTALLATION_SERVERS_DIR, listExtensionFiles, reportExtensionFailure, type ReportExtensionFailure } from './extensions.ts';
import { getSecretReferenceNames } from './server-secrets.ts';

// Identity probe of a user-auth server: the provider's own answer to "who is
// authorized here", fetched by the platform with a fresh access token right
// after authorization. The service declares where to ask and which response
// fields carry the stable machine id and the human-readable label; declaring
// a probe is the precondition for holding multiple accounts of the service.
export type IdentityProbeConfig = {
  // GET endpoint answering with JSON describing the authorized account.
  url: string;
  // Response field with the stable account id (machine part): a top-level
  // name or a dotted path into nested objects ("user.emailAddress").
  idField: string;
  // Response field with the display label (login/email), same addressing; optional.
  labelField?: string;
  // Authorization header scheme; providers differ (Yandex wants "OAuth").
  // "none": the token goes bare, without a scheme — a catalog node may ask
  // for it, a JSON config may not.
  authScheme?: 'Bearer' | 'OAuth' | 'none';
};

export type ExternalServerConfig =
  | {
      transport: 'stdio';
      recipients?: string[];
      command: string;
      args?: string[];
      env?: Record<string, string>;
      // The first sentence describes the node to its recipients.
      description?: string;
    }
  | {
      // A claude.ai account-level connector reused through Anthropic's MCP
      // proxy (mcp-proxy.anthropic.com), authenticated by the operator's
      // ambient Claude CLI login — the same read-only credentials store the
      // CCR adapter runs on. The OAuth relationship with the provider (e.g.
      // Slack) lives on claude.ai; nothing is provisioned locally. The
      // endpoint is undocumented alpha, same species as the CCR bridge.
      // The one credential involved is the operator's ambient CLI token:
      // it rotates only while a Claude Code session runs on this box, so a
      // quiet 8h boundary leaves the connector failing with 401 until the
      // next turn (claude-connector.ts) — nothing to
      // re-authorize, neither here nor at the provider.
      transport: 'claude-connector';
      // The connector's Anthropic server id (mcpsrv_…). Discoverable via
      // GET https://api.anthropic.com/v1/mcp_servers with the ambient token
      // and the "anthropic-beta: mcp-servers-2025-12-04" header.
      serverId: string;
      recipients?: string[];
      description?: string;
    }
  | {
      transport: 'http';
      recipients?: string[];
      url: string;
      // Static headers sent with every request, e.g. an Authorization header
      // carrying a ${secret:NAME} API key. Not allowed with auth: "user" —
      // there the Authorization header belongs to the OAuth flow.
      headers?: Record<string, string>;
      // "user": the server is OAuth-protected per the MCP authorization spec.
      // It is registered without connecting; every user authorizes their own
      // account. Its description appears in the Connections screen.
      auth?: 'user';
      description?: string;
      // Providers without Dynamic Client Registration need an
      // installation-level OAuth client provisioned through the operator
      // flow and stored in the database.
      clientRegistration?: 'manual';
      // Requested scopes and extra authorization URL parameters are
      // non-secret, versioned capability configuration.
      scope?: string;
      authorizationParams?: Record<string, string>;
      // Identity probe — required for the service to hold more than one
      // connected account per user (the multiplicity gate).
      identityProbe?: IdentityProbeConfig;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateExternalServerConfig(raw: unknown, source: string): ExternalServerConfig {
  if (!isObject(raw)) {
    throw new Error(`${source} must contain a JSON object`);
  }

  for (const field of ['enabledTools', 'toolOverrides']) {
    if (field in raw) throw new Error(`${source}: "${field}" is unsupported. Review the tools exposed by the server before removing this field.`);
  }

  if (raw.recipients !== undefined && (!Array.isArray(raw.recipients) ||
      raw.recipients.some(name => typeof name !== 'string' || !name.trim()))) {
    throw new Error(`${source}: "recipients" must be an array of agent or profile names`);
  }
  if (getSecretReferenceNames([raw.recipients, raw.description]).length) {
    throw new Error(`${source}: secret references belong in transport settings`);
  }

  if (raw.auth !== undefined && raw.transport !== 'http') {
    throw new Error(`${source}: "auth" requires the HTTP transport`);
  }

  if (raw.transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command) {
      throw new Error(`${source}: "command" must be a non-empty string`);
    }

    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`${source}: "args" must be an array of strings`);
    }

    if (
      raw.env !== undefined &&
      (!isObject(raw.env) || Object.values(raw.env).some(value => typeof value !== 'string'))
    ) {
      throw new Error(`${source}: "env" must be an object with string values`);
    }

    if (raw.description !== undefined && typeof raw.description !== 'string') {
      throw new Error(`${source}: "description" must be a string`);
    }

    return raw as ExternalServerConfig;
  }

  if (raw.transport === 'claude-connector') {
    if (typeof raw.serverId !== 'string' || !/^mcpsrv_[A-Za-z0-9]+$/.test(raw.serverId)) {
      throw new Error(`${source}: "serverId" must be an Anthropic MCP server id (mcpsrv_…)`);
    }

    if (raw.description !== undefined && typeof raw.description !== 'string') {
      throw new Error(`${source}: "description" must be a string`);
    }

    if (getSecretReferenceNames(raw).length) {
      throw new Error(`${source}: \${secret:NAME} references are not allowed with "claude-connector"`);
    }

    return raw as ExternalServerConfig;
  }

  if (raw.transport !== 'http') {
    throw new Error(`${source}: "transport" must be "stdio", "http" or "claude-connector"`);
  }

  if (typeof raw.url !== 'string' || !raw.url) {
    throw new Error(`${source}: "url" must be a non-empty string`);
  }

  if (
    raw.headers !== undefined &&
    (!isObject(raw.headers) || Object.values(raw.headers).some(value => typeof value !== 'string'))
  ) {
    throw new Error(`${source}: "headers" must be an object with string values`);
  }

  if (raw.auth !== undefined && raw.auth !== 'user') {
    throw new Error(`${source}: "auth" must be "user" when present`);
  }

  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new Error(`${source}: "description" must be a string`);
  }

  if (raw.auth === 'user' && (typeof raw.description !== 'string' || !raw.description.trim())) {
    throw new Error(`${source}: "description" is required for a server with "auth": "user"`);
  }

  if (raw.auth === 'user' && getSecretReferenceNames(raw).length) {
    throw new Error(`${source}: \${secret:NAME} references are not allowed with "auth": "user"`);
  }

  if (raw.auth === 'user' && raw.headers !== undefined) {
    throw new Error(`${source}: "headers" is not allowed with "auth": "user"`);
  }

  if (raw.clientRegistration !== undefined && raw.clientRegistration !== 'manual') {
    throw new Error(`${source}: "clientRegistration" must be "manual" when present`);
  }

  if (raw.scope !== undefined && (typeof raw.scope !== 'string' || !raw.scope)) {
    throw new Error(`${source}: "scope" must be a non-empty string`);
  }

  if (
    raw.authorizationParams !== undefined &&
    (!isObject(raw.authorizationParams) ||
      Object.values(raw.authorizationParams).some(value => typeof value !== 'string'))
  ) {
    throw new Error(`${source}: "authorizationParams" must be an object with string values`);
  }

  if (raw.identityProbe !== undefined) {
    if (!isObject(raw.identityProbe)) {
      throw new Error(`${source}: "identityProbe" must be an object`);
    }

    const probe = raw.identityProbe;

    if (typeof probe.url !== 'string' || !probe.url) {
      throw new Error(`${source}: "identityProbe.url" must be a non-empty string`);
    }

    if (typeof probe.idField !== 'string' || !probe.idField) {
      throw new Error(`${source}: "identityProbe.idField" must be a non-empty string`);
    }

    if (probe.labelField !== undefined && (typeof probe.labelField !== 'string' || !probe.labelField)) {
      throw new Error(`${source}: "identityProbe.labelField" must be a non-empty string`);
    }

    if (probe.authScheme !== undefined && probe.authScheme !== 'Bearer' && probe.authScheme !== 'OAuth') {
      throw new Error(`${source}: "identityProbe.authScheme" must be "Bearer" or "OAuth"`);
    }

    const knownKeys = ['url', 'idField', 'labelField', 'authScheme'];
    const unknownKeys = Object.keys(probe).filter(key => !knownKeys.includes(key));

    if (unknownKeys.length) {
      throw new Error(`${source}: "identityProbe" has unknown keys: ${unknownKeys.map(key => `"${key}"`).join(', ')}`);
    }
  }

  const userAuthorizationKeys = ['clientRegistration', 'scope', 'authorizationParams', 'identityProbe'] as const;

  if (raw.auth !== 'user' && userAuthorizationKeys.some(key => raw[key] !== undefined)) {
    throw new Error(`${source}: ${userAuthorizationKeys.map(key => `"${key}"`).join(', ')} require "auth": "user"`);
  }

  return raw as ExternalServerConfig;
}

// A broken installation config is logged and skipped so it cannot prevent boot.
export async function readExternalServerConfigs(report?: ReportExtensionFailure): Promise<Record<string, ExternalServerConfig>> {
  const configs: Record<string, ExternalServerConfig> = {};
  for (const filename of await listExtensionFiles(INSTALLATION_SERVERS_DIR, '.json')) {
    const name = path.basename(filename, '.json');
    const file = path.join(INSTALLATION_SERVERS_DIR, filename);
    try {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid MCP service name "${name}"`);
      configs[name] = validateExternalServerConfig(JSON.parse(await readFile(file, 'utf8')), file);
    } catch (error) {
      await reportExtensionFailure('mcp-servers', filename, error instanceof SyntaxError ? 'Invalid JSON' : error, report);
    }
  }
  return configs;
}
