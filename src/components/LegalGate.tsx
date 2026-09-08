import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  getLatestTermsAcceptance,
  termsAcceptanceNeeded,
  recordTermsAcceptance,
} from "@/lib/legal-acceptance";
import { SIGNUP_ACK_INTRO, SIGNUP_ACK_ITEMS, SIGNUP_ACK_CONFIRM } from "@/lib/legal";
import { getErrorMessage } from "@/lib/error-message";

// Shown to a signed-in user whose recorded Terms/Privacy acceptance is behind
// the current versions (or missing) — a blocking overlay they must accept
// before continuing. Lives in __root.tsx so it covers every page. Skipped on
// the legal pages themselves and the auth pages.
export function LegalGate() {
  const { user, loading } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [needed, setNeeded] = useState(false);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onExemptRoute =
    pathname === "/terms" ||
    pathname === "/privacy" ||
    pathname === "/sign-in" ||
    pathname.startsWith("/reset-password") ||
    pathname.startsWith("/forgot-password") ||
    pathname === "/admin-login";

  useEffect(() => {
    if (loading || !user) {
      setNeeded(false);
      return;
    }
    let cancelled = false;
    getLatestTermsAcceptance()
      .then((acc) => {
        if (!cancelled) setNeeded(termsAcceptanceNeeded(acc));
      })
      .catch(() => {
        // A read failure shouldn't lock a paying user out of the app — the
        // signup path already required acceptance once.
        if (!cancelled) setNeeded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  if (!needed || onExemptRoute) return null;

  async function accept() {
    if (!checked || submitting) return;
    setSubmitting(true);
    try {
      await recordTermsAcceptance();
      setNeeded(false);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not record your acceptance. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4">
      <div className="bg-card max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl p-6 shadow-lg">
        <h2 className="font-serif text-xl font-semibold">We&apos;ve updated our Terms</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Our{" "}
          <Link
            to="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-foreground underline"
          >
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link
            to="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-foreground underline"
          >
            Privacy Policy
          </Link>{" "}
          have changed. Please review and accept them to continue using CorvusPT.
        </p>

        <p className="text-muted-foreground mt-4 text-xs">{SIGNUP_ACK_INTRO}</p>
        <ul className="text-muted-foreground mt-1 grid list-disc gap-1 pl-5 text-xs">
          {SIGNUP_ACK_ITEMS.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>

        <label className="mt-4 flex items-start gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>{SIGNUP_ACK_CONFIRM}</span>
        </label>

        <div className="mt-4 flex justify-end">
          <button
            onClick={accept}
            disabled={!checked || submitting}
            className="btn-primary btn-primary-hover disabled:opacity-60"
          >
            {submitting ? "Saving…" : "Accept & Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
