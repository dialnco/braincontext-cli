/** Mirrors src/lib/tokens.ts (kept local — the SPA doesn't import across the CLI tsconfig boundary). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** 340 -> "~340 tok", 12345 -> "~12.3k tok". */
export function formatTokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`
}
