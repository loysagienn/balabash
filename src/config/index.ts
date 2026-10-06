import path from 'node:path';

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
  // only when the users table holds several rows — with zero or one user
  // ensureOperatorWorkspace() resolves it without configuration.
  get operatorUserId(): string | null {
    return process.env.OPERATOR_USER_ID?.trim() || null;
  },

  get openaiApiKey(): string {
    return requireEnv('OPENAI_API_KEY');
  },

  // Which OpenAI-shaped backend the Responses API calls go to:
  // 'openai' — api.openai.com with its
  // stateful turns and explicit prompt cache; 'openai-compatible' — any
  // server speaking the Responses API statelessly (LiteLLM/vLLM): the full
  // input every iteration, no cache options, no prewarm pings. The one
  // place reading this is harness/openai/backend.ts.
  get llmBackend(): 'openai' | 'openai-compatible' {
    const raw = process.env.LLM_BACKEND?.trim().toLowerCase() || 'openai';

    if (raw !== 'openai' && raw !== 'openai-compatible') {
      throw new Error('LLM_BACKEND must be "openai" or "openai-compatible"');
    }

    return raw;
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

  // The coordinator model — always from config, never hardcoded.
  get mainOpenaiModel(): string {
    return requireEnv('MAIN_OPENAI_MODEL');
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

  // The cheap model of the workspace annotation indexer (title/description
  // of workspace files). Optional with a default: the indexer is background
  // hygiene, its absence from env must not block a boot.
  get indexerOpenaiModel(): string {
    return process.env.INDEXER_OPENAI_MODEL || 'gpt-5.6-luna';
  },

  // Public domain of the web surface: one-time provisioning links and the
  // single OAuth redirect URI (https://<domain>/oauth/callback) are built
  // from it.
  get domain(): string {
    return requireEnv('DOMAIN');
  },

  get httpPort(): number {
    return Number(requireEnv('HTTP_PORT'));
  },

  // The apps execution domain (balabash.app): the host the core branches on
  // to serve the /apps runtime. Optional — without it the apps runtime
  // lives on the main domain (owner /apps/* by the web session, published
  // /a/<slug> without login; src/apps/urls.ts).
  get appsDomain(): string | null {
    return process.env.APPS_DOMAIN?.trim().toLowerCase() || null;
  },

  // Secret of the stateless apps cookie (HMAC over {userId, exp, kind});
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
