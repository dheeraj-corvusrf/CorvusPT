// Deploy via CLI: `supabase functions deploy extract-income-financials`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Module 7 (Income Value) — given one stored document id (a profit & loss /
// operating statement, a rent roll, or a fee appraisal the owner uploaded),
// read it and pull only the income figures actually printed on it: gross
// potential income, other income, vacancy %, operating expenses (and by
// category), NOI, a capitalization rate (only if an appraisal states one),
// rentable SF. Nothing is written back; the client uses the result to
// pre-fill the income figures form, which the owner confirms before it is
// saved. Same discipline as extract-comp-sale / analyze-document: transcribe
// printed facts only, never guess a typical figure, never make a fraud call.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const SYSTEM = `You are CorvusPT's document reader for a Texas property-tax protest platform. You are given ONE uploaded financial document for one commercial property — a profit & loss statement, an operating statement, a rent roll, or a fee appraisal. Read its real content and pull only the figures that are actually printed on the page.

Return ONLY a JSON object with this exact shape:
{
  "documentKind": <"P&L"|"Operating Statement"|"Rent Roll"|"Appraisal"|"Other"|null>,
  "grossPotentialIncome": <number|null>,   // annual potential/scheduled gross rental income, digits only
  "otherIncome": <number|null>,            // annual other/ancillary income (parking, laundry, CAM, etc.)
  "vacancyPct": <number|null>,             // vacancy &/or collection-loss percentage, 0-100
  "operatingExpenses": <number|null>,      // annual total operating expenses (exclude debt service, capex, depreciation)
  "operatingExpensesByCategory": [ { "category": <string>, "amount": <number> } ],  // [] if not itemised
  "noi": <number|null>,                    // net operating income if stated directly
  "capRatePct": <number|null>,             // capitalization / overall rate (OAR), 0-100 — ONLY if the document states one
  "rentableSqft": <number|null>,           // net rentable / gross building area if stated
  "periodLabel": <string|null>,            // e.g. "TTM ending 6/30/2025", "FY2024", "Monthly x12"
  "confidence": <number>,                  // 0-100, how clearly the income figures are stated
  "notes": <string|null>                   // one short plain sentence if something key is missing/illegible; else null
}

Rules:
- Every field is null (arrays []) when the document does not actually state it. NEVER guess a typical figure, ratio, or rate.
- capRatePct: only when the document explicitly states a capitalization rate, overall rate, or OAR — essentially only a fee appraisal. A P&L or rent roll almost never states one; return null then.
- operatingExpenses is recurring operating cost only — do NOT include mortgage/debt service, capital expenditures, depreciation, or income taxes.
- If the statement is monthly and says so, annualise (multiply by 12) and note it in periodLabel; otherwise leave figures as stated.
- Do NOT make a forgery, tampering, or fraud judgement — only read what is printed.
- Plain prose only in "notes", no markdown.`;

const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  return null;
};
const pct = (v: unknown): number | null => {
  const raw =
    typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : NaN;
  if (!Number.isFinite(raw) || raw <= 0 || raw > 100) return null;
  return Math.round(raw * 100) / 100;
};
const str = (v: unknown, len: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, len) : null;
};
const KINDS = ["P&L", "Operating Statement", "Rent Roll", "Appraisal", "Other"];
const kind = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return KINDS.includes(s) ? s : null;
};

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function extOf(name: string): string {
  const e = name.toLowerCase().split(".").pop();
  return e && e.length <= 5 ? e : "pdf";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { documentId } = (await req.json()) as { documentId?: string };
    if (typeof documentId !== "string" || !documentId) {
      return new Response(JSON.stringify({ error: "documentId is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const {
      data: { user },
      error: userErr,
    } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: doc } = await adminClient
      .from("documents")
      .select("id, user_id, file_name, storage_path")
      .eq("id", documentId)
      .maybeSingle();
    if (!doc) {
      return new Response(JSON.stringify({ error: "Document not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    if (doc.user_id !== user.id) {
      const { data: me } = await adminClient
        .from("profiles")
        .select("is_admin")
        .eq("id", user.id)
        .maybeSingle();
      if (!me?.is_admin) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: corsHeaders,
        });
      }
    }

    const { data: blob, error: dlErr } = await adminClient.storage
      .from("documents")
      .download(doc.storage_path);
    if (dlErr || !blob) {
      return new Response(JSON.stringify({ error: "Could not read the stored file." }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    if (blob.size > 18 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "File is too large to analyze (over 18 MB)." }), {
        status: 413,
        headers: corsHeaders,
      });
    }
    const ext = extOf(doc.file_name);
    const mimeType =
      blob.type ||
      (ext === "pdf"
        ? "application/pdf"
        : ["jpg", "jpeg"].includes(ext)
          ? "image/jpeg"
          : ext === "png"
            ? "image/png"
            : "application/octet-stream");
    const data = base64(await blob.arrayBuffer());

    const res = await fetch(geminiUrl(GEMINI_MODEL_FAST, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `The attached file is named "${doc.file_name}". Return the JSON response.`,
              },
              { inline_data: { mime_type: mimeType, data } },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429) {
        return new Response(
          JSON.stringify({ error: "AI is rate-limited. Please retry in a moment." }),
          { status: 429, headers: corsHeaders },
        );
      }
      throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const byCat = Array.isArray(parsed.operatingExpensesByCategory)
      ? (parsed.operatingExpensesByCategory as unknown[])
          .map((row) => {
            const r = (row ?? {}) as Record<string, unknown>;
            const category = str(r.category, 60);
            const amount = toNum(r.amount);
            return category && amount != null ? { category, amount } : null;
          })
          .filter((x): x is { category: string; amount: number } => x != null)
          .slice(0, 20)
      : [];

    const result = {
      documentKind: kind(parsed.documentKind),
      grossPotentialIncome: toNum(parsed.grossPotentialIncome),
      otherIncome: toNum(parsed.otherIncome),
      vacancyPct: pct(parsed.vacancyPct),
      operatingExpenses: toNum(parsed.operatingExpenses),
      operatingExpensesByCategory: byCat,
      noi: toNum(parsed.noi),
      capRatePct: pct(parsed.capRatePct),
      rentableSqft: toNum(parsed.rentableSqft),
      periodLabel: str(parsed.periodLabel, 80),
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence)) || 0)),
      notes: str(parsed.notes, 240),
      documentId,
    };

    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
