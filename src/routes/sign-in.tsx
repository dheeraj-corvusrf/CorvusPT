import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Clock, Info } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { searchPropertiesByOwner } from "@/lib/cad-owner-search";
import type { CadRecord } from "@/lib/cad-lookup";
import { AddOwnershipsModal } from "@/components/AddOwnershipsModal";
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  SIGNUP_ACK_VERSION,
  SIGNUP_ACK_INTRO,
  SIGNUP_ACK_ITEMS,
  SIGNUP_ACK_CONFIRM,
} from "@/lib/legal";

export const Route = createFileRoute("/sign-in")({
  head: () => ({
    meta: [
      { title: "Sign In — CorvusPT" },
      { name: "description", content: "Sign in to your CorvusPT property tax dashboard." },
      { property: "og:title", content: "Sign In — CorvusPT" },
      { property: "og:description", content: "Access your property tax dashboard." },
    ],
  }),
  // Lets any page that sends a signed-out visitor here (the dashboard guard,
  // pricing's "sign in to subscribe" prompt, etc.) say where to return to
  // afterward — without this, every sign-in landed on "/" regardless of what
  // the visitor was actually trying to do. mode/email/firstName/lastName/beta
  // are for the admin panel's invite links (see buildSignupInviteLink in
  // src/lib/admin.ts) — they only prefill the form; no account exists until
  // the invitee actually completes sign-up themselves (password or Google).
  // ref is a referral code (see buildReferralLink in src/lib/referrals.ts) —
  // just the raw string read off the URL; it's never resolved/trusted here,
  // only passed through to signUp()'s options.data for handle_new_user() to
  // resolve server-side (see schema.sql).
  // reason is a short, plain-text explanation set by whatever guard sent a
  // signed-out visitor here (e.g. the /dashboard/* guard's REDIRECT_REASONS
  // map) — shown as a small banner so the redirect doesn't feel unexplained.
  // Never HTML — always rendered as plain text below.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    redirect?: string;
    mode?: "signup";
    email?: string;
    firstName?: string;
    lastName?: string;
    beta?: string;
    ref?: string;
    reason?: string;
  } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    mode: search.mode === "signup" ? "signup" : undefined,
    email: typeof search.email === "string" ? search.email : undefined,
    firstName: typeof search.firstName === "string" ? search.firstName : undefined,
    lastName: typeof search.lastName === "string" ? search.lastName : undefined,
    beta: typeof search.beta === "string" ? search.beta : undefined,
    ref: typeof search.ref === "string" ? search.ref : undefined,
    reason: typeof search.reason === "string" ? search.reason : undefined,
  }),
  component: SignIn,
});

// The idle-timeout sign-out (see AuthProvider in src/lib/auth.tsx) reads as
// a security event, not a generic notice — its own warmer amber card with a
// clock icon says "this was routine and expected," instead of the flatter
// accent-tinted box every other redirect reason uses.
function ReasonBanner({ reason }: { reason: string }) {
  const isIdleTimeout = reason.toLowerCase().includes("inactivity");
  return (
    <div
      className={
        isIdleTimeout
          ? "mt-4 flex items-start gap-2.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-foreground"
          : "mt-4 flex items-start gap-2.5 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-foreground"
      }
    >
      {isIdleTimeout ? (
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      ) : (
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
      )}
      <span>{reason}</span>
    </div>
  );
}

function SignIn() {
  const nav = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const searchParams = Route.useSearch();
  const { redirect } = searchParams;
  // `redirect` must be an app-relative path. Also heal a stale value that
  // still carries the GitHub Pages base ("/corvuspt/dashboard/...") — passing
  // that to nav() would prepend the base a second time and 404.
  const base = import.meta.env.BASE_URL.replace(/\/$/, ""); // "" locally, "/corvuspt" in prod
  let cleaned = redirect ?? "";
  if (base && cleaned.startsWith(`${base}/`)) cleaned = cleaned.slice(base.length);
  // Never bounce back to /sign-in itself — the header's "Sign In" link carries
  // `redirect: pathname`, so clicking it while already on /sign-in would make
  // returnTo "/sign-in" and every post-sign-in nav() a no-op ("nothing
  // happens when I click Sign In").
  const isSelf = cleaned === "/sign-in" || cleaned.startsWith("/sign-in?");
  const returnTo =
    cleaned && cleaned.startsWith("/") && !cleaned.startsWith("//") && !isSelf ? cleaned : "/";
  const [mode, setMode] = useState<"signin" | "signup">(
    searchParams.mode === "signup" ? "signup" : "signin",
  );
  const [firstName, setFirstName] = useState(searchParams.firstName ?? "");
  const [lastName, setLastName] = useState(searchParams.lastName ?? "");
  const [phone, setPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState(searchParams.email ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [wantsBeta, setWantsBeta] = useState(searchParams.beta === "1");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const [ownerMatches, setOwnerMatches] = useState<{
    userId: string;
    companyName: string;
    matches: CadRecord[];
  } | null>(null);

  // Leave the sign-in page as soon as auth resolves to a signed-in user —
  // driven by the settled auth state, not only the imperative nav() at the end
  // of onSubmit. Supabase fires its SIGNED_IN event (which re-renders the whole
  // tree via AuthProvider) in the same tick that signInWithPassword() resolves,
  // and that re-render can swallow the post-await nav() call — the reported
  // "I click Sign In and nothing happens, then the second click works" race.
  // This effect responds to `user` becoming truthy on any later render, so a
  // swallowed nav() is always recovered. Held back while the post-signup owner-
  // match modal is open (it runs its own nav on close) or in check-email state.
  useEffect(() => {
    if (authLoading || !user || ownerMatches || checkEmail) return;
    nav({ to: returnTo, replace: true });
  }, [authLoading, user, ownerMatches, checkEmail, nav, returnTo]);

  function switchMode(next: "signin" | "signup") {
    setMode(next);
    setError(null);
    setCheckEmail(false);
    setPassword("");
    setConfirmPassword("");
    setFirstName("");
    setLastName("");
    setPhone("");
    setCompanyName("");
    setWantsBeta(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === "signup" && (!firstName.trim() || !lastName.trim())) {
      setError("Please enter your first and last name.");
      return;
    }
    // Optional — only validated when the user actually entered something,
    // rather than requiring a value at all.
    if (mode === "signup" && phone.trim() && !/^[0-9+()\- ]{7,20}$/.test(phone.trim())) {
      setError("Please enter a valid phone number.");
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (mode === "signup" && password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (mode === "signup" && !termsAccepted) {
      setError("Please accept the Terms of Service and Privacy Policy to continue.");
      return;
    }
    if (!isSupabaseConfigured) {
      setError("Accounts aren't set up in this deployment yet. Please check back soon.");
      return;
    }

    setLoading(true);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              first_name: firstName.trim(),
              last_name: lastName.trim(),
              phone: phone.trim() || null,
              company_name: companyName.trim() || null,
              // Read server-side by handle_new_user() (supabase/schema.sql) to set
              // plan='beta' at row-creation — never written by the client directly.
              wants_beta: String(wantsBeta),
              // Same pattern — the raw code from ?ref=, resolved into a real
              // referred_by user id by handle_new_user(), not here.
              referral_code_used: searchParams.ref ?? null,
              // Terms/Privacy acceptance versions — handle_new_user() writes
              // the terms_acceptances row from these (see schema.sql).
              terms_version: TERMS_VERSION,
              privacy_version: PRIVACY_VERSION,
              ack_version: SIGNUP_ACK_VERSION,
            },
          },
        });
        if (signUpError) throw signUpError;
        if (!data.session || !data.user) {
          // Email confirmation is required before a session is issued.
          setCheckEmail(true);
        } else {
          // Real, one-time opportunistic lookup — search supported CAD sources for
          // properties already on file under this ownership name, so the user doesn't
          // have to type in every address by hand. Falls back to the person's own
          // full name when no business/LLC name was given, so individual owners get
          // portfolio discovery too, not just LLC/business signups.
          const userId = data.user.id;
          const ownerName = companyName.trim() || `${firstName.trim()} ${lastName.trim()}`;
          try {
            const { matches } = await searchPropertiesByOwner(ownerName);
            if (matches.length > 0) {
              setOwnerMatches({ userId, companyName: ownerName, matches });
            } else {
              nav({ to: returnTo });
            }
          } catch (err) {
            console.error(err);
            nav({ to: returnTo });
          }
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        nav({ to: returnTo });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Google handles both sign-up and sign-in in one flow — Supabase creates the
  // auth.users row (and, via handle_new_user() in schema.sql, a profiles row)
  // the first time a given Google account completes this, and just signs them
  // in on every return visit. No mode distinction needed, unlike the email
  // form above. This is a full-page redirect (to Google, then back), not an
  // async call — redirectTo carries the SAME `returnTo` the email form uses,
  // so the user lands directly back on whatever page sent them to sign in,
  // without an extra hop through /sign-in first.
  async function handleGoogleSignIn() {
    setError(null);
    if (!isSupabaseConfigured) {
      setError("Accounts aren't set up in this deployment yet. Please check back soon.");
      return;
    }
    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}${returnTo.slice(1)}`;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (oauthError) setError(oauthError.message);
  }

  if (checkEmail) {
    return (
      <div className="container-page py-16 max-w-2xl">
        <span className="badge-soft">Almost there</span>
        <h1 className="mt-3 font-serif text-3xl font-semibold">Check your email.</h1>
        <p className="mt-2 text-muted-foreground">
          We sent a confirmation link to <strong>{email}</strong>. Click it to activate your
          account, then sign in.
        </p>
        <button onClick={() => switchMode("signin")} className="btn-primary btn-primary-hover mt-6">
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="container-page pt-16 max-w-2xl">
        <span className="badge-soft">{mode === "signin" ? "Sign In" : "Create Account"}</span>
        <h1 className="mt-3 font-serif text-3xl font-semibold">
          {mode === "signin" ? "Welcome back." : "Create your CorvusPT account."}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {mode === "signin"
            ? "Your properties, protests, deadlines, and savings — all in one place."
            : "Save your property, analysis, documents, and preview history."}
        </p>
        {searchParams.reason && <ReasonBanner reason={searchParams.reason} />}
      </div>

      <div className="container-page pb-16 max-w-2xl">
        <form onSubmit={onSubmit} className="mt-8 card-elev p-6 grid gap-4">
          <button type="button" onClick={handleGoogleSignIn} className="btn-outline w-full">
            <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden="true">
              <path
                fill="#FFC107"
                d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
              />
              <path
                fill="#FF3D00"
                d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
              />
              <path
                fill="#4CAF50"
                d="M24 44c5.4 0 10.3-2.1 14-5.5l-6.5-5.5c-2 1.5-4.6 2.5-7.5 2.5-5.3 0-9.7-3.3-11.3-8l-6.6 5.1C9.6 39.6 16.2 44 24 44z"
              />
              <path
                fill="#1976D2"
                d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.3 5.6l6.5 5.5C39.9 37 44 31 44 24c0-1.3-.1-2.7-.4-3.5z"
              />
            </svg>
            Continue with Google
          </button>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            or continue with email
            <div className="h-px flex-1 bg-border" />
          </div>
          {mode === "signup" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm min-w-0">
                <span className="font-medium">
                  First Name<span className="text-destructive"> *</span>
                </span>
                <input
                  required
                  type="text"
                  autoComplete="given-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full min-w-0 rounded-md border border-input bg-background px-3 py-2"
                />
              </label>
              <label className="grid gap-1 text-sm min-w-0">
                <span className="font-medium">
                  Last Name<span className="text-destructive"> *</span>
                </span>
                <input
                  required
                  type="text"
                  autoComplete="family-name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full min-w-0 rounded-md border border-input bg-background px-3 py-2"
                />
              </label>
            </div>
          )}
          {mode === "signup" && (
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Phone Number (optional)</span>
              <input
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2"
              />
            </label>
          )}
          {mode === "signup" && (
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Business / LLC Name (optional)</span>
              <input
                type="text"
                autoComplete="organization"
                placeholder="e.g. Acme Commercial Holdings LLC"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2"
              />
              <span className="text-xs text-muted-foreground">
                We'll check county records for properties already on file under this name.
              </span>
            </label>
          )}
          <label className="grid gap-1 text-sm">
            <span className="font-medium">
              Email<span className="text-destructive"> *</span>
            </span>
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">
              Password<span className="text-destructive"> *</span>
            </span>
            <input
              required
              type="password"
              minLength={6}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2"
            />
          </label>
          {mode === "signin" && (
            <Link
              to="/forgot-password"
              className="-mt-2 justify-self-end text-sm text-muted-foreground hover:text-foreground"
            >
              Forgot password?
            </Link>
          )}
          {mode === "signup" && (
            <label className="grid gap-1 text-sm">
              <span className="font-medium">
                Confirm Password<span className="text-destructive"> *</span>
              </span>
              <input
                required
                type="password"
                minLength={6}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2"
              />
            </label>
          )}
          {mode === "signup" && (
            <div className="flex items-start gap-2 text-sm rounded-lg border border-accent/30 bg-accent/5 p-3">
              <input
                id="wants-beta"
                type="checkbox"
                checked={wantsBeta}
                onChange={(e) => setWantsBeta(e.target.checked)}
                className="mt-0.5"
              />
              <label htmlFor="wants-beta">
                <span className="font-medium">🎉 Sign up as a beta user</span>
                <span className="block text-muted-foreground text-xs mt-0.5">
                  Free full access to every AI module while we're in beta — no card, no charge.
                </span>
              </label>
            </div>
          )}
          {mode === "signup" && (
            <div className="grid gap-2 rounded-lg border border-border p-3 text-sm">
              <label className="flex items-start gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I have read and agree to the{" "}
                  <a
                    href="/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline underline-offset-2"
                  >
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline underline-offset-2"
                  >
                    Privacy Policy
                  </a>
                  .
                </span>
              </label>
              <p className="text-muted-foreground text-xs">{SIGNUP_ACK_INTRO}</p>
              <ul className="text-muted-foreground grid list-disc gap-1 pl-5 text-xs">
                {SIGNUP_ACK_ITEMS.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p className="text-muted-foreground text-xs">{SIGNUP_ACK_CONFIRM}</p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            disabled={loading || (mode === "signup" && !termsAccepted)}
            className="btn-primary btn-primary-hover disabled:opacity-60"
          >
            {loading ? "Please wait…" : mode === "signin" ? "Sign In" : "Agree & Create Account"}
          </button>
          <button
            type="button"
            onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {mode === "signin"
              ? "Need an account? Create one."
              : "Already have an account? Sign in."}
          </button>
        </form>
        {ownerMatches && (
          <AddOwnershipsModal
            userId={ownerMatches.userId}
            initialMatch={{
              name: ownerMatches.companyName,
              role: "owner",
              records: ownerMatches.matches,
            }}
            onImported={() => {}}
            onClose={() => {
              setOwnerMatches(null);
              nav({ to: returnTo });
            }}
          />
        )}
      </div>
    </div>
  );
}
