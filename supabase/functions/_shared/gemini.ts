// The one place the Gemini model version lives. Pinning it here (rather than
// a string literal in 20-odd functions) means a deliberate model change is a
// one-line edit, and a silent vendor update to a rolling alias can't shift
// outputs under us.
//
// Reasoning tier — the AI Report modules + the health score. The report is
// generated once per property and cached (public.module_results), so the
// higher per-call cost of a pro model is bounded to one generation per
// property, not one per page view.
//
// This is a *preview* model — it's the current top of the Gemini pro line
// on the configured GEMINI_API_KEY (there is no "gemini-3.6-pro"; the 3.5+
// releases are flash-only, and the retired "gemini-2.5-pro" 404s with a
// message pointing here). If Google deprecates it, `models?key=…` lists the
// replacement; update this one constant and bump MODEL_TAG in
// src/lib/module-results-cache.ts so every cached row regenerates once on
// the new model. The runtime kill switch (app_settings.ai_report_cache_enabled)
// is unrelated — it governs caching, not the model.
export const GEMINI_MODEL_REASONING = "gemini-3.1-pro-preview";

// Fast tier — high-volume, low-judgement calls: document classification,
// field extraction, intent routing, deadline/hearing nudges.
export const GEMINI_MODEL_FAST = "gemini-3.6-flash";

export function geminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}
