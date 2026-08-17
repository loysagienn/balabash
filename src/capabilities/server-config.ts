// Tool-server configs: external MCP servers are mcp-servers/<name>.json
// (stdio | http), validated hard; local in-process servers ship inside the
// bundle (tools/index.ts) and reuse the same config validation.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getSecretReferenceNames } from './server-secrets.ts';

const externalServersDirectory = path.resolve('mcp-servers');

// Per-tool adjustments applied on top of what the server advertises via
// listTools(): replace a description (the server's own wording may steer the
// model toward expensive tools) or hide a tool entirely. Keys are tool names
// as the server reports them; unknown keys are ignored silently — servers may
// change their tool set between connections.
export type ToolOverride = {
  description?: string;
  disabled?: boolean;
};

export type ExternalServerConfig =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      toolOverrides?: Record<string, ToolOverride>;
    }
  | {
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
      toolOverrides?: Record<string, ToolOverride>;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissingDirectoryError(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT';
}

export function validateExternalServerConfig(raw: unknown, source: string): ExternalServerConfig {
  if (!isObject(raw)) {
    throw new Error(`${source} must contain a JSON object`);
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

  if (raw.transport !== 'http') {
    throw new Error(`${source}: "transport" must be "stdio" or "http"`);
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

  const userAuthorizationKeys = ['clientRegistration', 'scope', 'authorizationParams'] as const;

  if (raw.auth !== 'user' && userAuthorizationKeys.some(key => raw[key] !== undefined)) {
    throw new Error(`${source}: ${userAuthorizationKeys.map(key => `"${key}"`).join(', ')} require "auth": "user"`);
  }

  return raw as ExternalServerConfig;
}

export async function readExternalServerConfig(serverName: string): Promise<ExternalServerConfig> {
  const filename = `${serverName}.json`;
  const raw = await readFile(path.join(externalServersDirectory, filename), 'utf8');

  return validateExternalServerConfig(JSON.parse(raw), filename);
}

export async function readExternalServerConfigs(): Promise<Record<string, ExternalServerConfig>> {
  let entries;

  try {
    entries = await readdir(externalServersDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return {};
    }

    throw error;
  }

  const configs: Record<string, ExternalServerConfig> = {};
  const filenames = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort();

  for (const filename of filenames) {
    const serverName = path.basename(filename, '.json');

    configs[serverName] = await readExternalServerConfig(serverName);
  }

  return configs;
}
