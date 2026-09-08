// Deploy via CLI: `supabase functions deploy review-document`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Documents tab "AI Review". Given one stored document id it downloads the
// file (service role) and:
//   - with no question: returns a plain-language explanation of the document
//     (what it is, the key facts, what it means for the protest, caveats) and
//     stores it on documents.ai_explanation;
//   - with a question: answers that question grounded in the file + the
//     property it's filed under. Not stored (ephemeral Q&A).
// Same discipline as analyze-document: read what's printed, never invent a
// value, never make a fraud/forgery call.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const BASE_SYSTEM = `You are CorvusPT's document reviewer for a Texas property-tax protest platform. You are given ONE uploaded document and the real facts of the property it is filed under. Read the document's actual content. Never invent a value, date, account number, or term that is not printed on the page. Do NOT make a forgery, tampering, or fraud judgement. Plain text only — no markdown, no bullet lists, no headers. Short, direct sentences; no "based on the provided information" preamble; every sentence carries real information.`;

const EXPLAIN_SYSTEM = `${BASE_SYSTEM}

Return ONLY a JSON object: {"explanation": "<2 to 4 short paragraphs, separated by a blank line: (1) what this document is, (2) the key facts printed on it — values, dates, account/parcel, parties, (3) what it means for this property's protest, (4) anything incomplete, expired, illegible, or inconsistent with the property facts. Say plainly if the document is unrelated to a property-tax protest.>"}`;

const ANSWER_SYSTEM = `${BASE_SYSTEM}

Answer the user's question about the attached document in 1-4 short sentences, grounded only in what the document says and the property facts given. If the document does not contain the answer, say so.
Return ONLY a JSON object: {"answer": "<your answer>"}`;

const str = (v: unknown, len: number): string =>
  typeof v === "string" ? v.trim().slice(0, len) : "";

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
    const { documentId, question } = (await req.json()) as {
      documentId?: string;
      question?: string;
    };
    if (typeof documentId !== "string" || !documentId) {
      return new Response(JSON.stringify({ error: "documentId is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    const q = typeof question === "string" ? question.trim().slice(0, 1000) : "";

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
      .select("id, user_id, property_id, file_name, storage_path")
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

    const promptText = q
      ? `Property facts (already on file):\n${contextLines.join("\n") || "(none)"}\n\nThe attached file is "${doc.file_name}".\n\nQuestion: ${q}`
      : `Property facts (already on file):\n${contextLines.join("\n") || "(none)"}\n\nThe attached file is "${doc.file_name}". Explain it.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: q ? ANSWER_SYSTEM : EXPLAIN_SYSTEM }] },
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data } }],
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

    if (q) {
      return new Response(JSON.stringify({ answer: str(parsed.answer, 2000) || "No answer." }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const explanation = str(parsed.explanation, 4000);
    if (explanation) {
      await adminClient
        .from("documents")
        .update({ ai_explanation: explanation })
        .eq("id", documentId);
    }
    return new Response(JSON.stringify({ explanation, documentId }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
