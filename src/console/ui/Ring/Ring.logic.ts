// Fill levels (design README, rule 5): below 80% — accent, 80–99 — warn,
// 100 and above — over. Plus the context ring's caption and tooltip text.

export type RingLevel = 'warn' | 'over';

export function ringLevel(value: number): RingLevel | undefined {
  return value >= 100 ? 'over' : value >= 80 ? 'warn' : undefined;
}

// The ring draws min(value, 100) of a path of length 100.
export function ringDash(value: number): string {
  return `${Math.max(0, Math.min(value, 100))} 100`;
}

export type CtxInput = { percentage: number; usedTokens?: number; maxTokens?: number };
export type CtxVals = { percent: number; text: string; hint: string | null; aria: string };

// "82k" — thousands of tokens, rounded.
export function formatTokensK(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export function ctxVals({ percentage, usedTokens, maxTokens }: CtxInput): CtxVals {
  const percent = Math.max(0, Math.round(percentage));
  const text = `${percent}%`;
  const hint = usedTokens !== undefined && maxTokens !== undefined ? `${formatTokensK(usedTokens)} of ${formatTokensK(maxTokens)}` : null;

  return { percent, text, hint, aria: hint ? `Context ${text}: ${hint} tokens` : `Context ${text}` };
}
