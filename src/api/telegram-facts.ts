// The Telegram facts beside the workspace, read from the Bot API: the bound
// group's title (the workspace name of /api/me while none is stored, the
// row of the Telegram card of Settings) and the bot's own @username (the
// caption of that card). Telegram is an optional channel and these are
// enrichments of facts the database already holds, so a read never fails
// the answer — it degrades to null — and never holds it for long: every
// call to the Bot API runs under a short deadline with a real abort (the
// grammY client's default is 500 seconds, which would keep the time zone
// and the session of GET /api/settings, both local, behind one slow remote
// call). Pure over an injected client, so the stand and the unit test put
// a fake Bot API in its place: no network, no token.
//
// Caches: a title — 10 minutes, success or failure alike (a failure is a
// null title; the group is still shown by its id); the username — for the
// process once known (a bot does not change it while running), a failure —
// for a minute, then asked again. Calls in flight are shared: two tabs
// opening Settings at once make one getMe, not two.

export type BotApiClient = {
  getChat(chatId: number, signal?: AbortSignal): Promise<{ title?: string }>;
  getMe(signal?: AbortSignal): Promise<{ username?: string }>;
};

export type BoundGroup = { chatId: bigint; updatedAt: Date };

export type TelegramFactsOptions = {
  // The Bot API client, or null while the channel is off (no token): then
  // nothing is asked and every enrichment is null.
  client: () => BotApiClient | null;
  // The group bound to the workspace — the telegram_groups row of the user.
  readGroup: (userId: string) => Promise<BoundGroup | null>;
  now?: () => number;
  // How long one Bot API call may take before it is abandoned (and aborted).
  timeoutMs?: number;
  titleTtlMs?: number;
  usernameFailureTtlMs?: number;
};

export type TelegramFacts = {
  // The bound group's title, null without a group, a channel or an answer.
  groupTitle(userId: string): Promise<string | null>;
  // The bot's @username (without the @), null while the channel is off or
  // the call failed.
  botUsername(): Promise<string | null>;
  // The Telegram card's facts: the binding with its title, the bot's name.
  view(userId: string): Promise<{ enabled: boolean; botUsername: string | null; group: { chatId: bigint; title: string | null; linkedAt: Date } | null }>;
};

export const BOT_API_TIMEOUT_MS = 5_000;
export const GROUP_TITLE_TTL_MS = 10 * 60 * 1000;
export const USERNAME_FAILURE_TTL_MS = 60 * 1000;

type Cached<T> = { value: T; at: number };

export function createTelegramFacts(options: TelegramFactsOptions): TelegramFacts {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? BOT_API_TIMEOUT_MS;
  const titleTtlMs = options.titleTtlMs ?? GROUP_TITLE_TTL_MS;
  const usernameFailureTtlMs = options.usernameFailureTtlMs ?? USERNAME_FAILURE_TTL_MS;

  const titles = new Map<string, Cached<string | null>>();
  const titlesInFlight = new Map<string, Promise<string | null>>();
  let username: Cached<string | null> | null = null;
  let usernameInFlight: Promise<string | null> | null = null;

  // One Bot API call under the deadline: the signal aborts the request and
  // the race ends the wait even for a client that ignores the signal. Any
  // failure — a refusal, a transport error, the deadline — is null.
  async function ask<T>(call: (client: BotApiClient, signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const client = options.client();

    if (!client) {
      return null;
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });

    try {
      return await Promise.race([call(client, controller.signal).catch(() => null), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  function titleOf(userId: string, chatId: bigint): Promise<string | null> {
    const cached = titles.get(userId);

    if (cached && now() - cached.at < titleTtlMs) {
      return Promise.resolve(cached.value);
    }

    let pending = titlesInFlight.get(userId);

    if (!pending) {
      pending = ask((client, signal) => client.getChat(Number(chatId), signal))
        .then(chat => {
          const title = chat?.title ?? null;

          titles.set(userId, { value: title, at: now() });

          return title;
        })
        .finally(() => titlesInFlight.delete(userId));
      titlesInFlight.set(userId, pending);
    }

    return pending;
  }

  function botUsername(): Promise<string | null> {
    if (!options.client()) {
      return Promise.resolve(null);
    }

    if (username && (username.value !== null || now() - username.at < usernameFailureTtlMs)) {
      return Promise.resolve(username.value);
    }

    usernameInFlight ??= ask((client, signal) => client.getMe(signal))
      .then(me => {
        const value = me?.username ?? null;

        username = { value, at: now() };

        return value;
      })
      .finally(() => {
        usernameInFlight = null;
      });

    return usernameInFlight;
  }

  async function groupTitle(userId: string): Promise<string | null> {
    if (!options.client()) {
      return null;
    }

    const group = await options.readGroup(userId);

    return group ? titleOf(userId, group.chatId) : null;
  }

  return {
    groupTitle,
    botUsername,
    async view(userId) {
      const group = await options.readGroup(userId);
      const [title, name] = await Promise.all([group ? titleOf(userId, group.chatId) : null, botUsername()]);

      return {
        enabled: options.client() !== null,
        botUsername: name,
        group: group ? { chatId: group.chatId, title, linkedAt: group.updatedAt } : null,
      };
    },
  };
}
