import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Gift,
  Users,
  Mail,
  Sparkles,
  Share2,
  UserPlus,
  BadgeCheck,
  Link2,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  getMyReferralCode,
  getMyReferrals,
  getMyReferralInvites,
  dismissReferralInvite,
  buildReferralLink,
  sendReferralInvite,
  type ReferralRecord,
  type ReferralInvite,
} from "@/lib/referrals";
import { CopyButton } from "@/components/CopyButton";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/error-message";

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
  const [invites, setInvites] = useState<ReferralInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [sendingInvite, setSendingInvite] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getMyReferralCode(user.id),
      getMyReferrals(),
      // Resilient on its own: a pending-invites read failing shouldn't block
      // the referral list from rendering.
      getMyReferralInvites().catch((err) => {
        console.error("Could not load pending invites:", err);
        return [] as ReferralInvite[];
      }),
    ])
      .then(([c, list, inv]) => {
        setCode(c);
        setReferrals(list);
        setInvites(inv);
      })
      .catch((err) => console.error("Could not load referral info:", err))
      .finally(() => setLoading(false));
  }, [user]);

  const rewardedCount = referrals.filter((r) => r.rewarded).length;
  const convertedCount = referrals.filter((r) => r.converted).length;
  const link = code ? buildReferralLink(code) : null;

  async function handleSendInvite(e: FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setSendingInvite(true);
    try {
      await sendReferralInvite(inviteEmail.trim());
      toast.success(`Invite sent to ${inviteEmail.trim()}.`);
      setInviteEmail("");
      // send-referral-invite records the pending invite server-side — pull the
      // fresh list so it shows up right away.
      getMyReferralInvites()
        .then(setInvites)
        .catch((err) => console.error(err));
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not send this invite. Please try again."));
    } finally {
      setSendingInvite(false);
    }
  }

  async function handleDismiss(id: string) {
    setDismissingId(id);
    try {
      await dismissReferralInvite(id);
      setInvites((prev) => prev.filter((x) => x.id !== id));
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not remove this invite."));
    } finally {
      setDismissingId(null);
    }
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Referrals</h1>
        <p className="text-muted-foreground text-sm">
          Share your link — for every friend who signs up and subscribes, you get one month free.
        </p>
      </div>

      {loading ? (
        <div className="grid gap-6">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="grid gap-6 lg:col-span-2">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-52 w-full" />
            </div>
            <Skeleton className="h-72 w-full" />
          </div>
        </div>
      ) : (
        <>
          {/* Focal band — the referral link itself, front and centre. */}
          <div className="brand-gradient relative overflow-hidden rounded-2xl p-6 shadow-elev sm:p-8">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-lg">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold">
                  <Gift className="h-3.5 w-3.5" />
                  Referral rewards
                </span>
                <h2 className="mt-3 font-serif text-2xl font-bold sm:text-3xl">
                  Give a month, get a month
                </h2>
                <p className="mt-2 text-sm text-white/80">
                  Every friend who signs up through your link and starts a paid CorvusPT plan earns
                  you one month free — credited straight to your next bill, automatically.
                </p>
              </div>

              <div className="hidden shrink-0 sm:block">
                <div className="grid h-24 w-24 place-items-center rounded-2xl bg-white/10 text-center ring-1 ring-white/20">
                  <div>
                    <div className="font-serif text-3xl font-black leading-none tabular-nums">
                      {rewardedCount}
                    </div>
                    <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-white/70">
                      months earned
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {link ? (
              <div className="mt-5 flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2.5 ring-1 ring-white/20 backdrop-blur">
                <Link2 className="h-4 w-4 shrink-0 text-white/70" />
                <code className="min-w-0 flex-1 truncate text-xs text-white sm:text-sm">
                  {link}
                </code>
                <CopyButton value={link} label="Referral link copied" />
              </div>
            ) : (
              <p className="mt-5 text-sm text-white/90">
                Could not load your referral link — please refresh in a moment.
              </p>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="grid content-start gap-6 lg:col-span-2">
              {/* Email a friend directly */}
              <div className="card-elev p-6">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Mail className="text-accent h-4 w-4" />
                  Invite a friend by email
                </div>
                <p className="text-muted-foreground mt-1.5 text-xs">
                  We'll send a branded email from CorvusPT with your name and your referral link.
                  Nothing is created on their end until they sign up themselves.
                </p>
                <form onSubmit={handleSendInvite} className="mt-3 flex flex-wrap gap-2">
                  <label htmlFor="referral-invite-email" className="sr-only">
                    Friend's email address
                  </label>
                  <input
                    id="referral-invite-email"
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="friend@email.com"
                    className="border-input bg-background min-w-0 flex-1 rounded-md border px-3 py-2 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={sendingInvite}
                    className="btn-accent text-sm disabled:opacity-60"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    {sendingInvite ? "Sending…" : "Send Invite"}
                  </button>
                </form>
                <div className="bg-secondary/40 text-muted-foreground mt-4 flex items-start gap-2 rounded-lg p-3 text-xs">
                  <BadgeCheck className="text-accent mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    When their subscription goes active, your one month free is applied to your next
                    bill automatically — no action needed from you.
                  </span>
                </div>
              </div>

              {/* Your referrals */}
              <div className="card-elev p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Users className="text-accent h-4 w-4" />
                    Your referrals
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {invites.length > 0 && <StatChip label="Invited" value={invites.length} />}
                    <StatChip label="Referred" value={referrals.length} />
                    <StatChip label="Subscribed" value={convertedCount} />
                    <StatChip label="Free months" value={rewardedCount} />
                  </div>
                </div>

                {invites.length > 0 && (
                  <div className="mt-4">
                    <div className="text-muted-foreground text-xs font-medium">
                      Pending invites — these move to your referrals once the person signs up
                    </div>
                    <ul className="mt-2 grid gap-2">
                      {invites.map((iv) => (
                        <li
                          key={iv.id}
                          className="border-border flex items-center justify-between gap-3 rounded-lg border border-dashed p-3 text-sm"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="bg-secondary text-muted-foreground grid h-8 w-8 shrink-0 place-items-center rounded-full">
                              <Mail className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-medium">{iv.email}</div>
                              <div className="text-muted-foreground text-xs">
                                Invited {new Date(iv.sentAt).toLocaleDateString()} · awaiting
                                sign-up
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDismiss(iv.id)}
                            disabled={dismissingId === iv.id}
                            aria-label={`Dismiss invite to ${iv.email}`}
                            className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition-colors disabled:opacity-50"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {referrals.length === 0 ? (
                  <div className="border-border mt-4 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center">
                    <div className="bg-secondary text-muted-foreground grid h-10 w-10 place-items-center rounded-full">
                      <Users className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-medium">
                      {invites.length > 0 ? "No sign-ups yet" : "No referrals yet"}
                    </p>
                    <p className="text-muted-foreground max-w-xs text-xs">
                      {invites.length > 0
                        ? "None of your invites have created an account yet. When one does, they'll show up here with how close they are to earning you a free month."
                        : "Share your link above — everyone who signs up shows up here, along with how close each one is to earning you a free month."}
                    </p>
                  </div>
                ) : (
                  <ul className="mt-4 grid gap-2">
                    {referrals.map((r) => {
                      const name = r.firstName ?? "A referred user";
                      return (
                        <li
                          key={r.id}
                          className="row-hover border-border flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="bg-secondary text-muted-foreground grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold">
                              {name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-medium">{name}</div>
                              <div className="text-muted-foreground text-xs">
                                Signed up {new Date(r.signedUpAt).toLocaleDateString()}
                              </div>
                            </div>
                          </div>
                          <span
                            className={`badge-soft shrink-0 ${
                              r.rewarded || r.converted ? "" : "bg-secondary text-muted-foreground"
                            }`}
                          >
                            {r.rewarded ? (
                              <>
                                <BadgeCheck className="h-3 w-3" />
                                Free month applied
                              </>
                            ) : r.converted ? (
                              "Subscribed"
                            ) : (
                              "Signed up"
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            {/* How it works */}
            <div className="card-elev p-6 lg:col-span-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="text-accent h-4 w-4" />
                How it works
              </div>
              <ol className="mt-4 grid gap-4">
                <Step
                  n={1}
                  icon={Share2}
                  title="Share your link"
                  body="Send it however you like — text, email, or the invite box to the left."
                />
                <Step
                  n={2}
                  icon={UserPlus}
                  title="Your friend subscribes"
                  body="They sign up through your link and start a paid CorvusPT plan."
                />
                <Step
                  n={3}
                  icon={Gift}
                  title="You get a month free"
                  body="A credit equal to your own plan's monthly total lands on your next bill."
                />
              </ol>
              <p className="border-border text-muted-foreground mt-5 border-t pt-4 text-xs">
                No cap — every friend who subscribes is another month free. Credits apply
                automatically, in the order they're earned.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="border-border bg-secondary/40 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
      <span className="tabular-nums font-semibold">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function Step({
  n,
  icon: Icon,
  title,
  body,
}: {
  n: number;
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3">
      <div className="brand-gradient relative grid h-8 w-8 shrink-0 place-items-center rounded-full">
        <Icon className="h-4 w-4" />
        <span className="border-card bg-card text-foreground absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full border text-[10px] font-bold">
          {n}
        </span>
      </div>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="text-muted-foreground mt-0.5 text-xs">{body}</p>
      </div>
    </li>
  );
}
