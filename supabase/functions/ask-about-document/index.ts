// Deploy via CLI: `supabase functions deploy ask-about-document`.
// Requires the GEMINI_API_KEY secret (shared with classify-document).
import { PROSE_STYLE } from "../_shared/prose-style.ts";
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Without this, supabase-js's functions.invoke() parses the body as plain text
  // (a JSON string) instead of a parsed object, based on the response Content-Type.
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { question, context } = await req.json();
    if (!question) {
      return new Response(JSON.stringify({ error: "question is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const body = {
      systemInstruction: {
        parts: [
          {
            text: `You are CorvusPT's Texas property tax assistant. Answer briefly and accurately. If unsure, say so. Do not invent numbers. Respond in plain text only — no markdown, no asterisks, no bullet points or numbered lists, no headers.\n\n${PROSE_STYLE}`,
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Context:\n${context ?? "(none)"}\n\nQuestion: ${question}`,
            },
          ],
        },
      ],
    };

    const res = await fetch(geminiUrl(GEMINI_MODEL_FAST, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    const answer = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "No response.";

    return new Response(JSON.stringify({ answer }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
