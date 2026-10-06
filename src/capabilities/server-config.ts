// Tool-server configs: external MCP servers are mcp-servers/<name>.json
// (stdio | http | claude-connector), validated hard; local in-process servers
// ship inside the bundle (tools/index.ts) and reuse the same config
// validation. Which agents see a server is decided by the agents' explicit
// tool lists, not here.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INSTALLATION_SERVERS_DIR, listExtensionFiles } from './extensions.ts';
import { getSecretReferenceNames } from './server-secrets.ts';

// Two directories, one catalog: the repository's mcp-servers/ and the
// installation's data/mcp-servers/ (src/capabilities/extensions.ts). A name
// present in both is a loud error — an extension never shadows the repository.
const externalServersDirectory = path.resolve('mcp-servers');
const externalServersDirectories = [externalServersDirectory, INSTALLATION_SERVERS_DIR];

// Per-tool adjustments applied on top of what the server advertises via
// listTools(): replace a description (the server's own wording may steer the
// model toward expensive tools) or hide a tool entirely. Keys are tool names
// as the server reports them; unknown keys are ignored silently — servers may
// change their tool set between connections.
export type ToolOverride = {
  description?: string;
  disabled?: boolean;
};

// Positive tool selection: when present, only the named tools of the server
// are exposed, everything else it advertises is dropped. Preferred over
// per-tool "disabled" for servers with large, growing catalogs (a hosted
// server adding tools must not silently widen the model's context). Names
// missing from the server's current list are logged, not fatal.
export type EnabledTools = string[];

// Identity probe of a user-auth server: the provider's own answer to "who is
// authorized here", fetched by the platform with a fresh access token right
// after authorization. The service declares where to ask and which response
// fields carry the stable machine id and the human-readable label; declaring
// a probe is the precondition for holding multiple accounts of the service.
export type IdentityProbeConfig = {
  // GET endpoint answering with JSON describing the authorized account.
  url: string;
  // Top-level response field with the stable account id (machine part).
  idField: string;
  // Top-level response field with the display label (login/email); optional.
  labelField?: string;
  // Authorization header scheme; providers differ (Yandex wants "OAuth").
  authScheme?: 'Bearer' | 'OAuth';
};

// Tool names live in one flat function namespace shared by every server. A
// server whose tool names carry no vendor prefix (a bare "ask" or "search")
// collides with same-named tools of other servers; prefixTools renames its
// functions to "<server>__<tool>" at listing time. Purely a namespace remap —
// the MCP call still uses the server's own tool name.
type NamespaceOptions = {
  prefixTools?: boolean;
};

export type ExternalServerConfig =
  | (NamespaceOptions & {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      enabledTools?: EnabledTools;
      toolOverrides?: Record<string, ToolOverride>;
    })
  | (NamespaceOptions & {
      // A claude.ai account-level connector reused through Anthropic's MCP
      // proxy (mcp-proxy.anthropic.com), authenticated by the operator's
      // ambient Claude CLI login — the same read-only credentials store the
      // CCR adapter runs on. The OAuth relationship with the provider (e.g.
      // Slack) lives on claude.ai; nothing is provisioned locally. The
      // endpoint is undocumented alpha, same species as the CCR bridge.
      transport: 'claude-connector';
      // The connector's Anthropic server id (mcpsrv_…). Discoverable via
      // GET https://api.anthropic.com/v1/mcp_servers with the ambient token
      // and the "anthropic-beta: mcp-servers-2025-12-04" header.
      serverId: string;
      description?: string;
      enabledTools?: EnabledTools;
      toolOverrides?: Record<string, ToolOverride>;
    })
  | (NamespaceOptions & {
      transport: 'http';
      url: string;
      // Static headers sent with every request, e.g. an Authorization header
      // carrying a ${secret:NAME} API key. Not allowed with auth: "user" —
      // there the Authorization header belongs to the OAuth flow.
      headers?: Record<string, string>;
      // "user": the server is OAuth-protected per the MCP authorization spec.
      // It is registered without connecting; every user authorizes their own
      // account (auth agent), and its tools are exposed per user.
      // description is required in that mode — it is all the model sees
      // before the first connection.
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
      enabledTools?: EnabledTools;
      toolOverrides?: Record<string, ToolOverride>;
    });

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}


export function validateExternalServerConfig(raw: unknown, source: string): ExternalServerConfig {
  if (!isObject(raw)) {
    throw new Error(`${source} must contain a JSON object`);
  }

  if (raw.prefixTools !== undefined && typeof raw.prefixTools !== 'boolean') {
    throw new Error(`${source}: "prefixTools" must be a boolean`);
  }

  if (raw.enabledTools !== undefined) {
    if (
      !Array.isArray(raw.enabledTools) ||
      !raw.enabledTools.length ||
      raw.enabledTools.some(name => typeof name !== 'string' || !name.trim())
    ) {
      throw new Error(`${source}: "enabledTools" must be a non-empty array of tool names`);
    }

    if (new Set(raw.enabledTools).size !== raw.enabledTools.length) {
      throw new Error(`${source}: "enabledTools" must not repeat tool names`);
    }
  }

  if (raw.toolOverrides !== undefined) {
    if (!isObject(raw.toolOverrides)) {
      throw new Error(`${source}: "toolOverrides" must be an object keyed by tool name`);
    }

    for (const [toolName, override] of Object.entries(raw.toolOverrides)) {
      if (!isObject(override)) {
        throw new Error(`${source}: "toolOverrides.${toolName}" must be an object`);
      }

      if (override.description !== undefined && (typeof override.description !== 'string' || !override.description.trim())) {
        throw new Error(`${source}: "toolOverrides.${toolName}.description" must be a non-empty string`);
      }

      if (override.disabled !== undefined && typeof override.disabled !== 'boolean') {
        throw new Error(`${source}: "toolOverrides.${toolName}.disabled" must be a boolean`);
      }

      const knownKeys = ['description', 'disabled'];
      const unknownKeys = Object.keys(override).filter(key => !knownKeys.includes(key));

      if (unknownKeys.length) {
        throw new Error(
          `${source}: "toolOverrides.${toolName}" has unknown keys: ${unknownKeys.map(key => `"${key}"`).join(', ')}`,
        );
      }
    }
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

async function readExternalServerConfigFile(directory: string, serverName: string): Promise<ExternalServerConfig> {
  const filename = `${serverName}.json`;
  const raw = await readFile(path.join(directory, filename), 'utf8');

  return validateExternalServerConfig(JSON.parse(raw), path.join(path.basename(directory), filename));
}

// Repository configs are validated hard (a broken file fails the build's
// boot and the supervisor rolls the bundle back); an installation's
// data/mcp-servers/<name>.json is NOT fail-fast — it lives outside the
// bundle, so a boot failure could not be rolled back: a broken or clashing
// file is logged and skipped, and the server does not exist until the file
// is fixed and the app restarted (the same rule as data/tools).
export async function readExternalServerConfigs(): Promise<Record<string, ExternalServerConfig>> {
  const configs: Record<string, ExternalServerConfig> = {};
  const origins = new Map<string, string>();

  for (const directory of externalServersDirectories) {
    const extension = directory === INSTALLATION_SERVERS_DIR;

    for (const filename of await listExtensionFiles(directory, '.json')) {
      const serverName = path.basename(filename, '.json');
      const file = path.join(directory, filename);

      try {
        const origin = origins.get(serverName);

        if (origin) {
          throw new Error(`External server "${serverName}" is defined twice: ${path.join(origin, filename)} and ${file}`);
        }

        const config = await readExternalServerConfigFile(directory, serverName);

        origins.set(serverName, directory);
        configs[serverName] = config;
      } catch (error) {
        if (!extension) {
          throw error;
        }

        console.error(`[tools] extension server config ${file} skipped:`, error);
      }
    }
  }

  return configs;
}
