// Deploy via CLI: `supabase functions deploy analyze-document`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Per-document AI check for the Documents tab. Given one stored document id it:
//  1. downloads the file (service role) and reads it with the property it's
//     filed under + the other documents already on that property for context;
//  2. asks Gemini to classify it, pull the few facts printed on it, name what
//     it is, and note anything incomplete/illegible/inconsistent — NOT to make
//     a forgery/fraud call, which a model reading a PDF cannot reliably do;
//  3. computes the verdict (valid | issues | invalid) DETERMINISTICALLY here —
//     account/address mismatch against the property on file, or a >2% value
//     discrepancy, or a real concern — never the model's own say-so;
//  4. writes category/source/ai_verdict/ai_notes/ai_cross_refs/ai_checked_at/
//     suggested_name back to the row and returns the analysis.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const CATEGORIES = [
  "appraisal_notice",
  "tax_bill",
  "bpp_rendition",
  "hearing_notice",
  "hearing_decision",
  "settlement_offer",
  "signed_agreement",
  "filing_proof",
  "evidence",
  "deed",
  "report",
  "correspondence",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];

// Which categories originate from the county / ARB even if the customer
// uploaded the copy, vs. things the customer or CorvusPT produced.
const SOURCE_BY_CATEGORY: Record<Category, string> = {
  appraisal_notice: "county",
  tax_bill: "county",
  bpp_rendition: "county",
  hearing_notice: "county",
  hearing_decision: "county",
  settlement_offer: "county",
  signed_agreement: "signed",
  filing_proof: "uploaded",
  evidence: "uploaded",
  deed: "uploaded",
  report: "generated",
  correspondence: "uploaded",
  other: "uploaded",
};

// Categories where a stated value is meaningfully comparable to the assessed
// value on file.
const VALUE_BEARING = new Set<Category>([
  "appraisal_notice",
  "tax_bill",
  "hearing_decision",
  "settlement_offer",
]);

const SYSTEM = `You are CorvusPT's document reviewer for a Texas property-tax protest platform. You are given ONE uploaded document, context about the property it is filed under, and a short list of the OTHER documents already on file for that property.

Read the document's real content. Never invent a value, date, account number, or term that is not actually printed on the page.

Return ONLY a JSON object with this exact shape:
{
  "category": "<one of: appraisal_notice | tax_bill | bpp_rendition | hearing_notice | hearing_decision | settlement_offer | signed_agreement | filing_proof | evidence | deed | report | correspondence | other>",
  "whatItIs": "<one plain sentence naming what this document actually is>",
  "accountNumber": <string|null>,
  "propertyAddress": <string|null>,
  "taxYear": <string|null>,
  "statedValue": <number|null>,
  "concerns": [<"short plain observation of anything incomplete, illegible, cut off, expired, blank, or internally inconsistent">],
  "suggestedName": "<a filename following the naming standard below — no folder path, keep the real file extension>",
  "crossRefs": [<"short observation relating THIS document to the property facts or one of the other listed documents">]
}

Rules:
- Every fact field is null when the document genuinely does not state it — never guess a typical value.
- "concerns" is [] when the document looks complete and legible. Do NOT make a forgery, tampering, or fraud judgement — only describe what is visibly wrong or missing.
- "crossRefs" is [] when nothing is notable.
- Plain prose only, no markdown.
- Naming standard for "suggestedName": "<Category words> - <Acct NUMBER, or a short address if there is no account number> - <tax year, or Mon YYYY>.<ext>". Examples: "Appraisal Notice - Acct 2748399 - 2026.pdf", "Evidence - 705 State Hwy 352 - Aug 2026.jpg", "Signed Agreement - Acct 34086 - 2026.pdf".
- If the file is not a property-tax-related document at all (a random photo, an unrelated file), use category "other", say so in "whatItIs", and add a concern.`;

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) && n !== 0 ? n : null;
  }
  return null;
};
const str = (v: unknown, len: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, len) : null;
};
const strList = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x, len))
        .filter((x): x is string => !!x)
        .slice(0, max)
    : [];

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
      .select("id, user_id, property_id, file_name, storage_path, document_type")
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

    const { data: property } = await adminClient
      .from("properties")
      .select("address, cad, account_number, owner_name, total_value, tax_year")
      .eq("id", doc.property_id)
      .maybeSingle();

    const { data: siblings } = await adminClient
      .from("documents")
      .select("file_name, category, document_type")
      .eq("property_id", doc.property_id)
      .neq("id", documentId)
      .limit(15);

    // Download the file itself.
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
      return new Response(
        JSON.stringify({ error: "File is too large to analyze (over 18 MB)." }),
        { status: 413, headers: corsHeaders },
      );
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

    const contextLines = [
      property?.address ? `Property address on file: ${property.address}` : null,
      property?.cad ? `Appraisal district: ${property.cad}` : null,
      property?.account_number ? `Account number on file: ${property.account_number}` : null,
      property?.owner_name ? `Owner of record: ${property.owner_name}` : null,
      property?.total_value != null
        ? `Assessed value on file: $${Number(property.total_value).toLocaleString()}`
        : null,
      property?.tax_year ? `Tax year on file: ${property.tax_year}` : null,
    ].filter(Boolean);

    const siblingLines = (siblings ?? []).map(
      (s) => `- ${s.file_name}${s.category ? ` (${s.category})` : ""}`,
    );

    const parts = [
      {
        text:
          `Property this document is filed under (real facts, already on file — use only to judge whether the document matches and is consistent, never as the source of the extracted fields):\n${contextLines.length ? contextLines.join("\n") : "(none on file)"}\n\n` +
          `Other documents already on file for this property:\n${siblingLines.length ? siblingLines.join("\n") : "(none)"}\n\n` +
          `The attached file is named "${doc.file_name}". Analyze it and return the full JSON response.`,
      },
      { inline_data: { mime_type: mimeType, data } },
    ];

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      },
    );
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

    const category: Category = (CATEGORIES as readonly string[]).includes(parsed.category as string)
      ? (parsed.category as Category)
      : "other";
    const whatItIs = str(parsed.whatItIs, 240) ?? "Unclear what this document is.";
    const acct = str(parsed.accountNumber, 40);
    const addr = str(parsed.propertyAddress, 200);
    const taxYear = str(parsed.taxYear, 10);
    const statedValue = toNum(parsed.statedValue);
    const concerns = strList(parsed.concerns, 6, 240);
    const modelCrossRefs = strList(parsed.crossRefs, 6, 240);

    let suggestedName = str(parsed.suggestedName, 160) ?? "";
    suggestedName = suggestedName.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    if (suggestedName && !suggestedName.toLowerCase().endsWith("." + ext)) {
      suggestedName = suggestedName.replace(/\.[a-z0-9]{1,5}$/i, "") + "." + ext;
    }

    // ---- Deterministic verdict ------------------------------------------
    const mismatches: string[] = [];
    const acctMismatch =
      !!acct && !!property?.account_number && norm(acct) !== norm(property.account_number);
    if (acctMismatch) {
      mismatches.push(
        `The account number on this document (${acct}) doesn't match the one on file (${property!.account_number}).`,
      );
    }
    let addrMismatch = false;
    if (addr && property?.address) {
      const a = norm(addr);
      const b = norm(property.address);
      addrMismatch = !a.includes(b.slice(0, 12)) && !b.includes(a.slice(0, 12));
      if (addrMismatch) {
        mismatches.push(
          `The address on this document ("${addr}") doesn't clearly match the property on file ("${property.address}").`,
        );
      }
    }
    let valueMismatch = false;
    if (VALUE_BEARING.has(category) && statedValue != null && property?.total_value != null) {
      const onFile = Number(property.total_value);
      const rel = Math.abs(statedValue - onFile) / Math.max(statedValue, onFile);
      if (rel > 0.02) {
        valueMismatch = true;
        mismatches.push(
          `The value stated here ($${statedValue.toLocaleString()}) differs from the assessed value on file ($${onFile.toLocaleString()}).`,
        );
      }
    }

    let verdict: "valid" | "issues" | "invalid";
    if (acctMismatch || addrMismatch || (category === "other" && !acct && !addr)) {
      verdict = "invalid";
    } else if (valueMismatch || concerns.length > 0) {
      verdict = "issues";
    } else {
      verdict = "valid";
    }

    const notes = [whatItIs, ...mismatches, ...concerns].join(" ");

    // A couple of deterministic cross-refs on top of the model's.
    const detCrossRefs: string[] = [];
    const sameCat = (siblings ?? []).filter((s) => s.category === category).length;
    if (sameCat > 0 && ["appraisal_notice", "tax_bill", "hearing_decision"].includes(category)) {
      detCrossRefs.push(
        `${sameCat} other ${category.replace("_", " ")} document${sameCat === 1 ? " is" : "s are"} also on file for this property — check they're for different years.`,
      );
    }
    if (
      VALUE_BEARING.has(category) &&
      statedValue != null &&
      property?.total_value != null &&
      !valueMismatch
    ) {
      detCrossRefs.push(
        `The value on this document matches the assessed value on file ($${Number(property.total_value).toLocaleString()}).`,
      );
    }
    const crossRefs = [...detCrossRefs, ...modelCrossRefs].slice(0, 6);

    const source = SOURCE_BY_CATEGORY[category];
    const aiCheckedAt = new Date().toISOString();

    await adminClient
      .from("documents")
      .update({
        category,
        source,
        ai_verdict: verdict,
        ai_notes: notes.slice(0, 2000),
        ai_cross_refs: crossRefs.join("\n").slice(0, 2000) || null,
        ai_checked_at: aiCheckedAt,
        suggested_name: suggestedName || null,
      })
      .eq("id", documentId);

    return new Response(
      JSON.stringify({
        documentId,
        category,
        source,
        verdict,
        notes: notes.slice(0, 2000),
        crossRefs,
        suggestedName: suggestedName || null,
        aiCheckedAt,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
