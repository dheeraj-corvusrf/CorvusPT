import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  getLatestTermsAcceptance,
  termsAcceptanceNeeded,
  recordTermsAcceptance,
} from "@/lib/legal-acceptance";
import { SIGNUP_ACK_INTRO, SIGNUP_ACK_ITEMS, TERMS_UPDATE_ACK_CONFIRM } from "@/lib/legal";
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
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 sm:p-6">
      {/* overflow-hidden on the rounded shell keeps the scrollbar off the
          corners; only the middle region scrolls, so the heading and the
          Accept button stay put no matter how long the list is. */}
      <div className="bg-card flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-elev">
        <div className="border-border border-b px-6 py-5 sm:px-8">
          <h2 className="font-serif text-xl font-semibold">We&apos;ve updated our Terms</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Our{" "}
            <Link
              to="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              to="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              Privacy Policy
            </Link>{" "}
            have changed. Please review and accept them to continue using CorvusPT.
          </p>
        </div>

        <div className="grow overflow-y-auto px-6 py-5 sm:px-8">
          <p className="text-muted-foreground text-sm font-medium">{SIGNUP_ACK_INTRO}</p>
          <ul className="text-muted-foreground mt-2 grid list-disc gap-2 pl-5 text-sm">
            {SIGNUP_ACK_ITEMS.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="border-border bg-card border-t px-6 py-4 sm:px-8">
          <label className="flex items-start gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5"
            />
            <span>{TERMS_UPDATE_ACK_CONFIRM}</span>
          </label>
          <div className="mt-3 flex justify-end">
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
    </div>
  );
}
