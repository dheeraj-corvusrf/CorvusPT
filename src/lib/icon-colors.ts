// Shared icon-circle color palette, reused across marketing pages, the dashboard, and
// the AI Report module grid so a "give each item its own color" treatment stays
// centrally defined instead of re-invented per file. Every tone here already exists
// somewhere else in this app — accent/success/warning are theme tokens
// (src/styles.css), violet/teal/pink/sky match the ad hoc hex values already used in
// the dashboard's PortfolioValueChart/ProtestStatusChart (src/routes/dashboard/_layout.index.tsx) —
// nothing new is being invented, just applied more consistently. Extended to 10 tones
// (rose/indigo/lime added) so the AI Report's 10 modules can each get their own
// distinct color instead of the last 3 repeating the first 3 (see modules.ts).
export type IconColor = { bg: string; text: string; solid: string };

// Tint opacity bumped from /15 to /20 (2026-09, "more colorful/bolder"
// feedback) — same 10 hues, just richer against both white cards and the
// app's own faint-green page background, sitewide, from this one file.
export const ICON_COLORS: IconColor[] = [
  { bg: "bg-accent/20", text: "text-accent", solid: "var(--accent)" },
  { bg: "bg-violet-500/20", text: "text-violet-600", solid: "#7c3aed" },
  { bg: "bg-teal-500/20", text: "text-teal-600", solid: "#0d9488" },
  { bg: "bg-warning/25", text: "text-warning-foreground", solid: "var(--warning)" },
  { bg: "bg-pink-500/20", text: "text-pink-600", solid: "#db2777" },
  { bg: "bg-success/20", text: "text-success", solid: "var(--success)" },
  { bg: "bg-sky-500/20", text: "text-sky-600", solid: "#0284c7" },
  { bg: "bg-rose-500/20", text: "text-rose-600", solid: "#e11d48" },
  { bg: "bg-indigo-500/20", text: "text-indigo-600", solid: "#4f46e5" },
  { bg: "bg-lime-500/20", text: "text-lime-700", solid: "#4d7c0f" },
];
