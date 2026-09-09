import { supabase } from "./supabase";
import type { BatchModuleId, ModuleAnalysisInput } from "./ai-report-modules";

// Stored AI Report module results (public.module_results). A page load serves
// the stored result instead of re-calling the AI, so the report is identical
// every visit and costs one generation per property, not one per view. The
// AI is re-called only when a module's real inputs change (input_hash
// mismatch), the user clicks Regenerate, or nothing is stored yet.
//
// The report page passes the exact `input` object it would have sent to the
// edge function; because a downstream module's input embeds the upstream
// modules' outputs (priorityContext, topStrategies, evidenceReadiness, …), a
// changed upstream result naturally changes the downstream hash — cascade
// invalidation with no extra bookkeeping.

// Bump when the report model or the prompt/schema shape changes in a way that
// should invalidate every cached result. Folded into every hash, so bumping
// it makes every stored row miss on the next visit and regenerate once.
export const MODEL_TAG = "gemini-3.6-flash/thinking-2048/v1";

// Stable, order-independent JSON — sort object keys recursively so
// {a,b} and {b,a} hash the same. Arrays keep their order (order is meaningful
// for e.g. topComps / topStrategies).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export async function hashModuleInput(
  moduleId: BatchModuleId | "health",
  input: ModuleAnalysisInput,
  modelTag: string = MODEL_TAG,
): Promise<string> {
  const payload = `${moduleId}|${modelTag}|${stableStringify(input)}`;
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export type CachedModuleResult = {
  result: unknown;
  inputHash: string;
  model: string;
  updatedAt: string;
};

export async function getCachedModuleResult(
  propertyId: string,
  moduleId: string,
): Promise<CachedModuleResult | null> {
  const { data, error } = await supabase
    .from("module_results")
    .select("result, input_hash, model, updated_at")
    .eq("property_id", propertyId)
    .eq("module_id", moduleId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    result: data.result,
    inputHash: data.input_hash as string,
    model: data.model as string,
    updatedAt: data.updated_at as string,
  };
}

export async function saveModuleResult(
  userId: string,
  propertyId: string,
  moduleId: string,
  inputHash: string,
  model: string,
  result: unknown,
): Promise<void> {
  const { error } = await supabase.from("module_results").upsert(
    {
      user_id: userId,
      property_id: propertyId,
      module_id: moduleId,
      input_hash: inputHash,
      model,
      result: result as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "property_id,module_id" },
  );
  if (error) throw error;
}

// "3 days ago" / "just now" — for the "Updated …" line next to Regenerate.
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "just now";
  const secs = Math.round((Date.now() - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const table: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, s] of table) {
    if (Math.abs(secs) >= s) return rtf.format(-Math.round(secs / s), unit);
  }
  return "just now";
}
