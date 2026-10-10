// Account naming: the display name is the user's word, the slug is the
// immutable mnemonic address derived from it at birth — by the auth agent's
// request_authorization and by the console's "Connect" alike. Pure.

// Account slugs are immutable mnemonic addresses; the pattern keeps them
// url- and enum-friendly.
export const ACCOUNT_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

// 'default' is reserved for the pre-multi-account singleton: a user named
// "Default" must not become indistinguishable from it.
export const DEFAULT_ACCOUNT_KEY = 'default';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function deriveAccountKey(name: string, taken: ReadonlySet<string>): string {
  const base = name
    .toLowerCase()
    .split('')
    .map(char => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);
  const root = base && ACCOUNT_KEY_PATTERN.test(base) ? base : 'account';

  if (!taken.has(root)) {
    return root;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${root}-${suffix}`;

    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
