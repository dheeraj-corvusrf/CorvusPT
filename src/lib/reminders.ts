import { supabase } from "./supabase";
import { invokeEdgeFunction } from "./edge-functions";

// Personal reminders (public.user_reminders) — the user adds these directly
// or the Ask AI assistant parses one out of "remind me to …". They show on
// the Calendar page next to the real derived deadlines. Owner-scoped by RLS.

export type Reminder = {
  id: string;
  propertyId: string | null;
  remindOn: string; // YYYY-MM-DD
  note: string;
  done: boolean;
  source: "manual" | "assistant";
  createdAt: string;
};

type Row = {
  id: string;
  property_id: string | null;
  remind_on: string;
  note: string;
  done: boolean;
  source: string;
  created_at: string;
};

const fromRow = (r: Row): Reminder => ({
  id: r.id,
  propertyId: r.property_id,
  remindOn: r.remind_on,
  note: r.note,
  done: r.done,
  source: r.source === "assistant" ? "assistant" : "manual",
  createdAt: r.created_at,
});

export async function listReminders(userId: string): Promise<Reminder[]> {
  const { data, error } = await supabase
    .from("user_reminders")
    .select("id, property_id, remind_on, note, done, source, created_at")
    .eq("user_id", userId)
    .order("remind_on", { ascending: true });
  if (error || !data) return [];
  return (data as Row[]).map(fromRow);
}

export async function addReminder(
  userId: string,
  input: {
    remindOn: string;
    note: string;
    propertyId?: string | null;
    source?: "manual" | "assistant";
  },
): Promise<Reminder> {
  const { data, error } = await supabase
    .from("user_reminders")
    .insert({
      user_id: userId,
      property_id: input.propertyId ?? null,
      remind_on: input.remindOn,
      note: input.note.trim(),
      source: input.source ?? "manual",
    })
    .select("id, property_id, remind_on, note, done, source, created_at")
    .single();
  if (error) throw error;
  return fromRow(data as Row);
}

export async function setReminderDone(id: string, done: boolean): Promise<void> {
  const { error } = await supabase.from("user_reminders").update({ done }).eq("id", id);
  if (error) throw error;
}

export async function deleteReminder(id: string): Promise<void> {
  const { error } = await supabase.from("user_reminders").delete().eq("id", id);
  if (error) throw error;
}

// ── Natural-language parsing for the Ask AI assistant ────────────────────
// A cheap client-side gate so we only spend an AI call when the message
// actually looks like a reminder request.
export function looksLikeReminderRequest(text: string): boolean {
  return /\b(remind me|reminder|don'?t let me forget|save (the |this )?date|add (a )?(reminder|date)|note to self|schedule (a )?reminder|ping me|alert me)\b/i.test(
    text,
  );
}

export type ParsedReminder = {
  isReminder: boolean;
  remindOn: string | null; // YYYY-MM-DD
  note: string;
  propertyId: string | null;
};

// Resolves a phrase like "remind me to call the Denton ARB next Tuesday" into
// { remindOn, note, propertyId } via the extract-reminder edge function
// (Gemini, JSON mode, given today's date + the user's property list so it can
// resolve relative dates and match a named property). Never invents a date:
// remindOn is null when the phrase has no resolvable date, and the caller
// then asks the user for one instead of guessing.
export async function parseReminderRequest(
  phrase: string,
  properties: { id: string; address: string }[],
): Promise<ParsedReminder> {
  return invokeEdgeFunction<ParsedReminder>("extract-reminder", {
    phrase,
    today: new Date().toISOString().slice(0, 10),
    properties: properties.map((p) => ({ id: p.id, address: p.address })),
  });
}
