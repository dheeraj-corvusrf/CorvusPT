import { supabase } from "./supabase";
import { fileToDataUrl } from "./intake-store";
import { invokeEdgeFunction } from "./edge-functions";

// The canonical set of "module" tags a document can be assigned to — the AI
// Report modules plus the case sections that consume documents. `id` is what
// gets stored in documents.modules (a text[]); `label` is the chip text; the
// `needs` line is only fed to the assign-document-modules classifier so it
// knows what each module actually uses a document for. Keep this list in
// sync with the module ids in src/lib/ai-report-modules.ts.
export const MODULE_CATALOG: { id: string; label: string; needs: string }[] = [
  {
    id: "health",
    label: "Health Score",
    needs:
      "the CAD appraisal notice, value history, anything that sets or disputes the assessed value",
  },
  {
    id: "strategy",
    label: "Protest Strategy",
    needs:
      "any evidence that supports a specific protest argument — comps, condition, income, equity",
  },
  {
    id: "comps",
    label: "Comparable Sales",
    needs:
      "closing statements, purchase contracts, appraisals, broker opinions, comparable-sale data",
  },
  {
    id: "site",
    label: "Site Conditions",
    needs:
      "surveys, plats, flood determinations, easements, environmental reports, photos of site issues",
  },
  {
    id: "improvement",
    label: "Improvement Condition",
    needs:
      "photos of the building, inspection or repair reports, cost estimates, condition assessments",
  },
  {
    id: "zoning",
    label: "Zoning & Use",
    needs: "zoning letters, use permits, deed restrictions, plats, certificates of occupancy",
  },
  {
    id: "income",
    label: "Income Approach",
    needs: "rent rolls, operating statements, P&Ls, leases, appraisals with an income approach",
  },
  {
    id: "evidence",
    label: "Evidence Packet",
    needs: "any document the owner intends to submit as protest evidence",
  },
  {
    id: "executive",
    label: "Executive Summary",
    needs: "documents that materially change the headline value, savings, or recommendation",
  },
  {
    id: "hearing",
    label: "Hearing",
    needs: "the ARB hearing notice, evidence exchange packets, hearing-day materials",
  },
  {
    id: "informal_settlement",
    label: "Settlement",
    needs: "the county's proposed value or settlement offer, signed settlement agreements",
  },
  {
    id: "filing",
    label: "Filing",
    needs:
      "the Notice of Protest, Appointment of Agent, filing confirmations, certified-mail receipts",
  },
];

export const MODULE_TAG_LABEL: Record<string, string> = Object.fromEntries(
  MODULE_CATALOG.map((m) => [m.id, m.label]),
);

const VALID_MODULE_IDS = new Set(MODULE_CATALOG.map((m) => m.id));

const MAX_DOCS = 8;
const MAX_BYTES_PER_DOC = 8 * 1024 * 1024;

export type ModuleAssignment = { fileName: string; modules: string[]; rationale: string };

// Real, just-picked Files in → the set of module ids each one genuinely
// feeds out (one document can serve several). Same "never block on an AI
// feature" discipline as categorizeEvidenceUploads: any failure, oversize
// file, or overflow past MAX_DOCS just comes back with modules: [] and the
// caller proceeds — the document is still uploaded, just untagged until the
// user tags it by hand.
export async function assignDocumentModules(files: File[]): Promise<ModuleAssignment[]> {
  const fallback = (): ModuleAssignment[] =>
    files.map((f) => ({ fileName: f.name, modules: [], rationale: "" }));
  if (files.length === 0) return fallback();

  const usable = files.slice(0, MAX_DOCS).filter((f) => f.size <= MAX_BYTES_PER_DOC);
  if (usable.length === 0) return fallback();

  try {
    const documents = await Promise.all(
      usable.map(async (f) => ({
        fileName: f.name,
        mimeType: f.type || "application/octet-stream",
        dataUrl: await fileToDataUrl(f),
      })),
    );
    const { findings } = await invokeEdgeFunction<{ findings: ModuleAssignment[] }>(
      "assign-document-modules",
      { documents, catalog: MODULE_CATALOG },
    );
    const byName = new Map(
      findings.map((f) => [
        f.fileName,
        {
          modules: Array.isArray(f.modules)
            ? f.modules.filter((m): m is string => typeof m === "string" && VALID_MODULE_IDS.has(m))
            : [],
          rationale: typeof f.rationale === "string" ? f.rationale : "",
        },
      ]),
    );
    return files.map((f) => {
      const hit = byName.get(f.name);
      return { fileName: f.name, modules: hit?.modules ?? [], rationale: hit?.rationale ?? "" };
    });
  } catch {
    return fallback();
  }
}

// Owner-set (or classifier-set, via the client) override of a document's
// module tags. The narrow column grant on documents.modules makes this a
// plain update — no edge function needed.
export async function setDocumentModules(docId: string, modules: string[]): Promise<void> {
  const clean = Array.from(new Set(modules.filter((m) => VALID_MODULE_IDS.has(m))));
  const { error } = await supabase.from("documents").update({ modules: clean }).eq("id", docId);
  if (error) throw error;
}

// Convenience for the upload paths: classify one just-uploaded file and
// persist its module tags, returning the tag list (empty on any failure).
// Never throws.
export async function tagUploadedDocument(docId: string, file: File): Promise<string[]> {
  try {
    const [assignment] = await assignDocumentModules([file]);
    const modules = assignment?.modules ?? [];
    if (modules.length > 0) await setDocumentModules(docId, modules);
    return modules;
  } catch {
    return [];
  }
}
