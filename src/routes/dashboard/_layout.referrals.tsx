import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Gift, Users } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  getMyReferralCode,
  getMyReferrals,
  buildReferralLink,
  type ReferralRecord,
} from "@/lib/referrals";
import { CopyButton } from "@/components/CopyButton";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/dashboard/_layout/referrals")({
  head: () => ({
    meta: [
      { title: "Referrals — CorvusPT" },
      {
        name: "description",
        content:
          "Share your CorvusPT referral link — one month free for every friend who subscribes.",
      },
    ],
  }),
  component: Referrals,
});

function Referrals() {
  const { user } = useAuth();
  const [code, setCode] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<ReferralRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    Promise.all([getMyReferralCode(user.id), getMyReferrals()])
      .then(([c, list]) => {
        setCode(c);
        setReferrals(list);
      })
      .catch((err) => console.error("Could not load referral info:", err))
      .finally(() => setLoading(false));
  }, [user]);

  const rewardedCount = referrals.filter((r) => r.rewarded).length;
  const link = code ? buildReferralLink(code) : null;

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold">Referrals</h1>
      <p className="text-muted-foreground text-sm">
        Share your link — for every friend who signs up and subscribes, you get one month free.
      </p>

      {loading ? (
        <div className="mt-6 grid gap-3 max-w-xl">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="mt-6 grid gap-6 max-w-xl">
          <div className="card-elev p-6">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Gift className="h-4 w-4 text-accent" />
              Your referral link
            </div>
            {link ? (
              <>
                <div className="mt-3 flex items-center gap-2 rounded-md border border-input bg-secondary/30 px-3 py-2">
                  <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
                  <CopyButton value={link} label="Referral link copied" />
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  When someone signs up through your link and their subscription goes active, we
                  automatically credit your account one month free — applied to your next bill, no
                  action needed from you.
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-destructive">
                Could not load your referral link — please try again shortly.
              </p>
            )}
          </div>

          <div className="card-elev p-6">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4 text-accent" />
                Your referrals
              </div>
              {referrals.length > 0 && (
                <span className="badge-soft">
                  {rewardedCount} rewarded of {referrals.length}
                </span>
              )}
            </div>
            {referrals.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No one has signed up with your link yet — share it to get started.
              </p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {referrals.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                  >
                    <div>
                      <div className="font-medium">{r.firstName ?? "A referred user"}</div>
                      <div className="text-xs text-muted-foreground">
                        Signed up {new Date(r.signedUpAt).toLocaleDateString()}
                      </div>
                    </div>
                    <span
                      className={`badge-soft ${r.rewarded ? "" : r.converted ? "" : "bg-secondary text-muted-foreground"}`}
                    >
                      {r.rewarded ? "Free month applied" : r.converted ? "Subscribed" : "Signed up"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
