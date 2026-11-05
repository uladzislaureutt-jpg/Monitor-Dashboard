// Fail over between distinct Gemini credentials on MINUTE rate limits only.
// Different API keys are not necessarily different quota projects: this code
// avoids retry storms but does not claim additional Google RPM capacity.
export type GeminiCredential = { name: string; key: string };
export type GeminiOutcome = { ok: boolean; status?: number; retryAfter?: string | null;
  diagnostic?: { retryable?: boolean } };

export function distinctGeminiCredentials(values: readonly GeminiCredential[]): GeminiCredential[] {
  const seen = new Set<string>();
  return values.filter(({key}) => {
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function minuteCooldownMs(retryAfter: string | null | undefined): number {
  const text = String(retryAfter || "").trim();
  const seconds = /^\d+(?:\.\d+)?s?$/.test(text) ? Number.parseFloat(text) : 60;
  return Math.max(1_000, Math.min(120_000, Math.ceil(seconds * 1000)));
}

export function makeGeminiKeyFailover(now: () => number = Date.now) {
  const coolingUntil = new Map<string, number>();
  return async function tryCredentials<T extends GeminiOutcome>(
    credentials: readonly GeminiCredential[],
    call: (credential: GeminiCredential) => Promise<T>,
    whenAllCooling: () => T,
    options?: { budgetMs?: number; onFailover?: (name: string) => void },
  ): Promise<T> {
    const start = now();
    const available = distinctGeminiCredentials(credentials)
      .filter(({key}) => (coolingUntil.get(key) || 0) <= start);
    if (!available.length) return whenAllCooling();
    let previous: T | undefined;
    for (const [index, credential] of available.entries()) {
      // Preserve the HTTP operation's budget for Cloudflare/Groq fallback.
      if (index > 0 && options?.budgetMs && now() - start + 3_000 >= options.budgetMs)
        break;
      if (index > 0) options?.onFailover?.(credential.name);
      const response = await call(credential);
      previous = response;
      if (response.ok || response.status !== 429 || !response.diagnostic?.retryable)
        return response;
      coolingUntil.set(credential.key, now() + minuteCooldownMs(response.retryAfter));
    }
    return previous ?? whenAllCooling();
  };
}
