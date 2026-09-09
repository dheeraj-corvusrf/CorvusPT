// Deploy via CLI: `supabase functions deploy suggest-doc-fields`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// Documents tab "AI autofill" for the in-place editor.
//   - PDF form: pass { documentId, fields: [<AcroForm field names>] }. The
//     file is attached so the model can read each field's printed label.
//     Returns { suggestions: [{ name, value }], notes }.
//   - Word (.docx): pass { documentId, text: "<current editable text>" }.
//     Returns { filledText, notes } — the same text with [bracketed] / blank
//     placeholders filled.
// Every value comes ONLY from the real property record below or from what is
// printed in the document. Nothing is invented; a field with no real value is
// left blank / unchanged.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { documentId, fields, text } = (await req.json()) as {
      documentId?: string;
      fields?: unknown;
      text?: unknown;
    };
    if (typeof documentId !== "string" || !documentId) {
      return new Response(JSON.stringify({ error: "documentId is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    const fieldNames = Array.isArray(fields)
      ? fields.filter((f): f is string => typeof f === "string").slice(0, 120)
      : [];
    const docText = typeof text === "string" ? text.slice(0, 20000) : "";
    if (fieldNames.length === 0 && !docText) {
      return new Response(JSON.stringify({ error: "fields or text is required" }), {
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
      .select(
        "address, cad, account_number, owner_name, land_value, improvement_value, total_value, tax_year, property_type",
      )
      .eq("id", doc.property_id)
      .maybeSingle();

    const propLines = property
      ? [
          `Address: ${property.address ?? "—"}`,
          `Owner of record: ${property.owner_name ?? "—"}`,
          `Appraisal district (CAD): ${property.cad ?? "—"}`,
          `Account / parcel number: ${property.account_number ?? "—"}`,
          `Property type: ${property.property_type ?? "—"}`,
          `Land value: ${property.land_value != null ? `$${Number(property.land_value).toLocaleString()}` : "—"}`,
          `Improvement value: ${property.improvement_value != null ? `$${Number(property.improvement_value).toLocaleString()}` : "—"}`,
          `Total assessed value: ${property.total_value != null ? `$${Number(property.total_value).toLocaleString()}` : "—"}`,
          `Tax year: ${property.tax_year ?? "—"}`,
        ].join("\n")
      : "(no property record on file)";

    const parts: unknown[] = [];
    let system: string;

    if (docText) {
      system =
        `You are CorvusPT's form-fill assistant. You are given a document's editable text and the real facts of the property it is filed under. Fill any [bracketed] placeholders, "____" blanks, or obviously empty labelled fields using ONLY the property facts below or values already present elsewhere in the text. Leave a placeholder EXACTLY as-is if you have no real value for it — never invent one. Keep all other wording, order, and line breaks unchanged.\n\n` +
        `Return ONLY a JSON object: {"filledText": "<the full document text with placeholders filled>", "notes": "<one short sentence naming anything you could not fill, or empty string>"}`;
      parts.push({
        text: `Property facts:\n${propLines}\n\nDocument text:\n"""\n${docText}\n"""`,
      });
    } else {
      system =
        `You are CorvusPT's form-fill assistant. You are given a fillable PDF form (attached) and the real facts of the property it is filed under, plus the list of the form's field names. For each field name, suggest the value to enter using ONLY the property facts below or what is printed on the form. Read each field's printed label on the form to understand what it wants. Omit a field entirely if you have no real value for it — never invent one. For a checkbox field return "true" or "false"; for a choice field return the exact option text.\n\n` +
        `Return ONLY a JSON object: {"suggestions": [{"name": "<field name, exactly as given>", "value": "<value>"}], "notes": "<one short sentence naming fields you left for the user, or empty string>"}`;
      parts.push({
        text: `Property facts:\n${propLines}\n\nForm field names:\n${fieldNames.join("\n")}\n\nThe attached file is "${doc.file_name}".`,
      });
      const { data: blob } = await adminClient.storage.from("documents").download(doc.storage_path);
      if (blob && blob.size <= 18 * 1024 * 1024) {
        parts.push({
          inline_data: {
            mime_type: blob.type || "application/pdf",
            data: base64(await blob.arrayBuffer()),
          },
        });
      }
    }

    const res = await fetch(geminiUrl(GEMINI_MODEL_FAST, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      if (res.status === 429) {
        return new Response(
          JSON.stringify({ error: "AI is rate-limited. Please retry in a moment." }),
          { status: 429, headers: corsHeaders },
        );
      }
      throw new Error(`Gemini API error ${res.status}: ${t.slice(0, 200)}`);
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

    if (docText) {
      return new Response(
        JSON.stringify({
          filledText: str(parsed.filledText, 20000) || docText,
          notes: str(parsed.notes, 300),
        }),
        { status: 200, headers: corsHeaders },
      );
    }

    const allowed = new Set(fieldNames);
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
          .map((x) => ({ name: str(x.name, 200), value: str(x.value, 500) }))
          .filter((x) => x.name.length > 0 && allowed.has(x.name))
          .slice(0, 120)
      : [];
    return new Response(JSON.stringify({ suggestions, notes: str(parsed.notes, 300) }), {
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
