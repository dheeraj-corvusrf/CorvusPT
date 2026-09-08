// Deploy via CLI: `supabase functions deploy extract-comp-sale`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Module 3 (Market Value) — given one stored document id (a closing
// disclosure / settlement statement / purchase contract / fee appraisal the
// owner uploaded), read it and pull the few sale facts actually printed on
// it: address, sale price, sale date, building/land square footage, source.
// Nothing is written back; the client uses the result to pre-fill the
// "Add a comparable" form, which the user confirms before it is saved as a
// verified comp. Same discipline as analyze-document: transcribe printed
// facts only, never guess, never make a fraud call. Texas is a
// non-disclosure state — a "verified" sale here means "a document the owner
// provided states it", not that it is publicly recorded.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const SYSTEM = `You are CorvusPT's document reader for a Texas property-tax protest platform. You are given ONE uploaded real-estate document (a closing disclosure, settlement statement, purchase contract, or fee appraisal). Read its real content and pull only the sale facts that are actually printed on the page.

Return ONLY a JSON object with this exact shape:
{
  "address": <string|null>,          // the property that sold, one line
  "salePrice": <number|null>,        // the contract / purchase / closing price, digits only
  "saleDate": <string|null>,         // ISO date "YYYY-MM-DD" if a closing/effective/sale date is stated
  "buildingSqft": <number|null>,     // gross building area / improvement SF if stated
  "landSqft": <number|null>,         // lot size in square feet (convert acres: acres * 43560) if stated
  "source": <string|null>,           // what kind of document this is, in 2-4 words
  "confidence": <number>,            // 0-100, how clearly the sale price + address are stated
  "notes": <string|null>             // one short plain sentence if something key is missing/illegible; else null
}

Rules:
- Every field is null when the document does not actually state it. Never guess a typical figure.
- salePrice is the real transaction price, not an appraised value, tax value, or loan amount. If the document is a fee appraisal with only an opinion of value and no sale, set salePrice null and say so in notes.
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
const str = (v: unknown, len: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, len) : null;
};
const isoDate = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
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

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [
            {
              role: "user",
              parts: [
                { text: `The attached file is named "${doc.file_name}". Return the JSON response.` },
                { inline_data: { mime_type: mimeType, data } },
              ],
            },
          ],
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

    const result = {
      address: str(parsed.address, 200),
      salePrice: toNum(parsed.salePrice),
      saleDate: isoDate(parsed.saleDate),
      buildingSqft: toNum(parsed.buildingSqft),
      landSqft: toNum(parsed.landSqft),
      source: str(parsed.source, 60),
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence)) || 0)),
      notes: str(parsed.notes, 200),
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
