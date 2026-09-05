import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/join")({
  head: () => ({
    meta: [
      { title: "Join CorvusPT" },
      {
        name: "description",
        content: "You've been invited to CorvusPT — create your free account.",
      },
    ],
  }),
  // A clean, shareable alias for the referral link (see buildReferralLink in
  // src/lib/referrals.ts) — /sign-in?mode=signup&ref=CODE works identically
  // but reads like a tracking URL when a friend sees it raw. This route is
  // just a thin forward into that same real sign-up flow (still the one
  // source of truth — no duplicated form), swapping in a friendlier path
  // before the query string a friend actually sees when copying the link.
  validateSearch: (search: Record<string, unknown>): { ref?: string } => ({
    ref: typeof search.ref === "string" ? search.ref : undefined,
  }),
  component: Join,
});

function Join() {
  const nav = useNavigate();
  const { ref } = Route.useSearch();

  useEffect(() => {
    nav({ to: "/sign-in", search: { mode: "signup", ref }, replace: true });
  }, [ref, nav]);

  return null;
}
