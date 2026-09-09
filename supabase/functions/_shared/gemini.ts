// The one place the Gemini model version lives. Pinning it here (rather than
// a string literal in 20-odd functions) means a deliberate model change is a
// one-line edit, and a silent vendor update to a rolling alias can't shift
// outputs under us.
//
// Reasoning tier — the AI Report modules + the health score.
//
// Currently flash, same string as the fast tier, but the two report
// functions call it with a much larger thinking budget (2048 / 4096 — see
// ai-report-modules & ai-health-score) which is what actually steadies the
// structured output. Consistency across page views comes from the result
// cache (public.module_results), not the model: a report generates once per
// property and every later visit serves the stored bytes.
//
// A real pro model IS available and does give better single-call output:
// "gemini-3.1-pro-preview" (there is no "gemini-3.6-pro" — the 3.5+ line is
// flash-only, and the retired "gemini-2.5-pro" 404s pointing at 3.1-pro).
// It was briefly enabled here and reverted: it runs ~30-50% slower per call
// (~27s vs ~20s on a module prompt, more with vision), which pushed the
// guest free-preview past what its "wait for network idle" e2e check
// tolerates and made the first-open-per-module wait feel like a hang. Re-
// enable it only alongside latency work (streamed responses or a background
// generation job): set this back to "gemini-3.1-pro-preview" and bump
// MODEL_TAG in src/lib/module-results-cache.ts so every cached row
// regenerates once on it.
export const GEMINI_MODEL_REASONING = "gemini-3.6-flash";

// Fast tier — high-volume, low-judgement calls: document classification,
// field extraction, intent routing, deadline/hearing nudges.
export const GEMINI_MODEL_FAST = "gemini-3.6-flash";

export function geminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}
