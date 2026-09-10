// Deploy via CLI: `supabase functions deploy refresh-property-base-data`
// (JWT-verified — only pg_cron, calling with the service-role key as Bearer
// auth, is meant to trigger this; same pattern as google-calendar-sync).
//
// Weekly: for every property that has AI-fetched base data and is still
// active (a live subscription or an open protest), re-run the CAD lookup,
// compare it to the stored snapshot, and — when a value/owner/legal/deed
// change is found — update the snapshot, note the change, and drop a
// source='system' user_reminders row so the owner is notified. The stored
// base-data PDF is regenerated client-side on their next AI Report open (or
// via its "Refresh" button); this job's responsibility is detect + notify.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const money = (n: number | null | undefined) =>
  n == null ? "not stated" : `$${Math.round(n).toLocaleString()}`;

type CadSnap = {
  ownerName: string | null;
  accountNumber: string | null;
  propertyType: string | null;
  landValue: number | null;
  improvementValue: number | null;
  totalValue: number | null;
  taxYear: number | null;
  legalDescription: string | null;
  subdivision: string | null;
  buildingSqft: number | null;
  yearBuilt: number | null;
  buildingClass: string | null;
  lotSizeSqft: number | null;
  lotSizeAcres: number | null;
  valueHistory: { year: number; total: number | null }[];
  deeds: { date: string | null; type: string | null; instrumentNum: string | null }[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trimCad(record: any): CadSnap | null {
  if (!record) return null;
  return {
    ownerName: record.ownerName ?? null,
    accountNumber: record.accountNumber ?? null,
    propertyType: record.propertyType ?? null,
    landValue: record.landValue ?? null,
    improvementValue: record.improvementValue ?? null,
    totalValue: record.totalValue ?? null,
    taxYear: record.taxYear ?? null,
    legalDescription: record.legalDescription ?? null,
    subdivision: record.subdivision ?? null,
    buildingSqft: record.buildingSqft ?? null,
    yearBuilt: record.yearBuilt ?? null,
    buildingClass: record.buildingClass ?? null,
    lotSizeSqft: record.lotSizeSqft ?? null,
    lotSizeAcres: record.lotSizeAcres ?? null,
    valueHistory: Array.isArray(record.valueHistory)
      ? record.valueHistory
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((h: any) => ({ year: h.year, total: h.appraisedValue ?? h.marketValue ?? null }))
          .sort((a: { year: number }, b: { year: number }) => a.year - b.year)
      : [],
    deeds: Array.isArray(record.deeds)
      ? record.deeds
          .slice(0, 8)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((d: any) => ({
            date: d.date ?? null,
            type: d.type ?? null,
            instrumentNum: d.instrumentNum ?? null,
          }))
      : [],
  };
}

function diffCad(a: CadSnap | null, b: CadSnap | null): string | null {
  if (!a || !b) return null;
  const notes: string[] = [];
  const vc = (label: string, x: number | null, y: number | null) => {
    if (x != null && y != null && Math.abs(x - y) > 1)
      notes.push(`${label} ${money(x)} → ${money(y)}`);
  };
  vc("total assessed value", a.totalValue, b.totalValue);
  vc("land value", a.landValue, b.landValue);
  vc("improvement value", a.improvementValue, b.improvementValue);
  if (a.taxYear != null && b.taxYear != null && a.taxYear !== b.taxYear)
    notes.push(`tax year ${a.taxYear} → ${b.taxYear}`);
  if (a.ownerName && b.ownerName && a.ownerName.trim() !== b.ownerName.trim())
    notes.push("owner of record changed");
  if (
    a.legalDescription &&
    b.legalDescription &&
    a.legalDescription.trim() !== b.legalDescription.trim()
  )
    notes.push("legal description changed");
  if (b.deeds.length > a.deeds.length)
    notes.push(`${b.deeds.length - a.deeds.length} new recorded deed/transfer`);
  if (
    a.buildingSqft != null &&
    b.buildingSqft != null &&
    Math.abs(a.buildingSqft - b.buildingSqft) > 1
  )
    notes.push(
      `CAD building area ${Math.round(a.buildingSqft).toLocaleString()} → ${Math.round(
        b.buildingSqft,
      ).toLocaleString()} SF`,
    );
  if (a.yearBuilt != null && b.yearBuilt != null && a.yearBuilt !== b.yearBuilt)
    notes.push(`CAD year built ${a.yearBuilt} → ${b.yearBuilt}`);
  return notes.length > 0 ? notes.join("; ") : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Base data rows + their property; only keep the ones still worth watching.
  const { data: rows, error } = await admin
    .from("property_base_data")
    .select(
      "property_id, user_id, snapshot, properties!inner(id, address, cad, account_number, subscription_status)",
    );
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  const { data: openProtests } = await admin
    .from("protests")
    .select("property_id, status")
    .neq("status", "resolved");
  const openProtestPropertyIds = new Set(
    (openProtests ?? []).map((p: { property_id: string }) => p.property_id),
  );

  const results: { propertyId: string; changed: boolean; note?: string }[] = [];

  for (const row of rows ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prop = (row as any).properties;
    const activeSub =
      typeof prop?.subscription_status === "string" &&
      ["active", "trialing", "past_due"].includes(prop.subscription_status);
    if (!activeSub && !openProtestPropertyIds.has(prop?.id)) continue;

    try {
      const body =
        prop.cad && prop.account_number
          ? { cad: prop.cad, accountNumber: prop.account_number }
          : { address: prop.address };
      const res = await fetch(`${supabaseUrl}/functions/v1/cad-lookup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        await admin
          .from("property_base_data")
          .update({ last_checked_at: new Date().toISOString() })
          .eq("property_id", row.property_id);
        continue;
      }
      const json = await res.json();
      const record = json?.record ?? (json?.matched === true ? json.record : null);
      const nextCad = trimCad(record);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prevCad = (row as any).snapshot?.cad ?? null;
      const note = diffCad(prevCad, nextCad);

      if (note && nextCad) {
        await admin
          .from("property_base_data")
          .update({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            snapshot: { ...(row as any).snapshot, cad: nextCad },
            last_change_note: note,
            last_checked_at: new Date().toISOString(),
          })
          .eq("property_id", row.property_id);

        const today = new Date().toISOString().slice(0, 10);
        const noteText = `Property base data updated for ${prop.address} — ${note}. Review your protest analysis.`;
        const { data: dup } = await admin
          .from("user_reminders")
          .select("id")
          .eq("property_id", row.property_id)
          .eq("source", "system")
          .eq("remind_on", today)
          .limit(1);
        if (!dup || dup.length === 0) {
          await admin.from("user_reminders").insert({
            user_id: row.user_id,
            property_id: row.property_id,
            remind_on: today,
            note: noteText,
            source: "system",
          });
        }
        results.push({ propertyId: row.property_id, changed: true, note });
      } else {
        await admin
          .from("property_base_data")
          .update({ last_checked_at: new Date().toISOString() })
          .eq("property_id", row.property_id);
        results.push({ propertyId: row.property_id, changed: false });
      }
    } catch (err) {
      results.push({
        propertyId: row.property_id,
        changed: false,
        note: err instanceof Error ? err.message : "error",
      });
    }
  }

  return new Response(
    JSON.stringify({ checked: results.length, changed: results.filter((r) => r.changed).length }),
    { status: 200, headers: corsHeaders },
  );
});
