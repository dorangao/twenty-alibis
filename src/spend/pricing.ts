/**
 * Prices for the one model this project uses, in whole nanodollars per token.
 * Integers only: no floating-point drift in the spend counter.
 *
 * Source: Meta Model API pricing for Muse Ember (USD per 1M tokens):
 *   up to 200K input tokens: $0.10 input, $0.004 cached input, $0.50 output
 *   above 200K input tokens: $0.30 / $0.012 / $1.50, applied to the whole request
 * Reasoning tokens are billed as output tokens.
 */
export const MODEL = "muse-ember-1.0" as const;

export const NANO_PER_USD = 1_000_000_000;
export const TIER_LIMIT_TOKENS = 200_000;

export const LOW_TIER = { input: 100, cached: 4, output: 500 } as const;
export const HIGH_TIER = { input: 300, cached: 12, output: 1500 } as const;

export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  /** The cached part of `inputTokens`. */
  cachedTokens: number;
  /** All billed output tokens, reasoning included. */
  outputTokens: number;
  /** The reasoning part of `outputTokens`, when reported. */
  reasoningTokens?: number;
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;

/** What a finished request cost, from its usage block. */
export function costNano(u: Usage): number {
  if (!isCount(u.inputTokens) || !isCount(u.cachedTokens) || !isCount(u.outputTokens)) {
    throw new RangeError("token counts must be non-negative integers");
  }
  if (u.cachedTokens > u.inputTokens) {
    throw new RangeError("cachedTokens cannot exceed inputTokens");
  }
  const tier = u.inputTokens > TIER_LIMIT_TOKENS ? HIGH_TIER : LOW_TIER;
  return (
    (u.inputTokens - u.cachedTokens) * tier.input +
    u.cachedTokens * tier.cached +
    u.outputTokens * tier.output
  );
}

/**
 * The most a request can cost when it is known to stay within the low tier:
 * a full 200K uncached input plus the whole output limit.
 * This is what gets reserved before a request is sent.
 */
export function worstCaseNano(maxOutputTokens: number): number {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new RangeError("maxOutputTokens must be a positive integer");
  }
  return TIER_LIMIT_TOKENS * LOW_TIER.input + maxOutputTokens * LOW_TIER.output;
}

/** The model's whole context window. No request can carry more input than this. */
export const CONTEXT_WINDOW_TOKENS = 1_048_576;

/**
 * The most any single request can cost, whatever its size turns out to be: a full context
 * window of uncached input at the high-tier price, plus the whole output limit at the
 * high-tier price. This needs no assumption about how many tokens a body becomes, so it is
 * the hold used until a measured bound proves a request stays in the low tier.
 */
export function absoluteWorstNano(maxOutputTokens: number): number {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new RangeError("maxOutputTokens must be a positive integer");
  }
  return CONTEXT_WINDOW_TOKENS * HIGH_TIER.input + maxOutputTokens * HIGH_TIER.output;
}

export function usdToNano(usd: number): number {
  return Math.round(usd * NANO_PER_USD);
}

export function nanoToUsd(nano: number): number {
  return nano / NANO_PER_USD;
}
