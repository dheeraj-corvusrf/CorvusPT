-- Run this once in the Supabase project's SQL Editor (Project > SQL Editor > New query).
-- Credentials themselves (email + hashed password) already live in Supabase's built-in
-- auth.users table — this file only adds the app-owned profile row alongside it.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

-- Safe to re-run: adds these columns if this file was already run before they existed.
alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles drop column if exists full_name;

-- Optional business/LLC name captured at signup, used once to search supported CAD
-- sources for properties already owned under that name (see cad-owner-search).
alter table public.profiles add column if not exists company_name text;

-- Opaque, unguessable token identifying this user's calendar in the public
-- calendar-feed edge function (see supabase/functions/calendar-feed) — the
-- webcal:// subscribe URL Google/Outlook/Apple Calendar re-fetch on their own
-- schedule has no session to authenticate with, so this token in the URL
-- itself IS the auth. Generated client-side (getOrCreateFeedToken in
-- src/lib/calendar-feed.ts) the first time the user opens "Sync with Google
-- Calendar" — not a privilege-escalation risk like plan/is_admin, so it's
-- fine to leave in the normal client-writable column grant below rather than
-- gating it through an edge function.
alter table public.profiles add column if not exists calendar_feed_token text;
create unique index if not exists profiles_calendar_feed_token_key
  on public.profiles (calendar_feed_token)
  where calendar_feed_token is not null;

alter table public.profiles enable row level security;

-- Real, continuous, per-user Google Calendar sync (OAuth, not the read-only
-- webcal subscribe link above) — see supabase/functions/google-calendar-*.
-- Server-side only — the refresh token here is as sensitive as a password
-- to the user's Google Calendar; no RLS policy grants any access to
-- anon/authenticated at all, so only the service-role client (every
-- google-calendar-* edge function) can ever read or write this table.
create table if not exists public.google_calendar_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  calendar_id text not null,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz
);
alter table public.google_calendar_connections enable row level security;

-- Short-lived, single-use CSRF state for the OAuth redirect round-trip —
-- google-calendar-start (authenticated) creates a row right before sending
-- the user to Google; google-calendar-oauth-callback (public, Google
-- redirects here with no session) looks it up to recover which CorvusPT
-- user this is, then deletes it. Same no-policy/service-role-only posture.
create table if not exists public.google_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  redirect_path text not null,
  created_at timestamptz not null default now()
);
alter table public.google_oauth_states enable row level security;

-- Each user may only read/update their own profile row. There is intentionally no
-- policy allowing select/update of other users' rows, and no delete/insert policy for
-- end users (the row is created only by the trigger below, running as the table owner).
drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- RLS policies gate which ROWS are visible/writable, not which COLUMNS — the policy
-- above alone would let any signed-in user set their OWN plan/is_admin/subscription_*
-- columns directly (e.g. `supabase.from("profiles").update({ plan: "owner_managed" })`
-- or `{ is_admin: true }`), bypassing Stripe and admin gating entirely. Column-level
-- grants close that regardless of RLS: only the fields a normal profile-edit form
-- actually needs (see src/lib/profile.ts's updateMyProfile) stay client-writable.
-- Everything else — plan, is_admin, subscription/billing fields — becomes writable
-- only by the service-role client, which is exactly what the Stripe webhook and the
-- admin-update-plan/admin-update-admin-status edge functions already use.
revoke update on public.profiles from authenticated;
grant update (first_name, last_name, phone, company_name, calendar_feed_token) on public.profiles to authenticated;

-- Auto-create a profile row whenever someone signs up via Supabase Auth. first_name,
-- last_name and phone are passed in from the sign-up form via supabase.auth.signUp's
-- options.data, which lands in raw_user_meta_data. 'wants_beta' (also passed through
-- options.data, from the sign-up form's beta checkbox) sets plan='beta' right here,
-- in this security-definer trigger — not via a client-side update, which the column
-- grants above no longer allow. Runs at row-creation regardless of whether email
-- confirmation is required, so both signup paths grant beta access correctly.
--
-- Also stamps a fresh referral_code on every new profile, and resolves
-- 'referral_code_used' (the code from ?ref=, passed through the same
-- options.data mechanism — see sign-in.tsx) into a real referred_by user id
-- HERE, server-side — the client only ever hands over the raw code string it
-- read from the URL, never a resolved user id, so a referral can't be
-- spoofed to point at an arbitrary account. A code that doesn't match any
-- real profile (typo'd, stale, tampered) just resolves to null — no error,
-- no blocked signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  referrer_id uuid;
begin
  select id into referrer_id from public.profiles
    where referral_code = upper(new.raw_user_meta_data ->> 'referral_code_used')
    limit 1;

  insert into public.profiles (id, email, first_name, last_name, phone, company_name, plan, referral_code, referred_by)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name',
    new.raw_user_meta_data ->> 'phone',
    new.raw_user_meta_data ->> 'company_name',
    case when new.raw_user_meta_data ->> 'wants_beta' = 'true' then 'beta' else 'free_ai_review' end,
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    referrer_id
  );
  -- Clears this address off the admin panel's "Invited Users" tab the moment
  -- a real account actually exists for it — security definer, so this runs
  -- regardless of the new user's own RLS grants (they have none on
  -- invited_users). Matches on email, not user id, since invited_users rows
  -- are created before any auth.users row exists.
  delete from public.invited_users where email = new.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Commercial properties a user has confirmed via the intake flow. One row per
-- property; users can have any number of them, added/deleted from the dashboard.
create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  address text not null,
  cad text,
  account_number text,
  owner_name text,
  property_type text,
  land_value numeric,
  improvement_value numeric,
  total_value numeric,
  tax_year integer,
  created_at timestamptz not null default now()
);

alter table public.properties enable row level security;

-- Users may see, add, remove, and update their own properties. Most fields are
-- re-derived from a fresh CAD lookup rather than hand-edited, but a few (paid_at,
-- estimated_savings/savings_basis) are legitimately written back onto an existing
-- row after creation — see "Users can update their own properties" below.
drop policy if exists "Users can view their own properties" on public.properties;
create policy "Users can view their own properties"
  on public.properties for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own properties" on public.properties;
create policy "Users can insert their own properties"
  on public.properties for insert
  with check (auth.uid() = user_id);

-- subscription_status is distinct from 'active' is the real, server-side half of
-- the "can't delete a paid property" gate (see handleDelete's own isPaid check in
-- _layout.properties.tsx) — without it, a user could call
-- supabase.from('properties').delete(...) directly and delete a property with a
-- real Stripe subscription still running and billing them, with nothing left in
-- the app to see or cancel it from. Beta properties never get a real subscription
-- (see startPropertyCheckout in billing.ts), so subscription_status is never
-- 'active' for them — this never blocks a beta user's own deletes.
drop policy if exists "Users can delete their own properties" on public.properties;
create policy "Users can delete their own properties"
  on public.properties for delete
  using (auth.uid() = user_id and subscription_status is distinct from 'active');

-- Was missing entirely until this was added, which meant markPropertyPaid()'s
-- update() call was silently rejected by RLS the whole time (no error surfaced —
-- .update() against a row RLS hides from you just updates zero rows).
drop policy if exists "Users can update their own properties" on public.properties;
create policy "Users can update their own properties"
  on public.properties for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- One real, independent Stripe subscription per PROPERTY (not one shared
-- subscription per customer with bracket quantities — see the now-legacy
-- profiles.qty_*/subscription_* columns further down, no longer written).
-- Never client-writable — see the column-level UPDATE grant below, which
-- deliberately omits all 6 of these; only stripe-webhook (service role,
-- bypasses RLS/grants entirely) ever sets them.
alter table public.properties add column if not exists stripe_subscription_id text;
alter table public.properties add column if not exists subscription_status text;
alter table public.properties add column if not exists plan_tier text;
alter table public.properties add column if not exists value_bracket text;
alter table public.properties add column if not exists cancel_at_period_end boolean not null default false;
alter table public.properties add column if not exists cancel_at timestamptz;

-- RLS above is row-level only — without this, the plain "Users can update
-- their own properties" policy would let a client set subscription_status
-- to 'active' directly from the browser console and grant themselves paid
-- access without ever paying. Column-level UPDATE grants are Postgres's own
-- mechanism for this (same pattern profiles.plan/referral_code already use
-- below) — every column a client legitimately writes via properties.ts is
-- listed here; the 6 subscription columns above are deliberately absent.
revoke update on public.properties from authenticated;
grant update (
  cad, address, account_number, owner_name, tax_year, protest_deadline,
  payment_due_date, tax_amount_due, paid_at, estimated_savings, savings_basis
) on public.properties to authenticated;

-- Admin panel support: a manual is_admin flag and a manual plan field (no real
-- billing — matches the 3 tiers in src/routes/pricing.tsx).
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists plan text not null default 'free_ai_review';

-- 'ai_report' and 'managed_protest' are the original flat-rate/contingency tiers,
-- kept in the allow-list for any pre-existing rows; 'owner_managed' and
-- 'corvusrf_managed' are the real per-property monthly tiers new checkouts write.
-- 'beta' is a free, full-access grant set only by handle_new_user() below when
-- someone signs up with the beta checkbox checked — never through Stripe.
alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles add constraint profiles_plan_check
  check (plan in ('free_ai_review', 'ai_report', 'managed_protest', 'owner_managed', 'corvusrf_managed', 'beta'));

-- LEGACY — described the one shared subscription's line-item quantity from
-- before every property got its own independent subscription (see
-- properties.stripe_subscription_id/subscription_status further up).
-- No longer written by stripe-webhook; left in place, unused.
alter table public.profiles add column if not exists subscription_quantity integer not null default 1;

-- security definer bypasses RLS internally, so it can safely be referenced from RLS
-- policies on public.profiles itself without recursively re-evaluating those policies
-- (same convention as handle_new_user() above).
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Additive: Postgres OR's multiple permissive policies together, so these grant
-- admins access in addition to the existing owner-only policies above, not instead.
drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select
  using (public.is_admin());

drop policy if exists "Admins can update all profiles" on public.profiles;
create policy "Admins can update all profiles"
  on public.profiles for update
  using (public.is_admin());

drop policy if exists "Admins can view all properties" on public.properties;
create policy "Admins can view all properties"
  on public.properties for select
  using (public.is_admin());

drop policy if exists "Admins can insert properties for any user" on public.properties;
create policy "Admins can insert properties for any user"
  on public.properties for insert
  with check (public.is_admin());

drop policy if exists "Admins can delete any property" on public.properties;
create policy "Admins can delete any property"
  on public.properties for delete
  using (public.is_admin());

-- Records who on staff did what in the admin panel (plan changes, admin-access
-- grants, user creation/deletion, protest status/notes edits) and when — none of
-- that was logged anywhere before. actor_id/target_user_id are nullable (set null
-- on delete) so a row stays readable after the account it refers to is gone;
-- actor_email/target_email are denormalized snapshots for the same reason. No
-- jsonb (this schema has none) — detail is a short free-form description, matching
-- how much structure every other "what happened" field here carries.
create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users (id) on delete set null,
  actor_email text not null,
  action text not null,
  target_user_id uuid references auth.users (id) on delete set null,
  target_email text,
  detail text,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;

drop policy if exists "Admins can view the audit log" on public.admin_audit_log;
create policy "Admins can view the audit log"
  on public.admin_audit_log for select
  using (public.is_admin());

-- actor_id = auth.uid() (on top of is_admin()) so an admin can only ever log
-- themselves as the actor, never write an entry attributing an action to a
-- different admin.
drop policy if exists "Admins can log their own actions" on public.admin_audit_log;
create policy "Admins can log their own actions"
  on public.admin_audit_log for insert
  with check (public.is_admin() and actor_id = auth.uid());

-- One row per address someone's been sent a sign-up link for (see
-- send-signup-invite/index.ts) — this is the ONLY record of an invite until
-- the person actually signs up, since no account exists yet at invite time.
-- handle_new_user() (above) deletes the matching row the moment a real
-- signup happens, so this table only ever holds genuinely still-pending
-- invites, not a permanent history. email is the natural key: re-inviting
-- the same address updates last_sent_at/resend_count on the existing row
-- instead of creating a duplicate.
create table if not exists public.invited_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  last_name text,
  wants_beta boolean not null default false,
  invited_by uuid references auth.users (id) on delete set null,
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  resend_count integer not null default 0
);

alter table public.invited_users enable row level security;

-- Written only by send-signup-invite (service-role, bypasses RLS) — this
-- policy is read-only, for the admin panel's "Invited Users" tab to list
-- them directly from the client, same pattern as admin_audit_log's
-- select-only policy above.
drop policy if exists "Admins can view invited users" on public.invited_users;
create policy "Admins can view invited users"
  on public.invited_users for select
  using (public.is_admin());

-- Same additive is_admin() pattern as beta_leads' own delete policy — lets
-- staff clear out an invite (they no longer want it pending, wrong address,
-- etc.) straight from the client, no edge function needed since this never
-- touches auth.users.
drop policy if exists "Admins can delete invited users" on public.invited_users;
create policy "Admins can delete invited users"
  on public.invited_users for delete
  using (public.is_admin());

-- Stripe billing: the webhook (supabase/functions/stripe-webhook) writes plan and
-- these two ids; the admin panel's manual plan dropdown still works unchanged since
-- it edits the same `plan` column.
--
-- stripe_customer_id is still real and actively written — one Stripe
-- Customer per user, same as before, just now with potentially many
-- subscriptions under it (one per property) instead of one shared
-- subscription. stripe_subscription_id/subscription_status/
-- cancel_at_period_end/cancel_at below it are LEGACY: they described that
-- one shared subscription and are no longer written by stripe-webhook —
-- the equivalent, real, per-property versions now live on public.properties
-- itself (see its own stripe_subscription_id/subscription_status/
-- cancel_at_period_end/cancel_at further up). Left in place rather than
-- dropped since no migration was needed (no real customers predate this),
-- but nothing reads or writes them going forward.
alter table public.profiles add column if not exists stripe_customer_id text;
alter table public.profiles add column if not exists stripe_subscription_id text;
alter table public.profiles add column if not exists subscription_status text;
alter table public.profiles add column if not exists cancel_at_period_end boolean not null default false;
alter table public.profiles add column if not exists cancel_at timestamptz;

-- Protest deadline extracted from an uploaded notice, persisted so the dashboard's
-- Notifications tab can compute real "N days left" alerts instead of inventing them.
alter table public.properties add column if not exists protest_deadline date;

-- Tax bill data extracted from an uploaded "Tax Bill / Statement" document, persisted
-- so the dashboard's Payments tab can show real due dates and amounts. paid_at is set
-- by the user clicking "Mark as Paid" — CorvusRF has no live payment integration, so
-- payment status is a user-reported fact, not something the app can verify itself.
alter table public.properties add column if not exists payment_due_date date;
alter table public.properties add column if not exists tax_amount_due numeric;
alter table public.properties add column if not exists paid_at timestamptz;

-- Real per-property savings estimate (see src/lib/savings-estimate.ts) — "comps"
-- (real comparable-property data, distance- and value-filtered) or "formula"
-- (a deterministic reduction % from real per-county/per-category 2025 Texas
-- protest-outcome data, used when no qualifying comp exists — no AI call, so
-- the same property always produces the same number). "ai" and "baseline" are
-- legacy values from before the estimate was made fully deterministic — still
-- valid to read on old rows, nothing writes them anymore. Persisted so the
-- dashboard shows the same number the user saw during intake instead of
-- losing it once the property is saved; backfilled for properties added
-- before this column existed via the properties dashboard page.
alter table public.properties add column if not exists estimated_savings numeric;
alter table public.properties add column if not exists savings_basis text;
alter table public.properties drop constraint if exists properties_savings_basis_check;
alter table public.properties add constraint properties_savings_basis_check check (savings_basis in ('comps', 'formula', 'ai', 'baseline'));

-- Real CAD-sourced year-over-year value history (land/improvement/market/appraised
-- per year — see src/lib/cad-lookup.ts's CadValueHistoryEntry), one JSON-stringified
-- entry per array element (this schema has no jsonb columns; text[] matches the
-- existing property_ai_scores.factors precedent for "a handful of structured values
-- on one row"). Previously only ever lived in session storage during intake and was
-- lost the moment the user left that screen — persisted so it survives to be shown
-- again later, and so estimateSavings()'s value-trend adjustment (texas-tax-rates.ts)
-- still has data to work with on a return visit, not just the first one.
alter table public.properties add column if not exists value_history text[];

-- Business Personal Property tax accounts — a distinct entity from real property
-- (public.properties): a business can render BPP for a location without owning the
-- real estate it sits in, so this isn't just a property with a type filter.
create table if not exists public.bpp_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_name text not null,
  account_number text,
  cad text,
  location_address text,
  created_at timestamptz not null default now()
);

alter table public.bpp_accounts enable row level security;

drop policy if exists "Users can view their own BPP accounts" on public.bpp_accounts;
create policy "Users can view their own BPP accounts"
  on public.bpp_accounts for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own BPP accounts" on public.bpp_accounts;
create policy "Users can insert their own BPP accounts"
  on public.bpp_accounts for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own BPP accounts" on public.bpp_accounts;
create policy "Users can delete their own BPP accounts"
  on public.bpp_accounts for delete
  using (auth.uid() = user_id);

-- Real, staff-actioned protest requests — created when a user clicks "Request Protest
-- Filing" on a property. Status starts at 'requested' and is only ever advanced by an
-- admin (mirrors the manual is_admin()-gated pattern already used for profiles.plan),
-- since actual filing/hearing representation happens off-platform by CorvusRF staff.
create table if not exists public.protests (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'requested',
  notes text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- status check constraint is defined further below, once, after the full set of
-- possible values (added for case-progress tracking) is established.

alter table public.protests enable row level security;

drop policy if exists "Users can view their own protests" on public.protests;
create policy "Users can view their own protests"
  on public.protests for select
  using (auth.uid() = user_id);

-- Real, server-side half of the protest-payment gate. Every "isPaid"/
-- "hasFullAccess" check in the app (ProtestAuthorizationFlow, ai-report.tsx,
-- _layout.properties.tsx, JourneyTracker.tsx, BulkProtestAuthorizationFlow)
-- is client-side UX only — without this, a signed-in user could call
-- supabase.from('protests').insert(...) directly (e.g. from devtools) and
-- file a protest for a property with no active subscription, bypassing
-- every one of those UI gates at once. security definer bypasses RLS
-- internally so it can safely be referenced from protests' own INSERT
-- policy without recursively re-evaluating RLS on properties/profiles (same
-- convention as is_admin() above). Mirrors the app's own beta-bypasses-
-- unconditionally / everyone-else-reads-their-property's-real-
-- subscription_status convention.
create or replace function public.property_is_paid(p_property_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.properties p
    where p.id = p_property_id
      and p.user_id = auth.uid()
      and (
        p.subscription_status = 'active'
        or (select plan from public.profiles where id = auth.uid()) = 'beta'
      )
  );
$$;

drop policy if exists "Users can request their own protests" on public.protests;
create policy "Users can request their own protests"
  on public.protests for insert
  with check (auth.uid() = user_id and public.property_is_paid(property_id));

drop policy if exists "Admins can view all protests" on public.protests;
create policy "Admins can view all protests"
  on public.protests for select
  using (public.is_admin());

drop policy if exists "Admins can update all protests" on public.protests;
create policy "Admins can update all protests"
  on public.protests for update
  using (public.is_admin());

-- AI-generated case prep (see src/lib/protest-case.ts), written by the user's own
-- client right after they request a protest — not a verified filing outcome, same
-- self-reported precedent as tax_bills.paid_at/refund_amount. RLS is row-scoped by
-- user_id like every other table here; it can't distinguish "only these columns,"
-- so this does technically let a user edit their own status/notes too, same as they
-- always could edit their own tax_bills payment fields.
alter table public.protests add column if not exists strategy_recommendation text;
alter table public.protests add column if not exists strategy_confidence_pct integer;
alter table public.protests add column if not exists strategy_rationale text;
alter table public.protests add column if not exists case_prep_generated_at timestamptz;

drop policy if exists "Users can update their own protests" on public.protests;
create policy "Users can update their own protests"
  on public.protests for update
  using (auth.uid() = user_id);

-- Case progress through settlement/hearing/decision/escalation (see
-- src/lib/protest-case.ts) — same self-reported precedent as everything else on
-- this table; there's no live county API, so someone has to enter what actually
-- happened. original_value is a snapshot taken at request time (not read live off
-- properties.total_value), since that can change in later years and the case needs
-- to remember what it actually started from.
alter table public.protests add column if not exists original_value numeric;
alter table public.protests add column if not exists settlement_offer_value numeric;
alter table public.protests add column if not exists settlement_offer_received_at date;
alter table public.protests add column if not exists hearing_date date;
-- Real detail extracted from the actual hearing notice the county mailed
-- (see hearing_notices below and extract-hearing-notice edge function) —
-- kept as their own columns on protests, not just in hearing_notices, since
-- they're what the calendar-event builders (tax-calendar.ts and its two
-- server-side mirrors) read to put the real time/location/mode in the
-- event itself, the same way they already read hearing_date. Nullable:
-- a manually-typed hearing date (no notice uploaded) never has these.
alter table public.protests add column if not exists hearing_time text;
alter table public.protests add column if not exists hearing_location text;
alter table public.protests add column if not exists hearing_mode text;
alter table public.protests drop constraint if exists protests_hearing_mode_check;
alter table public.protests add constraint protests_hearing_mode_check
  check (hearing_mode is null or hearing_mode in ('In Person', 'Phone', 'Videoconference', 'Affidavit', 'Unknown'));
alter table public.protests add column if not exists arb_decision text;
alter table public.protests add column if not exists arb_decision_date date;
alter table public.protests add column if not exists final_value numeric;
alter table public.protests add column if not exists escalation_path text;
alter table public.protests add column if not exists closed_at timestamptz;

-- Informal review sub-tracker — a finer-grained state than the main
-- `status` column above, which has no room for "requested but no county
-- response yet" / "scheduled" as distinct pre-offer states. Deliberately a
-- SEPARATE column, not a new `status` value: informal review is optional
-- and county-specific (see county_protest_info.ts's own informalReview
-- field), and once a real settlement offer actually arrives, THAT already
-- has its own real tracking (settlement_offer_value/status='offer_received'/
-- acceptSettlement()) — this column exists for the states BEFORE that,
-- plus a couple of terminal ones ('rejected'/'no_informal_available') that
-- have no other real signal on this table. Not exposed to the user as its
-- own confusing 8-value picker verbatim — see INFORMAL_STATUS_LABEL in
-- src/lib/protests.ts for the real, shorter user-facing label set.
alter table public.protests add column if not exists informal_status text not null default 'not_requested';
alter table public.protests drop constraint if exists protests_informal_status_check;
alter table public.protests add constraint protests_informal_status_check
  check (informal_status in ('not_requested', 'requested', 'pending_response', 'scheduled',
    'proposed_value_received', 'accepted', 'rejected', 'no_informal_available'));

-- The real, self-reported date once the county and owner have agreed on
-- one (this app has no live scheduling API for any county) — feeds the
-- calendar builders the same way hearing_date already does, once
-- informal_status = 'scheduled'.
alter table public.protests add column if not exists informal_review_date date;

-- AI's own read of which appraiser specialty this property's informal
-- review would route to (see informal-review-guidance edge function) —
-- internal/supporting detail only, used to address a drafted email
-- correctly; deliberately NOT surfaced as its own prominent UI field
-- (per product direction: "do not expose complicated appraiser routing to
-- the user unless it is useful to completing the process").
alter table public.protests add column if not exists informal_appraiser_category text;
alter table public.protests drop constraint if exists protests_informal_appraiser_category_check;
alter table public.protests add constraint protests_informal_appraiser_category_check
  check (informal_appraiser_category is null or informal_appraiser_category in (
    'Land Appraiser', 'Improvement Appraiser', 'Commercial Appraiser', 'Retail Appraiser',
    'Office Appraiser', 'Daycare/School Appraiser', 'Other'
  ));

-- Which tax year this filing covers — lets a property have one protest row per
-- year instead of one ever, so a resolved prior-year case doesn't block filing
-- again for a new year (see src/routes/dashboard/_layout.properties.tsx's
-- "Re-file for {year}" flow). Nullable/unbackfilled on purpose: every lookup of
-- "the" protest for a property already resolves to the most recent row (ordered
-- by requested_at desc), so older rows without a year don't need one.
alter table public.protests add column if not exists tax_year integer;

-- Corvus "AI Guidance & Filing Notice" — one-time consent that gates entry into
-- a not-yet-filed case (see CorvusGuidanceGate in CaseDetailModal.tsx). Null
-- until acknowledged, never reset once set. Only ever checked while
-- status = 'requested' — a case that already advanced past filing never needs
-- to show this again, even on old rows that predate this column, so no
-- backfill is required.
alter table public.protests add column if not exists corvus_guidance_ack_at timestamptz;

-- No delete UI exists for protests today — this exists so the authenticated E2E
-- suite (e2e/authenticated/protest-authorization.spec.ts, run in CI on every push
-- to dev) can clean up the real protest row it creates each run, instead of
-- leaving CI-seeded rows piling up in the real admin queue staff work from.
drop policy if exists "Users can delete their own protests" on public.protests;
create policy "Users can delete their own protests"
  on public.protests for delete
  using (auth.uid() = user_id);

alter table public.protests drop constraint if exists protests_arb_decision_check;
alter table public.protests add constraint protests_arb_decision_check
  check (arb_decision is null or arb_decision in ('approved', 'partial', 'denied'));

alter table public.protests drop constraint if exists protests_escalation_path_check;
alter table public.protests add constraint protests_escalation_path_check
  check (escalation_path is null or escalation_path in ('accept', 'appeal', 'arbitration'));

alter table public.protests drop constraint if exists protests_status_check;
alter table public.protests add constraint protests_status_check
  check (status in ('requested', 'filed', 'under_review', 'offer_received',
    'hearing_scheduled', 'decision_received', 'appealing', 'arbitrating', 'resolved'));

-- No two DIFFERENT users may have an active protest on file for the same
-- real property (same CAD + account number) in the same tax year — real
-- appraisal districts don't accept a second, unrelated party's protest on
-- top of one already filed, and RLS alone can't catch this (each user's
-- own properties/protests are invisible to every other user's queries by
-- design). Runs as security definer specifically so it CAN see across
-- every user's rows for this one check, unlike a normal RLS-scoped query.
-- Never blocks on unverifiable data: a property with no real cad/account
-- number on file yet, or a protest with no tax_year set, is skipped
-- entirely rather than guessed at — same "never fabricate/never
-- overreach" discipline the CAD-matching code follows. A resolved protest
-- (status = 'resolved') never blocks a new one — that property is no
-- longer under active protest by anyone. The SAME user re-requesting for
-- their own already-active protest is a different, separate concern (not
-- this check's job — user_id <> new.user_id excludes it here).
create or replace function public.prevent_duplicate_active_protest()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  new_cad text;
  new_account text;
  conflict_id uuid;
begin
  select cad, account_number into new_cad, new_account
  from public.properties where id = new.property_id;

  if new_cad is null or new_account is null or new.tax_year is null then
    return new;
  end if;

  select p.id into conflict_id
  from public.protests p
  join public.properties pr on pr.id = p.property_id
  where pr.cad = new_cad
    and pr.account_number = new_account
    and p.tax_year = new.tax_year
    and p.status <> 'resolved'
    and p.user_id <> new.user_id
  limit 1;

  if conflict_id is not null then
    raise exception 'A protest for this property and tax year is already on file from another account.';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_duplicate_active_protest_trigger on public.protests;
create trigger prevent_duplicate_active_protest_trigger
  before insert on public.protests
  for each row execute function public.prevent_duplicate_active_protest();

-- Real, AI-extracted content from an actual hearing notice (or other county
-- notice) the user uploads once their case is filed — see
-- extract-hearing-notice edge function and src/lib/hearing-notice.ts. One
-- row per uploaded notice (a case can receive more than one real notice
-- over its life — an initial one, then a rescheduled one); the most recent
-- row for a protest is what the UI shows. required_documents/discrepancies
-- are JSON-stringified arrays, same text-column-not-jsonb convention as
-- field_values on protest_form_submissions above (this schema has no jsonb
-- columns at all). informal_review_available is the AI's own read of
-- whether an informal review is available, grounded in both the notice's
-- own text and county_protest_info.ts's real per-county data (passed into
-- the prompt as context, not looked up again server-side) — 'unclear' is
-- the honest answer when neither source actually says.
create table if not exists public.hearing_notices (
  id uuid primary key default gen_random_uuid(),
  protest_id uuid not null references public.protests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  hearing_date text,
  hearing_time text,
  hearing_location text,
  hearing_mode text,
  evidence_submission_deadline text,
  hearing_type text,
  extracted_account_number text,
  extracted_tax_year text,
  extracted_property_address text,
  county_contact text,
  appraiser_contact text,
  submission_instructions text,
  required_documents text,
  appeal_deadline text,
  discrepancies text,
  informal_review_available text,
  informal_review_notes text,
  created_at timestamptz not null default now()
);

alter table public.hearing_notices enable row level security;

drop policy if exists "Users can view their own hearing notices" on public.hearing_notices;
create policy "Users can view their own hearing notices"
  on public.hearing_notices for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own hearing notices" on public.hearing_notices;
create policy "Users can insert their own hearing notices"
  on public.hearing_notices for insert
  with check (auth.uid() = user_id);

drop policy if exists "Admins can view all hearing notices" on public.hearing_notices;
create policy "Admins can view all hearing notices"
  on public.hearing_notices for select
  using (public.is_admin());

-- Trackable evidence checklist for a protest case — one row per AI-suggested
-- evidence item, optionally linked to an uploaded document once the user provides
-- it. Generated from the same "evidence" AI module the paywalled AI Report page
-- already uses (src/lib/ai-report-modules.ts), just persisted against the real
-- case instead of only rendering once in a report view.
create table if not exists public.protest_evidence_items (
  id uuid primary key default gen_random_uuid(),
  protest_id uuid not null references public.protests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  -- Legacy — a checklist item now links to zero or more documents via
  -- documents.evidence_item_id instead (see below), which supports more than one
  -- file per item. Left in place (with a one-time backfill) so already-uploaded
  -- evidence isn't lost, but no longer written to by new uploads.
  document_id uuid references public.documents (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.protest_evidence_items enable row level security;

drop policy if exists "Users can view their own evidence items" on public.protest_evidence_items;
create policy "Users can view their own evidence items"
  on public.protest_evidence_items for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own evidence items" on public.protest_evidence_items;
create policy "Users can insert their own evidence items"
  on public.protest_evidence_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own evidence items" on public.protest_evidence_items;
create policy "Users can update their own evidence items"
  on public.protest_evidence_items for update
  using (auth.uid() = user_id);

drop policy if exists "Admins can view all evidence items" on public.protest_evidence_items;
create policy "Admins can view all evidence items"
  on public.protest_evidence_items for select
  using (public.is_admin());

-- Lets staff run generateCasePrep()/linkEvidenceDocument() (src/lib/protest-case.ts)
-- on a customer's behalf from the admin panel — inserted/updated rows still carry
-- the CUSTOMER's own user_id (passed explicitly by the client, not auth.uid()), so
-- the customer's own "Users can ..." policies above keep working for them too.
drop policy if exists "Admins can insert evidence items" on public.protest_evidence_items;
create policy "Admins can insert evidence items"
  on public.protest_evidence_items for insert
  with check (public.is_admin());

drop policy if exists "Admins can update all evidence items" on public.protest_evidence_items;
create policy "Admins can update all evidence items"
  on public.protest_evidence_items for update
  using (public.is_admin());

-- Original uploaded documents (appraisal notices, tax bills, etc.), persisted per
-- property so the dashboard's Documents tab lists real files instead of only the
-- AI-extracted field values. The file itself lives in the "documents" Storage bucket
-- below; this table is the per-user, per-property index over it.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  document_type text,
  uploaded_at timestamptz not null default now()
);

alter table public.documents enable row level security;

drop policy if exists "Users can view their own documents" on public.documents;
create policy "Users can view their own documents"
  on public.documents for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own documents" on public.documents;
create policy "Users can insert their own documents"
  on public.documents for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own documents" on public.documents;
create policy "Users can delete their own documents"
  on public.documents for delete
  using (auth.uid() = user_id);

-- Needed so linkEvidenceDocument() (src/lib/protest-case.ts) can set
-- evidence_item_id after upload — RLS only gates which rows are visible, not which
-- columns are writable, so the column grant below (same pattern as profiles' own
-- lockdown above) keeps this to exactly the one field a user should ever change on
-- an existing document row.
drop policy if exists "Users can update their own documents" on public.documents;
create policy "Users can update their own documents"
  on public.documents for update
  using (auth.uid() = user_id);
revoke update on public.documents from authenticated;
grant update (evidence_item_id) on public.documents to authenticated;

drop policy if exists "Admins can view all documents" on public.documents;
create policy "Admins can view all documents"
  on public.documents for select
  using (public.is_admin());

-- Lets staff index an uploaded file (src/lib/documents.ts's uploadDocument()) on a
-- customer's behalf — same "row still carries the customer's own user_id" pattern
-- as the evidence-items admin policies above.
drop policy if exists "Admins can insert documents" on public.documents;
create policy "Admins can insert documents"
  on public.documents for insert
  with check (public.is_admin());

-- Lets staff link evidence on a customer's behalf from the admin panel's copy of
-- CasePlanSection — the "Users can update ..." policy above only matches a
-- document's own owner, not staff acting on someone else's row. Covered by the
-- same evidence_item_id-only column grant above (grants are per-role, not
-- per-policy).
drop policy if exists "Admins can update all documents" on public.documents;
create policy "Admins can update all documents"
  on public.documents for update
  using (public.is_admin());

-- Links a document to the specific evidence-checklist item it satisfies. Nullable
-- and one-directional (document -> item) rather than the old single document_id
-- column on protest_evidence_items, so one checklist item — e.g. "Property Income
-- and Expense Statements (3 Years)" — can hold several uploaded files instead of
-- just one. See CaseDetailModal.tsx's evidence checklist.
alter table public.documents add column if not exists evidence_item_id uuid
  references public.protest_evidence_items (id) on delete set null;

-- Backfill: earlier uploads used protest_evidence_items.document_id (now legacy —
-- superseded by evidence_item_id above) to link a single file. Idempotent, so it's
-- safe to re-run: only touches documents not already linked.
update public.documents d
set evidence_item_id = pei.id
from public.protest_evidence_items pei
where pei.document_id = d.id and d.evidence_item_id is null;

-- Private bucket: objects are stored at "{user_id}/{property_id}/{filename}" so the
-- storage.objects policies below can scope access by the first path segment alone.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "Users can upload their own documents" on storage.objects;
create policy "Users can upload their own documents"
  on storage.objects for insert
  with check (
    bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No path restriction (unlike the user policy above) — staff need to write into the
-- CUSTOMER's own folder, not their own, so the customer can still read it back via
-- their own "Users can view their own documents" policy below.
drop policy if exists "Admins can upload any documents" on storage.objects;
create policy "Admins can upload any documents"
  on storage.objects for insert
  with check (bucket_id = 'documents' and public.is_admin());

drop policy if exists "Users can view their own documents" on storage.objects;
create policy "Users can view their own documents"
  on storage.objects for select
  using (
    bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own documents" on storage.objects;
create policy "Users can delete their own documents"
  on storage.objects for delete
  using (
    bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- One row per (protest, form) — holds both in-progress edits (Save Progress,
-- no signature) and the final signed record (Sign & Submit) for the three
-- real Comptroller forms (Notice of Protest / Appointment of Agent /
-- Property Owner's Affidavit of Evidence, see protest-documents.ts).
-- field_values is the whole (dynamic, ~30-40-key)
-- FieldValues map, JSON-stringified into a plain text column rather than a
-- jsonb column — this schema has none (see value_history's text[] precedent
-- above) — since the field set is open-ended and doesn't fit fixed columns.
create table if not exists public.protest_form_submissions (
  id uuid primary key default gen_random_uuid(),
  protest_id uuid not null references public.protests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  form_type text not null check (
    form_type in ('notice_of_protest', 'appointment_of_agent', 'evidence_declaration')
  ),
  field_values text not null,
  signature_type text,
  signature_data text,
  signed_at timestamptz,
  document_id uuid references public.documents (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (protest_id, form_type)
);

alter table public.protest_form_submissions enable row level security;

drop policy if exists "Users can view their own form submissions" on public.protest_form_submissions;
create policy "Users can view their own form submissions"
  on public.protest_form_submissions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own form submissions" on public.protest_form_submissions;
create policy "Users can insert their own form submissions"
  on public.protest_form_submissions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own form submissions" on public.protest_form_submissions;
create policy "Users can update their own form submissions"
  on public.protest_form_submissions for update
  using (auth.uid() = user_id);

drop policy if exists "Admins can view all form submissions" on public.protest_form_submissions;
create policy "Admins can view all form submissions"
  on public.protest_form_submissions for select
  using (public.is_admin());

-- Lets staff use Save Progress (and Download's silent save) on a customer's
-- behalf from the admin panel — signing itself stays customer-only, enforced
-- client-side (AdminCaseProgressModal passes allowSigning={false}), not by
-- these policies; rows still carry the customer's own user_id either way.
drop policy if exists "Admins can insert form submissions" on public.protest_form_submissions;
create policy "Admins can insert form submissions"
  on public.protest_form_submissions for insert
  with check (public.is_admin());

drop policy if exists "Admins can update all form submissions" on public.protest_form_submissions;
create policy "Admins can update all form submissions"
  on public.protest_form_submissions for update
  using (public.is_admin());

-- AI-computed "protest opportunity" score, generated once in the background right
-- after a property is added (see src/lib/property-scores.ts) so the dashboard can
-- show it without the user ever opening the on-demand AI Report page. Write-once,
-- like properties itself — no update/delete policy.
create table if not exists public.property_ai_scores (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  score integer not null,
  summary text not null,
  factors text[] not null default '{}',
  computed_at timestamptz not null default now()
);

alter table public.property_ai_scores enable row level security;

drop policy if exists "Users can view their own property AI scores" on public.property_ai_scores;
create policy "Users can view their own property AI scores"
  on public.property_ai_scores for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own property AI scores" on public.property_ai_scores;
create policy "Users can insert their own property AI scores"
  on public.property_ai_scores for insert
  with check (auth.uid() = user_id);

drop policy if exists "Admins can view all property AI scores" on public.property_ai_scores;
create policy "Admins can view all property AI scores"
  on public.property_ai_scores for select
  using (public.is_admin());

-- Records a user's signed authorization to let CorvusRF act as their tax agent for
-- a given protest (the "CorvusRF Managed" workspace path) — owner/entity details plus
-- a captured signature (drawn PNG data URL or typed text), collected via
-- ProtestAuthorizationFlow.tsx from the dashboard's "Request Protest Filing" action.
create table if not exists public.protest_authorizations (
  id uuid primary key default gen_random_uuid(),
  protest_id uuid references public.protests (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text not null,
  is_entity boolean not null default false,
  entity_name text,
  entity_relationship text,
  entity_type text,
  purchased_recently boolean,
  signature_type text not null check (signature_type in ('draw', 'type')),
  signature_data text not null,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.protest_authorizations enable row level security;

drop policy if exists "Users can view their own protest authorizations" on public.protest_authorizations;
create policy "Users can view their own protest authorizations"
  on public.protest_authorizations for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own protest authorizations" on public.protest_authorizations;
create policy "Users can insert their own protest authorizations"
  on public.protest_authorizations for insert
  with check (auth.uid() = user_id);

drop policy if exists "Admins can view all protest authorizations" on public.protest_authorizations;
create policy "Admins can view all protest authorizations"
  on public.protest_authorizations for select
  using (public.is_admin());

-- Per-tax-year bill/payment/refund history for a property — closes the loop on the
-- savings estimate shown at intake, which otherwise never gets compared against what
-- the county actually billed. `properties.tax_amount_due`/`payment_due_date`/`paid_at`
-- stay as the "latest bill" snapshot the Deadlines page and dashboard home already
-- read; this table is the real history behind them and is kept in sync on write
-- rather than replacing those columns (see src/lib/tax-bills.ts).
create table if not exists public.tax_bills (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  tax_year integer,
  taxable_value numeric,
  tax_rate numeric,
  amount_due numeric,
  due_date date,
  penalty_date date,
  source_document_id uuid references public.documents (id) on delete set null,
  amount_paid numeric,
  paid_at timestamptz,
  payment_confirmation text,
  refund_amount numeric,
  refund_expected_at date,
  refund_received_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.tax_bills enable row level security;

drop policy if exists "Users can view their own tax bills" on public.tax_bills;
create policy "Users can view their own tax bills"
  on public.tax_bills for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own tax bills" on public.tax_bills;
create policy "Users can insert their own tax bills"
  on public.tax_bills for insert
  with check (auth.uid() = user_id);

-- Unlike properties/documents, tax bills are updated in place (mark paid, record a
-- refund) rather than only ever inserted, so — unusually for this schema — this table
-- needs an update policy.
drop policy if exists "Users can update their own tax bills" on public.tax_bills;
create policy "Users can update their own tax bills"
  on public.tax_bills for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own tax bills" on public.tax_bills;
create policy "Users can delete their own tax bills"
  on public.tax_bills for delete
  using (auth.uid() = user_id);

drop policy if exists "Admins can view all tax bills" on public.tax_bills;
create policy "Admins can view all tax bills"
  on public.tax_bills for select
  using (public.is_admin());

-- LEGACY, same reason as subscription_quantity above — each property's own
-- real value_bracket (public.properties) replaced this per-account
-- breakdown once every property got its own subscription. Left in place,
-- unused, no longer written by stripe-webhook.
alter table public.profiles add column if not exists qty_under_2m integer not null default 0;
alter table public.profiles add column if not exists qty_2m_10m integer not null default 0;
alter table public.profiles add column if not exists qty_over_10m integer not null default 0;

-- "Add Ownerships" — an LLC/ownership name the user has searched and added
-- properties from (see src/components/AddOwnershipsModal.tsx and
-- cad-owner-search, which already searches by owner name across every county
-- that publishes one). Written once when properties are actually saved from a
-- search, not on every search itself — same "insert once, never edit in
-- place" shape as properties, so no update policy either.
create table if not exists public.ownerships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  role text not null check (role in ('owner', 'agent', 'property_manager')),
  created_at timestamptz not null default now()
);

alter table public.ownerships enable row level security;

drop policy if exists "Users can view their own ownerships" on public.ownerships;
create policy "Users can view their own ownerships"
  on public.ownerships for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own ownerships" on public.ownerships;
create policy "Users can insert their own ownerships"
  on public.ownerships for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own ownerships" on public.ownerships;
create policy "Users can delete their own ownerships"
  on public.ownerships for delete
  using (auth.uid() = user_id);

-- Invite-Only Beta lead-capture form on the standalone hub site (hub/index.html,
-- a separate static page with no login of its own — see AddOwnershipsModal's
-- sibling concept, but this one has no authenticated user at all). Written by
-- the submit-beta-lead edge function using the service-role key, never
-- directly by a client, since there's no session to satisfy a normal
-- user_id-scoped insert policy — hence no insert policy on this table at all,
-- only the admin-only select below. area_of_interest is the already-joined,
-- comma-separated display string built client-side (see the hub form's submit
-- handler), not a normalized array — this is a lead record for staff to read,
-- not a table other app code queries/filters by individual interest area.
create table if not exists public.beta_leads (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  work_email text not null,
  company text not null,
  area_of_interest text not null,
  use_case text,
  source_door text,
  created_at timestamptz not null default now()
);

-- Set by the admin panel's "Invite" button (a real account invite via the
-- existing admin-create-user edge function/inviteUserByEmail flow, not a
-- second email system) — lets staff see at a glance which leads have
-- already been converted so they don't re-invite the same person.
alter table public.beta_leads add column if not exists invited_at timestamptz;

alter table public.beta_leads enable row level security;

drop policy if exists "Admins can view all beta leads" on public.beta_leads;
create policy "Admins can view all beta leads"
  on public.beta_leads for select
  using (public.is_admin());

-- Same additive is_admin() pattern as public.properties above — lets the
-- admin panel write invited_at directly (marking a lead invited) and
-- delete processed/spam leads, both straight from the client, with no
-- edge function needed since these don't touch auth.users.
drop policy if exists "Admins can update beta leads" on public.beta_leads;
create policy "Admins can update beta leads"
  on public.beta_leads for update
  using (public.is_admin());

drop policy if exists "Admins can delete beta leads" on public.beta_leads;
create policy "Admins can delete beta leads"
  on public.beta_leads for delete
  using (public.is_admin());

-- Lets a user mark a specific AI-report data requirement "not applicable"
-- instead of being stuck forever on "Needs Data"/"Additional Data Needed" —
-- e.g. no P&L exists to upload for Module 7 (income), or a specific Module 4
-- site factor / Module 5 building component genuinely has no document/photo
-- available. item_key is '' for a whole-module override (income); the exact
-- site-factor or building-component name for a per-item override within
-- Module 4/5. See enforceSiteFactorRealData / enforceBuildingComponentRealData
-- in ai-report-modules/index.ts and module-overrides.ts for how these are
-- read back and applied — real data (a real FEMA point, an actual uploaded
-- photo) always wins over a stale override, this never suppresses genuine
-- data that later shows up.
create table if not exists public.module_data_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  module_id text not null,
  item_key text not null default '',
  created_at timestamptz not null default now(),
  unique (property_id, module_id, item_key)
);

alter table public.module_data_overrides enable row level security;

drop policy if exists "Users can view their own module overrides" on public.module_data_overrides;
create policy "Users can view their own module overrides"
  on public.module_data_overrides for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own module overrides" on public.module_data_overrides;
create policy "Users can insert their own module overrides"
  on public.module_data_overrides for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own module overrides" on public.module_data_overrides;
create policy "Users can delete their own module overrides"
  on public.module_data_overrides for delete
  using (auth.uid() = user_id);

-- Who will actually attend the hearing — grounded in the same real
-- Owner/Agent distinction the app already models via Form 50-162
-- (Appointment of Agent; see ProtestAuthorizationFlow.tsx). Nullable/
-- user-selected, not inferred automatically: an authorization on file
-- means an agent CAN attend, not that they necessarily will.
alter table public.protests add column if not exists attendance_type text;
alter table public.protests drop constraint if exists protests_attendance_type_check;
alter table public.protests add constraint protests_attendance_type_check
  check (attendance_type is null or attendance_type in ('Property Owner', 'Authorized Agent', 'Both'));

-- Real, AI-extracted content from an actual ARB Order / hearing decision /
-- settlement / revised value notice / other final determination the user
-- (or staff) uploads after a hearing — see extract-decision-document/
-- index.ts for the prompt/discipline. Mirrors hearing_notices' own
-- pattern: one row per real uploaded document, most recent wins. value_
-- reduction is deliberately NOT a column — it's always original_value
-- minus final_value, computed in application code so it can never drift
-- from the two real numbers it's derived from. discrepancies is JSON-
-- stringified, computed server-side by deterministic comparison against
-- the case's own known facts, never the model's own say-so.
create table if not exists public.decision_notices (
  id uuid primary key default gen_random_uuid(),
  protest_id uuid not null references public.protests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  document_category text,
  original_value numeric,
  final_value numeric,
  decision_date text,
  extracted_tax_year text,
  extracted_account_number text,
  extracted_property_address text,
  settlement_terms text,
  appeal_deadline text,
  refund_indicator text,
  other_conditions text,
  discrepancies text,
  created_at timestamptz not null default now()
);

alter table public.decision_notices enable row level security;

drop policy if exists "Users can view their own decision notices" on public.decision_notices;
create policy "Users can view their own decision notices"
  on public.decision_notices for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own decision notices" on public.decision_notices;
create policy "Users can insert their own decision notices"
  on public.decision_notices for insert
  with check (auth.uid() = user_id);

drop policy if exists "Admins can view all decision notices" on public.decision_notices;
create policy "Admins can view all decision notices"
  on public.decision_notices for select
  using (public.is_admin());

-- A real settlement offer document the county sent for signature (distinct
-- from decision_notices above, which records an ALREADY-final outcome) —
-- upload, AI-verified read of the settled value/terms against the case's
-- own real facts, explicit user confirmation, then a real signature. The
-- original upload is document_id; once signed, signed_document_id points
-- at the certified copy (see settlement-agreement.ts's appendSignaturePage)
-- the user actually downloads and submits — this app has no e-filing
-- integration with any county, so submission itself always stays on the
-- user. Same signature_type/signature_data shape as
-- protest_form_submissions, but a separate table: that one is scoped to
-- this app's OWN generated forms (field_values matches a known schema),
-- while this is an arbitrary document the county produced.
create table if not exists public.settlement_agreements (
  id uuid primary key default gen_random_uuid(),
  protest_id uuid not null references public.protests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  settled_value numeric,
  extracted_tax_year text,
  extracted_account_number text,
  extracted_property_address text,
  terms_summary text,
  discrepancies text,
  user_confirmed_at timestamptz,
  signature_type text,
  signature_data text,
  signed_at timestamptz,
  signed_document_id uuid references public.documents (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.settlement_agreements enable row level security;

drop policy if exists "Users can view their own settlement agreements" on public.settlement_agreements;
create policy "Users can view their own settlement agreements"
  on public.settlement_agreements for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own settlement agreements" on public.settlement_agreements;
create policy "Users can insert their own settlement agreements"
  on public.settlement_agreements for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own settlement agreements" on public.settlement_agreements;
create policy "Users can update their own settlement agreements"
  on public.settlement_agreements for update
  using (auth.uid() = user_id);

drop policy if exists "Admins can view all settlement agreements" on public.settlement_agreements;
create policy "Admins can view all settlement agreements"
  on public.settlement_agreements for select
  using (public.is_admin());

-- Single-row global switch table — a real, admin-toggleable runtime setting
-- rather than a source-level constant that needs a code change + redeploy to
-- flip. `id boolean primary key default true` + the check constraint is the
-- standard Postgres "exactly one row, forever" trick: any second insert
-- collides on the same primary key. enforce_per_property_entitlement gates
-- getEntitledPropertyIds()/planUsesPerPropertyEntitlement() in billing.ts —
-- see ai-report.tsx for how it's read and applied. Publicly readable (every
-- signed-in user's own client needs it to know whether to enforce their own
-- entitlement), writable by admins only (see the Settings tab in
-- src/routes/admin.tsx).
create table if not exists public.app_settings (
  id boolean primary key default true,
  enforce_per_property_entitlement boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = true)
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists "Anyone can read app settings" on public.app_settings;
create policy "Anyone can read app settings"
  on public.app_settings for select
  using (true);

drop policy if exists "Admins can update app settings" on public.app_settings;
create policy "Admins can update app settings"
  on public.app_settings for update
  using (public.is_admin());

-- Referral program — each user's own shareable code, who referred them (set
-- once at signup by handle_new_user() above, never changed after), and when
-- the REFERRER was actually credited for referring THIS specific user.
-- referral_reward_granted_at lives on the referred user's own row rather
-- than a separate referrals table — it's the one-time "have we already paid
-- out for this specific signup converting" flag stripe-webhook checks before
-- granting a reward, so the same referred user's subscription reactivating
-- later can never double-pay the referrer. None of these three columns are
-- in the client-writable column grant below (or above) — only
-- handle_new_user() (security definer) and stripe-webhook (service-role
-- client, bypasses RLS) ever write them.
alter table public.profiles add column if not exists referral_code text unique;
alter table public.profiles add column if not exists referred_by uuid references public.profiles (id) on delete set null;
alter table public.profiles add column if not exists referral_reward_granted_at timestamptz;

-- Backfill: existing accounts created before this feature shipped have no
-- referral_code yet — without one they'd have nothing to share.
update public.profiles
  set referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  where referral_code is null;

-- Real reads a referrer needs (their own referral list) without granting
-- broad SELECT on other users' full profile rows — RLS is row-level, not
-- column-level, so a plain "referred_by = auth.uid()" policy would leak
-- every column (phone, stripe ids, plan, ...) of everyone they referred.
-- This security-definer function returns only the safe, minimal fields a
-- referral-status list actually needs. "converted" checks the real plan
-- value, not a guess; "rewarded" checks the real timestamp stripe-webhook
-- sets, not a separate assumption.
create or replace function public.get_my_referrals()
returns table (
  id uuid,
  first_name text,
  signed_up_at timestamptz,
  converted boolean,
  rewarded boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    p.first_name,
    p.created_at as signed_up_at,
    (p.plan in ('owner_managed', 'corvusrf_managed')) as converted,
    (p.referral_reward_granted_at is not null) as rewarded
  from public.profiles p
  where p.referred_by = auth.uid()
  order by p.created_at desc;
$$;

-- One row per address a user has sent a REFERRAL invite email to (see
-- send-referral-invite/index.ts). The referral flow, unlike the admin
-- sign-up-invite flow (invited_users above), had no record of an invite at
-- all until the person signed up — so a user who'd emailed a friend saw
-- nothing on /dashboard/referrals and assumed it hadn't worked. This is that
-- pending record. It is NOT auto-cleared on signup (get_my_referrals returns
-- no email to match on, and the signup email may differ from the invited
-- address anyway) — the user dismisses stale rows themselves via the delete
-- policy below. email is stored already-lowercased; re-inviting the same
-- address bumps sent_at on the existing row instead of duplicating.
create table if not exists public.referral_invites (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.profiles (id) on delete cascade,
  email text not null,
  sent_at timestamptz not null default now()
);

create unique index if not exists referral_invites_referrer_email_idx
  on public.referral_invites (referrer_id, email);

alter table public.referral_invites enable row level security;

-- A referrer sees only their own pending invites. Writes are service-role
-- only (send-referral-invite), so there's no insert/update policy.
drop policy if exists "Users can view their own referral invites" on public.referral_invites;
create policy "Users can view their own referral invites"
  on public.referral_invites for select
  using (referrer_id = auth.uid());

-- Lets the user dismiss a pending invite (already signed up, wrong address,
-- changed their mind) straight from the referrals page.
drop policy if exists "Users can delete their own referral invites" on public.referral_invites;
create policy "Users can delete their own referral invites"
  on public.referral_invites for delete
  using (referrer_id = auth.uid());

-- ── ONE-TIME MANUAL STEP — do NOT run this as part of the routine schema paste ──
-- After you have an account (sign up normally through the app first), run this once,
-- by itself, substituting your real email, to make that account an admin:
--
-- update public.profiles set is_admin = true where email = 'you@example.com';
