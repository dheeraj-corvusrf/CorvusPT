// The one place the Gemini model version lives. Pinning it here (rather than
// a string literal in 20-odd functions) means a deliberate model change is a
// one-line edit, and a silent vendor update to a rolling alias can't shift
// outputs under us.
//
// Reasoning tier — the AI Report modules + the health score. When this
// project's Gemini setup has a "pro"/reasoning model available, set it here
// (the AI Report is now generated once per property and cached, so the
// higher per-call cost is bounded). As of this writing only
// "gemini-3.6-flash" resolves on the configured GEMINI_API_KEY —
// "gemini-3.6-pro" and every variant tried returned 404 — so it stays on
// flash, but with a larger thinking budget (see ai-report-modules /
// ai-health-score) which measurably steadies the structured output.
export const GEMINI_MODEL_REASONING = "gemini-3.6-flash";

// Fast tier — high-volume, low-judgement calls: document classification,
// field extraction, intent routing, deadline/hearing nudges.
export const GEMINI_MODEL_FAST = "gemini-3.6-flash";

export function geminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}
