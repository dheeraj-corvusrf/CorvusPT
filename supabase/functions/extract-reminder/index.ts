// Deploy via CLI: `supabase functions deploy extract-reminder`.
// Requires the GEMINI_API_KEY secret (shared with route-intent / ask-about-document).
//
// Turns a phrase like "remind me to email the Denton ARB next Tuesday" into a
// structured reminder. The client (src/lib/reminders.ts) only calls this once
// its own cheap regex says the message looks like a reminder request, so this
// is a low-volume call on GEMINI_MODEL_FAST.
//
// Discipline: never invent a date. If the phrase has no resolvable date,
// remindOn is null and the caller asks the user for one — same "honest data"
// rule the rest of the app follows.
import { GEMINI_MODEL_FAST, geminiUrl } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { phrase, today, properties } = (await req.json()) as {
      phrase?: string;
      today?: string;
      properties?: { id: string; address: string }[];
    };
    if (!phrase || typeof phrase !== "string") {
      return new Response(JSON.stringify({ error: "phrase is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const propList = (properties ?? [])
      .slice(0, 40)
      .map((p) => `- ${p.id}: ${p.address}`)
      .join("\n");

    const SYSTEM = `You extract a single personal reminder from a user's message for a Texas
property-tax app. Today's date is ${today ?? "unknown"}.

Rules:
- "isReminder": true only if the user is clearly asking to be reminded / to save a date / to
  add a note for later. Otherwise false and leave the other fields empty.
- "remindOn": the reminder's date as YYYY-MM-DD. Resolve relative dates ("tomorrow", "next
  Friday", "in two weeks", "the 3rd") against today's date. If the message names no date and
  none can be inferred, set remindOn to null. NEVER guess a date.
- "note": a short imperative summary of what to be reminded about (e.g. "Email the Denton ARB
  about the hearing"). Strip the "remind me to" framing.
- "propertyId": if the message clearly refers to one of the user's properties below, its id;
  otherwise null. Match on street name / city, not loosely.

User's properties:
${propList || "(none on file)"}

Return ONLY JSON: {"isReminder":bool,"remindOn":"YYYY-MM-DD"|null,"note":string,"propertyId":string|null}`;

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: phrase }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
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
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    let parsed: {
      isReminder?: boolean;
      remindOn?: string | null;
      note?: string;
      propertyId?: string | null;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const remindOn =
      typeof parsed.remindOn === "string" && isoDate.test(parsed.remindOn) ? parsed.remindOn : null;
    const validPropertyIds = new Set((properties ?? []).map((p) => p.id));
    const propertyId =
      typeof parsed.propertyId === "string" && validPropertyIds.has(parsed.propertyId)
        ? parsed.propertyId
        : null;

    return new Response(
      JSON.stringify({
        isReminder: parsed.isReminder === true,
        remindOn,
        note: typeof parsed.note === "string" ? parsed.note.slice(0, 300) : "",
        propertyId,
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
