import type { LegalSection } from "@/lib/legal";

// Shared renderer for the Terms of Service and Privacy Policy pages.
export function LegalDocument({
  title,
  version,
  updated,
  intro,
  sections,
}: {
  title: string;
  version: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}) {
  return (
    <div className="container-page max-w-3xl py-14">
      <div className="border-warning/40 bg-warning/10 mb-8 rounded-lg border p-3 text-xs">
        <strong>Draft.</strong> This document is a working first draft pending review by legal
        counsel and is not legal advice.
      </div>

      <h1 className="font-serif text-3xl font-bold">{title}</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Version {version} · Last updated {updated}
      </p>
      <p className="mt-4 max-w-prose text-sm">{intro}</p>

      <div className="mt-8 grid gap-6">
        {sections.map((s) => (
          <section key={s.heading}>
            <h2 className="font-serif text-lg font-semibold">{s.heading}</h2>
            {s.paragraphs.map((p, i) => (
              <p key={i} className="text-muted-foreground mt-2 max-w-prose text-sm leading-relaxed">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
