// Deploy via CLI: `supabase functions deploy hearing-nudge`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// No Supabase auth check — same known-risk pattern already accepted for the other
// guest-accessible AI functions (classify-document, ask-about-document, route-intent,
// ai-health-score, deadline-nudge): a rate-limited free API, no per-user state at stake.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type HearingNudgeInput = {
  address: string;
  daysLeft: number;
};

const SYSTEM = `You are CorvusPT's Texas property tax assistant. The owner of a property already has
a protest filed and an ARB (Appraisal Review Board) hearing scheduled. Given the
property's address and the number of days left until the hearing (a negative number
means the hearing already happened), write ONE short, encouraging reminder sentence
(under 30 words) telling them to review their case's hearing prep and evidence
checklist before the hearing, referencing the days-left figure given. Do not tell them
to "request a protest" — they already have one. If the hearing has already passed,
tell them to check their case for the ARB's decision instead of mentioning a future
hearing. Do not invent numbers not given to you. Respond in plain text only — no
markdown, no asterisks, no bullet points.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const input = (await req.json()) as HearingNudgeInput;
    if (!input.address || typeof input.daysLeft !== "number") {
      return new Response(JSON.stringify({ error: "address and daysLeft are required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const record = [
      `Address: ${input.address}`,
      `Days left until ARB hearing: ${input.daysLeft}`,
    ].join("\n");

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: record }] }],
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
    const message =
      json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ??
      "Your ARB hearing is approaching — review your case's hearing prep before it happens.";

    return new Response(JSON.stringify({ message }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
