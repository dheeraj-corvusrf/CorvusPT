// Deterministic helpers over Module 4's real 16-factor site assessment — same
// convention as executive-summary.ts: real logic, never re-asked of the AI.
import type { ModuleResultMap } from "./ai-report-modules";

export type SiteFactor = ModuleResultMap["site"]["factors"][number];

const SEVERITY_RANK: Record<SiteFactor["severity"], number> = {
  High: 3,
  Moderate: 2,
  Low: 1,
  Unknown: 0,
};

// The single most relevant factor to headline on the compact card — the
// highest-severity factor that's actually backed by real/partial data.
// Never an "Additional Data Needed" factor: showing a gap as if it were a
// finding would be the exact kind of fabrication this module is built to
// avoid. Returns null when nothing real has been found yet, so the card can
// show an honest "Additional Data Needed" state instead of an empty gap.
export function pickHeadlineFactor(factors: SiteFactor[]): SiteFactor | null {
  const withData = factors.filter(
    (f) => f.status !== "Additional Data Needed" && f.status !== "Not Applicable",
  );
  if (withData.length === 0) return null;
  return [...withData].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
}

// Real count of factors still needing more data — shown plainly (e.g. "14 of
// 16 factors need more data") rather than buried, so the honesty of the
// "Additional Data Needed" majority is visible, not just implied by the
// individual row statuses.
export function countDataGaps(factors: SiteFactor[]): number {
  return factors.filter((f) => f.status === "Additional Data Needed").length;
}
