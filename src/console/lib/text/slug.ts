// Words of a text as a slug: lowercase Latin letters and digits, one dash
// between words, none at the ends. Cyrillic is transliterated (a Russian
// name is the usual case), accents are dropped, the rest of Unicode goes.
// The callers add their own rule on top — a project folder starts with a
// letter, a public app URL may start with a digit — and their own cap.

// Cyrillic letters to Latin for the folder name (a Russian title is the
// usual case; the rest of Unicode is dropped by the slug rule).
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  є: 'ye', і: 'i', ї: 'yi', ґ: 'g',
};

// "Bathroom renovation" → "bathroom-renovation", "Ремонт ванной" →
// "remont-vannoy", "--- 2027 plans ---" → "2027-plans".
export function slugWords(text: string): string {
  // Cyrillic first: NFD would split й and ё into a base letter and a mark.
  const latin = text
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, letter => CYRILLIC[letter] ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Cuts a slug to the cap without leaving a dash at the end.
export function capSlug(slug: string, max: number): string {
  return slug.slice(0, max).replace(/-+$/, '');
}
