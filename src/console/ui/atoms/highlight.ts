// Search-match highlighting shared by the rows that show a hit (ThreadRow,
// PaletteItem): the text split into plain and matched parts.

export type TextPart = { text: string; hit: boolean };

// Splits text into plain and matched parts, the match compared without
// case (the search is), the original casing kept. Lowercasing can change
// the length of a string ("İ" becomes "i" plus a combining dot), so the
// text is lowered character by character with a map from every index of
// the lowered string back to the original, and the parts are cut from the
// original by that map. A match that ends inside such an expanded
// character takes the whole character.
export function highlightParts(text: string, hit?: string): TextPart[] {
  if (!text) {
    return [];
  }
  const needle = hit?.toLowerCase() ?? '';

  if (!needle) {
    return [{ text, hit: false }];
  }
  const { lower, back } = lowerWithMap(text);
  const parts: TextPart[] = [];
  let from = 0;

  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    const start = back[at] ?? text.length;
    let end = back[at + needle.length] ?? text.length;

    if (end <= start) {
      end = start + charLength(text, start);
    }
    if (start < from) {
      continue;
    }
    if (start > from) {
      parts.push({ text: text.slice(from, start), hit: false });
    }
    parts.push({ text: text.slice(start, end), hit: true });
    from = end;
  }
  if (from < text.length) {
    parts.push({ text: text.slice(from), hit: false });
  }

  return parts;
}

// The lowered text and, for every index of it (plus the end), the index of
// the original character it came from.
function lowerWithMap(text: string): { lower: string; back: number[] } {
  let lower = '';
  const back: number[] = [];

  for (let i = 0; i < text.length; ) {
    const len = charLength(text, i);
    const lowered = text.slice(i, i + len).toLowerCase();

    for (let k = 0; k < lowered.length; k++) {
      back.push(i);
    }
    lower += lowered;
    i += len;
  }
  back.push(text.length);

  return { lower, back };
}

// 2 for a surrogate pair, 1 otherwise.
function charLength(text: string, at: number): number {
  const code = text.codePointAt(at) ?? 0;

  return code > 0xffff ? 2 : 1;
}
