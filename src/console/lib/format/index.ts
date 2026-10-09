// Formatting helpers shared by ui/ and screens: English plural forms,
// numbers. Dates, durations and file sizes join as the screens need them.

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return n === 1 ? one : many;
}

// "4 threads", "1 thread" — count and noun together.
export function countOf(n: number, one: string, many?: string): string {
  return `${n.toLocaleString('en-US')} ${plural(n, one, many)}`;
}
