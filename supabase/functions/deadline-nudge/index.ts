// Deploy via CLI: `supabase functions deploy deadline-nudge`.
// Requires the GEMINI_API_KEY secret (shared with the other AI functions).
//
// No Supabase auth check — same known-risk pattern already accepted for the other
// guest-accessible AI functions (classify-document, ask-about-document, route-intent,
// ai-health-score): a rate-limited free API, no per-user state at stake.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type DeadlineNudgeInput = {
  address: string;
  daysLeft: number;
  totalValue?: number;
};

const SYSTEM = `You are CorvusPT's Texas property tax assistant. The owner of a property has a
protest deadline approaching and has not yet requested a protest. Given the property's
address and the number of days left until the deadline (a negative number means the
deadline has already passed), write ONE short, urgent but encouraging reminder sentence
(under 30 words) telling them to request their protest now, referencing the days-left
figure given. If the deadline has already passed, tell them to act immediately/contact
CorvusPT rather than mentioning a future deadline. Do not invent numbers not given to
you. Respond in plain text only — no markdown, no asterisks, no bullet points.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const input = (await req.json()) as DeadlineNudgeInput;
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
      `Days left until protest deadline: ${input.daysLeft}`,
      input.totalValue != null && `Total assessed value: $${input.totalValue.toLocaleString()}`,
    ]
      .filter(Boolean)
      .join("\n");

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
      "Your protest deadline is approaching — request your protest before it's too late.";

    return new Response(JSON.stringify({ message }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
