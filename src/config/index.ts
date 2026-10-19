import path from 'node:path';
import type { EffortLevel } from '../core/contract.ts';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

export const config = {
  get databaseUrl(): string {
    return requireEnv('DATABASE_URL');
  },

  // Telegram is one channel adapter among several: it exists only when a
  // bot token is configured. The core never
  // consults this flag — app.ts starts the adapter under it, and the adapter
  // itself reads the token through telegramBotToken (required there).
  get telegramEnabled(): boolean {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
  },

  // Claude remote-control (CCR, src/adapters/ccr): the operator's Claude app
  // as the surface of claude-sdk threads. A singleton channel — one ambient
  // Claude CLI login = one operator = the operator workspace (§3.1).
  get ccrEnabled(): boolean {
    return process.env.CCR_ENABLED === 'true';
  },

  // Read only inside the Telegram adapter, which runs only when
  // telegramEnabled — hence still required here.
  get telegramBotToken(): string {
    return requireEnv('TELEGRAM_BOT_TOKEN');
  },

  // Logins that may activate a workspace with /start. Membership in an
  // activated group is the trust boundary after that (§6) — this list gates
  // activation only. Optional: without it no new group can be activated, the
  // groups activated earlier keep working.
  get telegramAllowedLogins(): string[] {
    return (process.env.TELEGRAM_ALLOWED_LOGINS ?? '')
      .split(',')
      .map(login => login.trim().toLowerCase())
      .filter(Boolean);
  },

  // The operator's workspace: the one
  // workspace a singleton channel (CCR) or an offline script serves. Needed
  // only when the workspaces table holds several rows — with zero or one
  // workspace ensureOperatorWorkspace() resolves it without configuration.
  // OPERATOR_USER_ID is the variable's former name: still read so an
  // installation whose .env predates the rename boots; app.ts says so at boot.
  get operatorWorkspaceId(): string | null {
    return process.env.OPERATOR_WORKSPACE_ID?.trim() || process.env.OPERATOR_USER_ID?.trim() || null;
  },

  get openaiApiKey(): string {
    return requireEnv('OPENAI_API_KEY');
  },

  // Which LLM backend the coordinator's model calls go to: 'openai' —
  // api.openai.com over the Responses API with its stateful turns and
  // explicit prompt cache; 'openai-compatible' — any server speaking the
  // Responses API statelessly (LiteLLM/vLLM): the full input every
  // iteration, no cache options, no prewarm pings; 'anthropic' —
  // api.anthropic.com over the Messages API (MAIN_ANTHROPIC_API_KEY). The
  // one place reading this is harness/openai/backend.ts.
  get llmBackend(): 'openai' | 'openai-compatible' | 'anthropic' {
    const raw = process.env.LLM_BACKEND?.trim().toLowerCase() || 'openai';

    if (raw !== 'openai' && raw !== 'openai-compatible' && raw !== 'anthropic') {
      throw new Error('LLM_BACKEND must be "openai", "openai-compatible" or "anthropic"');
    }

    return raw;
  },

  // Read only by the Anthropic driver (LLM_BACKEND=anthropic). Deliberately
  // not the SDK's own ANTHROPIC_API_KEY: the app's environment is inherited
  // by every Claude Agent SDK session it starts (harness/claude-sdk), and
  // the SDK would take that variable over the host's plan login — the
  // coordinator's key would then pay for all the agents.
  get anthropicApiKey(): string {
    return requireEnv('MAIN_ANTHROPIC_API_KEY');
  },

  // Base URL of the OpenAI-shaped API; unset = the SDK default (api.openai.com).
  get openaiBaseUrl(): string | null {
    return process.env.OPENAI_BASE_URL?.trim() || null;
  },

  // Char budget of the coordinator's transcript (the rendered event log in a
  // turn's prompt); the model window is the ceiling, the model's attention
  // the real limit. Default 50 000 (~12k tokens).
  get coordinatorTranscriptChars(): number {
    const raw = process.env.COORDINATOR_TRANSCRIPT_CHARS;
    const chars = raw === undefined || raw.trim() === '' ? 50_000 : Number(raw);

    if (!Number.isInteger(chars) || chars <= 0) {
      throw new Error('COORDINATOR_TRANSCRIPT_CHARS must be a positive integer');
    }

    return chars;
  },

  // The coordinator model — always from config, never hardcoded: the
  // variable of the configured backend (MAIN_ANTHROPIC_MODEL under
  // LLM_BACKEND=anthropic, MAIN_OPENAI_MODEL for the Responses API
  // backends).
  get mainModel(): string {
    return requireEnv(this.llmBackend === 'anthropic' ? 'MAIN_ANTHROPIC_MODEL' : 'MAIN_OPENAI_MODEL');
  },

  // Reasoning effort of the coordinator model where the backend takes one
  // (the Anthropic driver's output_config.effort). Default 'medium': the
  // secretary routes and relays; Opus 5.5 defaults to medium itself, set
  // explicitly so a model default drifting does not move the cache prefix.
  get coordinatorEffort(): EffortLevel {
    const raw = process.env.COORDINATOR_EFFORT?.trim().toLowerCase() || 'medium';

    if (!EFFORT_LEVELS.includes(raw as EffortLevel)) {
      throw new Error(`COORDINATOR_EFFORT must be one of ${EFFORT_LEVELS.join(', ')}`);
    }

    return raw as EffortLevel;
  },

  // Prompt-cache keep-alive window of the coordinator, minutes after the last
  // turn during which the thread's cached prefix is kept warm with prewarm
  // pings (see coordinator/index.ts). 0 disables. Default 6h: with ~75k
  // prefixes a ping costs ~1/12 of a cold write, and the pauses between the
  // user's turns rarely exceed a working half-day.
  get coordinatorCacheKeepaliveWindowMs(): number {
    const raw = process.env.COORDINATOR_CACHE_KEEPALIVE_MINUTES;
    const minutes = raw === undefined || raw.trim() === '' ? 360 : Number(raw);

    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new Error('COORDINATOR_CACHE_KEEPALIVE_MINUTES must be a non-negative number');
    }

    return minutes * 60 * 1000;
  },

  // The workspace annotation indexer is background hygiene, not a feature
  // anyone waits for: INDEXER_ENABLED="false" switches it off entirely (no
  // passes, no model calls). Default on.
  get indexerEnabled(): boolean {
    return process.env.INDEXER_ENABLED?.trim().toLowerCase() !== 'false';
  },

  // The cheap model of the workspace annotation indexer (title/description
  // of workspace files). Optional with a default: the indexer is background
  // hygiene, its absence from env must not block a boot.
  get indexerOpenaiModel(): string {
    return process.env.INDEXER_OPENAI_MODEL || 'gpt-5.6-luna';
  },

  get httpPort(): number {
    return Number(requireEnv('HTTP_PORT'));
  },

  // The apps execution domain (balabash.app): the host the core branches on
  // to serve the /apps runtime. Optional — without it the apps runtime
  // lives on the console domain (owner /apps/* by the web session, published
  // /a/<slug> without login; src/apps/urls.ts).
  get appsDomain(): string | null {
    return process.env.APPS_DOMAIN?.trim().toLowerCase() || null;
  },

  // The public domain of the web surface (console.balabash.app): the host
  // the core serves the console on — a browser SPA next to /api and /files
  // (src/api/console.ts) — and the origin of every link the system hands
  // out: the one-time provisioning and sign-in links, the owner pages of
  // apps, the signed file links and the single OAuth redirect URI
  // (https://<domain>/oauth/callback).
  get consoleDomain(): string {
    return requireEnv('CONSOLE_DOMAIN').trim().toLowerCase();
  },

  // Secret of the stateless apps cookie (HMAC over {workspaceId, exp, kind});
  // deliberately its OWN secret — the cookie is never interchangeable with
  // session machinery even if one of the secrets leaks. Read lazily: only
  // the apps surfaces touch it, a boot without APPS_DOMAIN never needs it.
  get appsCookieSecret(): string {
    return requireEnv('APPS_COOKIE_SECRET');
  },

  // Pepper mixed into web-session token hashes: a DB leak alone is not
  // enough to forge a session cookie.
  get sessionPepper(): string {
    return requireEnv('SESSION_PEPPER');
  },

  // IANA timezone the schedule module evaluates cron expressions in. One-shot
  // triggers (at) are absolute instants and do not depend on it.
  get scheduleTimezone(): string {
    return process.env.SCHEDULE_TIMEZONE || 'Asia/Jerusalem';
  },

  // File storage driver: 'spaces' —
  // the S3-compatible object store with presigned URLs; 'local' — the local
  // disk under filesRoot with signed links onto the web surface. Default:
  // spaces when the SPACES_* variables are set, local otherwise.
  get fileStorage(): 'local' | 'spaces' {
    const raw = process.env.FILE_STORAGE?.trim().toLowerCase();

    if (raw === 'local' || raw === 'spaces') {
      return raw;
    }

    if (raw) {
      throw new Error('FILE_STORAGE must be "local" or "spaces"');
    }

    return process.env.SPACES_BUCKET_NAME ? 'spaces' : 'local';
  },

  // Root directory of the local file storage driver; files/ in the
  // repository root by default (gitignored).
  get filesRoot(): string {
    return path.resolve(process.env.FILES_ROOT?.trim() || 'files');
  },

  get spacesRegion(): string {
    return requireEnv('SPACES_REGION');
  },

  get spacesBucketName(): string {
    return requireEnv('SPACES_BUCKET_NAME');
  },

  get spacesAccessKeyId(): string {
    return requireEnv('SPACES_ACCESS_KEY_ID');
  },

  get spacesAccessKeySecret(): string {
    return requireEnv('SPACES_ACCESS_KEY_SECRET');
  },
};
