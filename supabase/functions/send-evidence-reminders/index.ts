// Deploy via CLI: `supabase functions deploy send-evidence-reminders`
// (JWT-verified — only pg_cron, calling with the service-role key as Bearer
// auth, is meant to trigger this; same pattern as refresh-property-base-data
// / google-calendar-sync).
//
// Daily: for every "evidence" protest_form_submissions row that isn't yet
// confirmed with the county and hasn't opted out (reminder_frequency !=
// 'off'), sends one real email via Resend once it's actually due per that
// row's own frequency (daily/weekly) and last_reminder_sent_at — never more
// than once per real cadence, and never for a case that already confirmed
// or rejected/needs-more (filing_confirmed_at is null covers "not done";
// additional_requested/rejected still count as "not done" and keep getting
// reminded, which is correct — there's still real work outstanding).
//
// Requires the RESEND_API_KEY secret. Without it, this still runs on
// schedule and records a clear per-row failure — it never marks
// last_reminder_sent_at or claims success for a message it didn't actually
// send.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const MS_PER_DAY = 86_400_000;
// A minute of slack so a cron run that lands a little early/late each day
// doesn't skip a row that's genuinely due.
const DUE_AFTER_MS: Record<string, number> = {
  daily: MS_PER_DAY - 60_000,
  weekly: 7 * MS_PER_DAY - 60_000,
};

function isDue(frequency: string | null, lastSentAt: string | null): boolean {
  const freq = frequency ?? "daily";
  if (freq === "off") return false;
  if (!lastSentAt) return true;
  const elapsed = Date.now() - new Date(lastSentAt).getTime();
  return elapsed >= (DUE_AFTER_MS[freq] ?? DUE_AFTER_MS.daily);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: rows, error } = await admin
    .from("protest_form_submissions")
    .select(
      "id, protest_id, user_id, reminder_frequency, last_reminder_sent_at, protests!inner(property_id, properties!inner(address, protest_deadline))",
    )
    .eq("form_type", "evidence")
    .is("filing_confirmed_at", null)
    .neq("reminder_frequency", "off");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  let sent = 0;
  let skipped = 0;
  const failures: { protestId: string; message: string }[] = [];

  for (const row of rows ?? []) {
    if (!isDue(row.reminder_frequency, row.last_reminder_sent_at)) {
      skipped++;
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const protestRow = (row as any).protests;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const property = protestRow?.properties;
    const address: string = property?.address ?? "your property";
    const deadline: string | null = property?.protest_deadline ?? null;

    try {
      if (!resendKey) throw new Error("RESEND_API_KEY is not configured");

      const { data: userData, error: userErr } = await admin.auth.admin.getUserById(row.user_id);
      const to = userData?.user?.email;
      if (userErr || !to) throw new Error(userErr?.message ?? "No email on file for this user");

      const subject = `Reminder: submit your evidence for ${address}`;
      const text = `Your evidence for ${address} hasn't been marked submitted yet.${
        deadline ? ` Deadline: ${deadline}.` : ""
      } Open CorvusPT, go to View Case, and use Generate Evidence Package to finish.`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "CorvusPT <onboarding@resend.dev>",
          to: [to],
          subject,
          text,
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);

      await admin
        .from("protest_form_submissions")
        .update({ last_reminder_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      sent++;
    } catch (err) {
      failures.push({
        protestId: row.protest_id,
        message: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return new Response(JSON.stringify({ sent, skipped, failed: failures.length, failures }), {
    status: 200,
    headers: corsHeaders,
  });
});
