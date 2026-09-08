import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/dashboard/_layout")({
  component: DashboardLayout,
});

// A short, page-specific explanation shown on the sign-in page a signed-out
// visitor gets bounced to — so e.g. landing on /dashboard/referrals reads as
// "sign in to get your link," not an unexplained redirect. Add an entry here
// for any other /dashboard/* page that deserves its own reason; anything not
// listed falls back to sign-in's own generic copy.
const REDIRECT_REASONS: Record<string, string> = {
  "/dashboard/referrals": "Sign in to get your referral link and start earning free months.",
};

// The account sidebar itself now lives in AppShell (src/components/AppShell.tsx),
// which wraps every signed-in page site-wide — this layout only keeps the
// sign-in guard that's specific to /dashboard/* routes.
function DashboardLayout() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  // The router's own pathname is app-relative (base already stripped) —
  // window.location.pathname still carries the GitHub Pages base ("/corvuspt"),
  // and storing THAT as `redirect` made sign-in navigate to
  // "/corvuspt/corvuspt/dashboard/..." (base prepended twice) → 404. Seen
  // most often right after an idle-timeout sign-out on production.
  const path = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (!loading && !user) {
      nav({ to: "/sign-in", search: { redirect: path, reason: REDIRECT_REASONS[path] } });
    }
  }, [loading, user, nav, path]);

  if (loading || !user) return null;

  return <Outlet />;
}
