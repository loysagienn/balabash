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

  get telegramBotToken(): string {
    return requireEnv('TELEGRAM_BOT_TOKEN');
  },

  // Logins that may activate a workspace with /start. Membership in an
  // activated group is the trust boundary after that (§6) — this list gates
  // activation only.
  get telegramAllowedLogins(): string[] {
    return requireEnv('TELEGRAM_ALLOWED_LOGINS')
      .split(',')
      .map(login => login.trim().toLowerCase())
      .filter(Boolean);
  },

  get openaiApiKey(): string {
    return requireEnv('OPENAI_API_KEY');
  },

  // The coordinator model — always from config, never hardcoded.
  get mainOpenaiModel(): string {
    return requireEnv('MAIN_OPENAI_MODEL');
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
