/**
 * Resolve the operator's ambient Claude credentials.
 *
 * Balabash never owns the OAuth flow. The operator logs in with the Claude
 * Code CLI on this box; the CLI maintains ~/.claude/.credentials.json
 * (including refresh rotation while the CLI runs). We only READ that store
 * to authenticate CCR bridge calls (createCodeSession / fetchRemoteCredentials).
 *
 * Env overrides mirror the CLI's own precedence:
 *   CLAUDE_CODE_OAUTH_TOKEN       — access token
 *   CLAUDE_TRUSTED_DEVICE_TOKEN   — trusted-device token (X-Trusted-Device-Token)
 *
 * The trusted-device token lives in the same credentials store under the
 * top-level `trustedDeviceToken` key once the device is enrolled. It is
 * required only when the server enforces elevated auth for bridge sessions
 * (fetchRemoteCredentials then fails terminally with reason
 * "untrusted_device"); remediation is enrolling the device via the CLI.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type OperatorCredentials = {
  accessToken: string;
  /** Epoch ms; null when unknown (env-provided token). */
  expiresAt: number | null;
  trustedDeviceToken: string | null;
  subscriptionType: string | null;
  /** Where the access token came from — for logs/diagnostics. */
  source: 'env' | 'credentials-file';
};

const CREDENTIALS_FILE = path.join(homedir(), '.claude', '.credentials.json');

/**
 * Read the credentials fresh on every call — the CLI may rotate the access
 * token on disk at any time, so callers should resolve right before use and
 * re-resolve on 401-style failures rather than caching.
 */
export async function resolveOperatorCredentials(): Promise<OperatorCredentials> {
  const envDeviceToken = process.env.CLAUDE_TRUSTED_DEVICE_TOKEN ?? null;

  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      expiresAt: null,
      trustedDeviceToken: envDeviceToken,
      subscriptionType: null,
      source: 'env',
    };
  }

  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_FILE, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read ${CREDENTIALS_FILE} — is the operator logged in with the Claude CLI on this box? (${String(err)})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CREDENTIALS_FILE} is not valid JSON`);
  }

  const store = parsed as {
    claudeAiOauth?: {
      accessToken?: string;
      expiresAt?: number;
      subscriptionType?: string;
    };
    trustedDeviceToken?: string;
  };

  const oauth = store.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(`No claudeAiOauth.accessToken in ${CREDENTIALS_FILE}`);
  }

  return {
    accessToken: oauth.accessToken,
    expiresAt: oauth.expiresAt ?? null,
    trustedDeviceToken: envDeviceToken ?? store.trustedDeviceToken ?? null,
    subscriptionType: oauth.subscriptionType ?? null,
    source: 'credentials-file',
  };
}

/** Milliseconds until the access token expires; null when unknown. */
export function tokenTtlMs(creds: OperatorCredentials): number | null {
  return creds.expiresAt == null ? null : creds.expiresAt - Date.now();
}
