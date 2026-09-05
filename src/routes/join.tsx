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
  // The real referral link a friend actually shares/clicks is a clean path
  // — .../join/CODE, no "?" (see buildReferralLink in src/lib/referrals.ts)
  // — since this is a static site with no server, hub/404.html is what
  // turns that path into a request for THIS page, at ?ref=CODE. This route
  // is just a thin forward from there into the one real sign-up flow
  // (/sign-in?mode=signup&ref=CODE) — no duplicated form.
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
