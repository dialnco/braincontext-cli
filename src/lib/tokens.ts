/**
 * Rough token estimate (~4 chars/token for English/markdown). Deliberately a
 * heuristic: budgeting "can I afford to open this page?" tolerates ±15%, and a
 * real tokenizer dep would add megabytes to the bundled CLI for no extra value.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Human-compact token label: 340 -> "~340 tok", 12345 -> "~12.3k tok". */
export function formatTokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`
}
