import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  checkIsAdmin,
  listAllUsers,
  updateUserPlan,
  updateUserAdminStatus,
  deleteUserAccount,
  impersonateUser,
  createUserAccount,
  listAllProtests,
  updateProtestStatus,
  updateProtestNotes,
  listDocumentsForProperty,
  getCaseSummary,
  toProtestRecord,
  toPropertyRecordStub,
  listAdminAuditLog,
  listBetaLeads,
  markBetaLeadInvited,
  deleteBetaLead,
  listInvitedUsers,
  resendInvite,
  deleteInvitedUser,
  PLAN_OPTIONS,
  PROTEST_STATUS_OPTIONS,
  type AdminUserRecord,
  type PlanValue,
  type AdminProtestRecord,
  type AdminDocumentRecord,
  type CaseSummaryResult,
  type AdminAuditEntry,
  type BetaLead,
  type InvitedUserRecord,
} from "@/lib/admin";
import type { ProtestRecord, ProtestStatus } from "@/lib/protests";
import { listProperties, addProperty, deleteProperty, type PropertyRecord } from "@/lib/properties";
import { currency } from "@/lib/intake-store";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { AdminCaseProgressModal } from "@/components/AdminCaseProgressModal";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/CopyButton";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [{ title: "Admin — CorvusPT" }],
  }),
  component: AdminPanel,
});

type AdminTab =
  "users" | "owner_managed" | "corvus_managed" | "admins" | "invited" | "beta" | "activity";

function AdminPanel() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedInvitedIds, setSelectedInvitedIds] = useState<Set<string>>(new Set());
  const [bulkDeletingInvited, setBulkDeletingInvited] = useState(false);

  const [protests, setProtests] = useState<AdminProtestRecord[]>([]);
  const [protestsLoading, setProtestsLoading] = useState(true);
  const [expandedProtestId, setExpandedProtestId] = useState<string | null>(null);
  const [caseRecord, setCaseRecord] = useState<AdminProtestRecord | null>(null);

  const [auditLog, setAuditLog] = useState<AdminAuditEntry[]>([]);
  const [auditLogLoading, setAuditLogLoading] = useState(true);

  const [betaLeads, setBetaLeads] = useState<BetaLead[]>([]);
  const [betaLeadsLoading, setBetaLeadsLoading] = useState(true);

  const [invitedUsers, setInvitedUsers] = useState<InvitedUserRecord[]>([]);
  const [invitedUsersLoading, setInvitedUsersLoading] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      nav({ to: "/admin-login" });
      return;
    }
    checkIsAdmin(user.id).then((ok) => {
      if (!ok) {
        nav({ to: "/admin-login" });
        return;
      }
      setIsAdmin(true);
    });
  }, [loading, user, nav]);

  // Shared by the initial load and the manual "Refresh" button next to the
  // tabs — nothing here auto-updates otherwise, so anything submitted after
  // this page was first opened (a new beta signup, a user finishing their
  // own sign-up, etc.) stays invisible until one of these two runs again.
  function refreshAll() {
    setUsersLoading(true);
    listAllUsers()
      .then(setUsers)
      .catch((err) => setUsersError(err instanceof Error ? err.message : "Could not load users."))
      .finally(() => setUsersLoading(false));
    setProtestsLoading(true);
    listAllProtests()
      .then(setProtests)
      .catch((err) => console.error(err))
      .finally(() => setProtestsLoading(false));
    setBetaLeadsLoading(true);
    listBetaLeads()
      .then(setBetaLeads)
      .catch((err) => console.error(err))
      .finally(() => setBetaLeadsLoading(false));
    setInvitedUsersLoading(true);
    listInvitedUsers()
      .then(setInvitedUsers)
      .catch((err) => console.error(err))
      .finally(() => setInvitedUsersLoading(false));
    refreshAuditLog();
  }

  useEffect(() => {
    if (!isAdmin) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  function refreshAuditLog() {
    listAdminAuditLog()
      .then(setAuditLog)
      .catch((err) => console.error(err))
      .finally(() => setAuditLogLoading(false));
  }

  async function handleProtestStatusChange(protestId: string, status: ProtestStatus) {
    const prev = protests;
    const record = protests.find((p) => p.id === protestId);
    const requester = users.find((u) => u.id === record?.userId);
    setProtests((cur) => cur.map((p) => (p.id === protestId ? { ...p, status } : p)));
    try {
      await updateProtestStatus(protestId, status, {
        propertyAddress: record?.propertyAddress,
        requesterEmail: requester?.email,
      });
      toast.success("Protest status updated.");
      refreshAuditLog();
    } catch (err) {
      setProtests(prev);
      toast.error(err instanceof Error ? err.message : "Could not update protest status.");
    }
  }

  async function handleProtestNotesChange(protestId: string, notes: string) {
    const record = protests.find((p) => p.id === protestId);
    const requester = users.find((u) => u.id === record?.userId);
    setProtests((cur) => cur.map((p) => (p.id === protestId ? { ...p, notes } : p)));
    await updateProtestNotes(protestId, notes, {
      propertyAddress: record?.propertyAddress,
      requesterEmail: requester?.email,
    });
    refreshAuditLog();
  }

  // CaseProgress (reused from the customer dashboard) already made the write —
  // this just keeps the modal and the row's status dropdown in sync with it.
  function handleCaseProgressUpdate(protestId: string, patch: Partial<ProtestRecord>) {
    setCaseRecord((prev) => (prev && prev.id === protestId ? { ...prev, ...patch } : prev));
    setProtests((cur) => cur.map((p) => (p.id === protestId ? { ...p, ...patch } : p)));
  }

  async function handlePlanChange(userId: string, plan: PlanValue) {
    const target = users.find((u) => u.id === userId);
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, plan } : u)));
    try {
      await updateUserPlan(userId, plan, {
        targetEmail: target?.email,
        previousPlan: target?.plan,
      });
      toast.success("Plan updated.");
      refreshAuditLog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update plan.");
    }
  }

  async function handleToggleAdmin(userId: string, makeAdmin: boolean) {
    const target = users.find((u) => u.id === userId);
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, isAdmin: makeAdmin } : u)));
    try {
      await updateUserAdminStatus(userId, makeAdmin, { targetEmail: target?.email });
      toast.success(makeAdmin ? "User is now an admin." : "Admin access removed.");
      refreshAuditLog();
    } catch (err) {
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, isAdmin: !makeAdmin } : u)));
      toast.error(err instanceof Error ? err.message : "Could not update admin status.");
    }
  }

  async function handleDeleteUser(userId: string) {
    if (
      !window.confirm(
        "Delete this user? This removes their account, properties, and profile permanently.",
      )
    ) {
      return;
    }
    try {
      await deleteUserAccount(userId);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      toast.success("User deleted.");
      refreshAuditLog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete user.");
    }
  }

  // Sequential (not Promise.all), same reasoning as BulkInviteForm's send
  // loop — one failure's error stays attributable to its own user instead of
  // racing every delete at once, and a partial failure still deletes
  // everyone it got through rather than rolling back on the first error.
  async function handleBulkDeleteUsers() {
    const ids = [...selectedUserIds];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} user${ids.length === 1 ? "" : "s"}? This removes their accounts, properties, and profiles permanently.`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    const succeededIds = new Set<string>();
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await deleteUserAccount(id);
        succeededIds.add(id);
      } catch (err) {
        const email = users.find((u) => u.id === id)?.email ?? id;
        failures.push(`${email} — ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    setUsers((prev) => prev.filter((u) => !succeededIds.has(u.id)));
    setSelectedUserIds(new Set());
    setBulkDeleting(false);
    refreshAuditLog();
    if (failures.length === 0) {
      toast.success(`${succeededIds.size} user${succeededIds.size === 1 ? "" : "s"} deleted.`);
    } else if (succeededIds.size > 0) {
      toast.error(
        `${succeededIds.size} deleted, ${failures.length} failed: ${failures.join("; ")}`,
      );
    } else {
      toast.error(`Could not delete: ${failures.join("; ")}`);
    }
  }

  async function handleDeleteInvited(id: string) {
    if (!window.confirm("Delete this pending invite?")) return;
    try {
      await deleteInvitedUser(id);
      setInvitedUsers((prev) => prev.filter((i) => i.id !== id));
      toast.success("Invite deleted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete this invite.");
    }
  }

  // Same sequential-delete reasoning as handleBulkDeleteUsers above.
  async function handleBulkDeleteInvited() {
    const ids = [...selectedInvitedIds];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} invite${ids.length === 1 ? "" : "s"}? This can't be undone.`,
      )
    ) {
      return;
    }
    setBulkDeletingInvited(true);
    const succeededIds = new Set<string>();
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await deleteInvitedUser(id);
        succeededIds.add(id);
      } catch (err) {
        const email = invitedUsers.find((i) => i.id === id)?.email ?? id;
        failures.push(`${email} — ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    setInvitedUsers((prev) => prev.filter((i) => !succeededIds.has(i.id)));
    setSelectedInvitedIds(new Set());
    setBulkDeletingInvited(false);
    if (failures.length === 0) {
      toast.success(`${succeededIds.size} invite${succeededIds.size === 1 ? "" : "s"} deleted.`);
    } else if (succeededIds.size > 0) {
      toast.error(
        `${succeededIds.size} deleted, ${failures.length} failed: ${failures.join("; ")}`,
      );
    } else {
      toast.error(`Could not delete: ${failures.join("; ")}`);
    }
  }

  // Opens a new tab signed in as the target user via a real one-time Supabase
  // login link — this tab's own admin session is untouched. window.open() is
  // called synchronously in the click handler (before the await resolves) to
  // get a real user-gesture-backed tab handle, then navigated once the real
  // link comes back — most browsers block a popup opened from inside an async
  // callback, since by then it no longer looks like a direct response to the
  // click.
  async function handleImpersonateUser(userId: string) {
    // "noopener" here would make window.open() return null (that's the spec'd
    // behavior — it's what severs the opener link), which is exactly why this
    // silently failed: the code fell into the "no tab" fallback and tried to
    // open a SECOND tab after the await below, which browsers block as a
    // non-gesture popup. Keep the real reference instead, and get the same
    // opener-severing protection by nulling tab.opener manually right after —
    // that works because we still hold the reference at this point, before
    // the tab has navigated anywhere.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const actionLink = await impersonateUser(userId);
      if (tab) tab.location.href = actionLink;
      else window.open(actionLink, "_blank", "noopener,noreferrer");
      refreshAuditLog();
    } catch (err) {
      tab?.close();
      toast.error(err instanceof Error ? err.message : "Could not log in as this user.");
    }
  }

  if (loading || !user || !isAdmin) return null;

  // Same real `users` list, just three different views onto it — not a
  // separate fetch. "Owner Managed"/"Corvus Managed" split on the same real
  // per-property monthly plan values Stripe checkout writes (see the
  // profiles_plan_check constraint in schema.sql); "Admins" is whoever
  // actually has is_admin set, independent of plan.
  const ownerManagedUsers = users.filter((u) => u.plan === "owner_managed");
  const corvusManagedUsers = users.filter((u) => u.plan === "corvusrf_managed");
  const adminUsers = users.filter((u) => u.isAdmin);

  // Shared by the "Users" tab and the three filtered plan/role tabs below —
  // same select-all/bulk-delete/row-list markup, just handed a different
  // slice of the same `users` state, so there's one real implementation of
  // this instead of four that could drift. selectedUserIds/bulkDeleting
  // stay lifted in the parent (not reset per-tab) so a selection made in one
  // filtered view survives switching tabs, and handleBulkDeleteUsers already
  // just deletes by id regardless of which view is currently showing.
  function renderUserRows(records: AdminUserRecord[]) {
    const selectableIds = records.filter((u) => u.id !== user!.id).map((u) => u.id);
    return (
      <>
        {!usersLoading && records.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={
                  selectableIds.length > 0 && selectableIds.every((id) => selectedUserIds.has(id))
                }
                onChange={(e) =>
                  setSelectedUserIds((prev) => {
                    if (!e.target.checked) {
                      const next = new Set(prev);
                      for (const id of selectableIds) next.delete(id);
                      return next;
                    }
                    return new Set([...prev, ...selectableIds]);
                  })
                }
              />
              Select all
            </label>
            {selectedUserIds.size > 0 && (
              <>
                <span className="text-muted-foreground">{selectedUserIds.size} selected</span>
                <button
                  type="button"
                  onClick={handleBulkDeleteUsers}
                  disabled={bulkDeleting}
                  className="btn-outline text-xs text-destructive disabled:opacity-60"
                >
                  {bulkDeleting
                    ? "Deleting…"
                    : `Delete ${selectedUserIds.size} User${selectedUserIds.size === 1 ? "" : "s"}`}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedUserIds(new Set())}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear selection
                </button>
              </>
            )}
          </div>
        )}

        <div className="mt-4 grid gap-4">
          {usersLoading ? (
            <>
              <UserRowSkeleton />
              <UserRowSkeleton />
              <UserRowSkeleton />
            </>
          ) : records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users in this view yet.</p>
          ) : (
            records.map((u, i) => (
              <UserRow
                key={u.id}
                record={u}
                isSelf={u.id === user!.id}
                selected={selectedUserIds.has(u.id)}
                onToggleSelect={() =>
                  setSelectedUserIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(u.id)) next.delete(u.id);
                    else next.add(u.id);
                    return next;
                  })
                }
                expanded={expandedId === u.id}
                onToggleExpand={() => setExpandedId(expandedId === u.id ? null : u.id)}
                onPlanChange={(plan) => handlePlanChange(u.id, plan)}
                onToggleAdmin={(makeAdmin) => handleToggleAdmin(u.id, makeAdmin)}
                onDelete={() => handleDeleteUser(u.id)}
                onImpersonate={() => handleImpersonateUser(u.id)}
                delayMs={Math.min(i * 40, 320)}
                protests={protests.filter((p) => p.userId === u.id)}
                protestsLoading={protestsLoading}
                expandedProtestId={expandedProtestId}
                onToggleExpandProtest={(protestId) =>
                  setExpandedProtestId(expandedProtestId === protestId ? null : protestId)
                }
                onProtestStatusChange={handleProtestStatusChange}
                onProtestNotesChange={handleProtestNotesChange}
                onOpenCase={setCaseRecord}
              />
            ))
          )}
        </div>
      </>
    );
  }

  const TABS: { key: AdminTab; label: string; count: number | null }[] = [
    { key: "users", label: "Users", count: usersLoading ? null : users.length },
    {
      key: "owner_managed",
      label: "Owner Managed",
      count: usersLoading ? null : ownerManagedUsers.length,
    },
    {
      key: "corvus_managed",
      label: "Corvus Managed",
      count: usersLoading ? null : corvusManagedUsers.length,
    },
    { key: "admins", label: "Admins", count: usersLoading ? null : adminUsers.length },
    {
      key: "invited",
      label: "Invited Users",
      count: invitedUsersLoading ? null : invitedUsers.length,
    },
    { key: "beta", label: "Beta Signups", count: betaLeadsLoading ? null : betaLeads.length },
    { key: "activity", label: "Activity Log", count: auditLogLoading ? null : auditLog.length },
  ];

  return (
    <div className="container-page py-10">
      <span className="badge-soft">Admin</span>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Admin</h1>
      <p className="text-muted-foreground">
        Users, protest requests, beta signups, and staff activity.
      </p>

      <div className="mt-6 flex items-center justify-between gap-2 border-b border-border">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {tab.count != null && (
                <span className="ml-1.5 text-xs opacity-70">({tab.count})</span>
              )}
            </button>
          ))}
        </div>
        {/* Nothing on this page updates live — this is the only way to see
            anything submitted/changed after the page first loaded without a
            full reload. */}
        <button type="button" onClick={refreshAll} className="btn-outline mb-2 shrink-0 text-xs">
          Refresh
        </button>
      </div>

      {activeTab === "users" && (
        <div className="mt-8">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-serif text-xl font-semibold">Users</h2>
            {!usersLoading && (
              <span className="badge-soft">
                {users.length} total user{users.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Manage every user, their properties, and their plan.
          </p>

          <div className="mt-6 grid gap-3">
            <AddUserForm onSent={refreshAll} />
            <BulkInviteForm onSent={refreshAll} />
          </div>

          {usersError && <p className="mt-4 text-sm text-destructive">{usersError}</p>}

          {renderUserRows(users)}
        </div>
      )}

      {activeTab === "owner_managed" && (
        <div className="mt-8">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-serif text-xl font-semibold">Owner Managed</h2>
            {!usersLoading && (
              <span className="badge-soft">
                {ownerManagedUsers.length} user{ownerManagedUsers.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Self-filing customers on the Owner Managed plan.
          </p>
          {renderUserRows(ownerManagedUsers)}
        </div>
      )}

      {activeTab === "corvus_managed" && (
        <div className="mt-8">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-serif text-xl font-semibold">Corvus Managed</h2>
            {!usersLoading && (
              <span className="badge-soft">
                {corvusManagedUsers.length} user{corvusManagedUsers.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Customers on the CorvusPT Managed plan, filed on their behalf.
          </p>
          {renderUserRows(corvusManagedUsers)}
        </div>
      )}

      {activeTab === "admins" && (
        <div className="mt-8">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-serif text-xl font-semibold">Admins</h2>
            {!usersLoading && (
              <span className="badge-soft">
                {adminUsers.length} admin{adminUsers.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Staff accounts with admin-panel access, regardless of plan.
          </p>
          {renderUserRows(adminUsers)}
        </div>
      )}

      {activeTab === "invited" && (
        <section className="mt-8">
          <h2 className="font-serif text-xl font-semibold">Invited Users</h2>
          <p className="text-sm text-muted-foreground">
            Sent a sign-up link, haven't finished creating their account yet — no account exists for
            anyone here. Drops off this list automatically the moment they actually sign up.
          </p>
          {!invitedUsersLoading && invitedUsers.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={
                    invitedUsers.length > 0 &&
                    invitedUsers.every((i) => selectedInvitedIds.has(i.id))
                  }
                  onChange={(e) =>
                    setSelectedInvitedIds(
                      e.target.checked ? new Set(invitedUsers.map((i) => i.id)) : new Set(),
                    )
                  }
                />
                Select all
              </label>
              {selectedInvitedIds.size > 0 && (
                <>
                  <span className="text-muted-foreground">{selectedInvitedIds.size} selected</span>
                  <button
                    type="button"
                    onClick={handleBulkDeleteInvited}
                    disabled={bulkDeletingInvited}
                    className="btn-outline text-xs text-destructive disabled:opacity-60"
                  >
                    {bulkDeletingInvited
                      ? "Deleting…"
                      : `Delete ${selectedInvitedIds.size} Invite${selectedInvitedIds.size === 1 ? "" : "s"}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedInvitedIds(new Set())}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Clear selection
                  </button>
                </>
              )}
            </div>
          )}

          <div className="mt-4 grid gap-2">
            {invitedUsersLoading ? (
              <PropertyRowSkeleton />
            ) : invitedUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invites.</p>
            ) : (
              invitedUsers.map((invite) => (
                <InvitedUserRow
                  key={invite.id}
                  invite={invite}
                  onResent={refreshAll}
                  onDelete={() => handleDeleteInvited(invite.id)}
                  selected={selectedInvitedIds.has(invite.id)}
                  onToggleSelect={() =>
                    setSelectedInvitedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(invite.id)) next.delete(invite.id);
                      else next.add(invite.id);
                      return next;
                    })
                  }
                />
              ))
            )}
          </div>
        </section>
      )}

      {activeTab === "beta" && (
        <section className="mt-8">
          <h2 className="font-serif text-xl font-semibold">Beta Signups</h2>
          <p className="text-sm text-muted-foreground">
            Everyone who submitted the "Request Beta Access" form on the hub site. Most recent
            first.
          </p>
          <div className="mt-4 grid gap-2">
            {betaLeadsLoading ? (
              <PropertyRowSkeleton />
            ) : betaLeads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No beta signups yet.</p>
            ) : (
              betaLeads.map((lead) => (
                <BetaLeadRow
                  key={lead.id}
                  lead={lead}
                  onInvited={(id, invitedAt) =>
                    setBetaLeads((prev) => prev.map((l) => (l.id === id ? { ...l, invitedAt } : l)))
                  }
                  onDeleted={(id) => setBetaLeads((prev) => prev.filter((l) => l.id !== id))}
                />
              ))
            )}
          </div>
        </section>
      )}

      {activeTab === "activity" && (
        <section className="mt-8">
          <h2 className="font-serif text-xl font-semibold">Activity Log</h2>
          <p className="text-sm text-muted-foreground">
            Who on staff did what — plan changes, admin access, invites, deletions, and protest
            edits. Most recent 50.
          </p>
          <div className="mt-4 grid gap-2">
            {auditLogLoading ? (
              <PropertyRowSkeleton />
            ) : auditLog.length === 0 ? (
              <p className="text-sm text-muted-foreground">No admin activity logged yet.</p>
            ) : (
              auditLog.map((entry) => <AuditLogRow key={entry.id} entry={entry} />)
            )}
          </div>
        </section>
      )}

      {caseRecord && (
        <AdminCaseProgressModal
          userId={caseRecord.userId}
          protest={toProtestRecord(caseRecord)}
          property={toPropertyRecordStub(caseRecord)}
          onUpdate={(patch) => handleCaseProgressUpdate(caseRecord.id, patch)}
          onClose={() => setCaseRecord(null)}
        />
      )}
    </div>
  );
}

function AddUserForm({ onSent }: { onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [wantsBeta, setWantsBeta] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createUserAccount({ email, firstName, lastName, wantsBeta });
      onSent();
      toast.success("Invite sent — no account created until they sign up.");
      setOpen(false);
      setEmail("");
      setFirstName("");
      setLastName("");
      setWantsBeta(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the invite.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-primary btn-primary-hover w-fit">
        Invite User
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card-elev p-6 grid gap-4 sm:grid-cols-2 max-w-2xl">
      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          First Name<span className="text-destructive"> *</span>
        </span>
        <input
          required
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          className="w-full min-w-0 rounded-md border border-input bg-background px-3 py-2"
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">
          Last Name<span className="text-destructive"> *</span>
        </span>
        <input
          required
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          className="w-full min-w-0 rounded-md border border-input bg-background px-3 py-2"
        />
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        <span className="font-medium">
          Email<span className="text-destructive"> *</span>
        </span>
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2"
        />
      </label>
      <label className="sm:col-span-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={wantsBeta}
          onChange={(e) => setWantsBeta(e.target.checked)}
        />
        Grant beta access (free, full access)
      </label>
      <p className="sm:col-span-2 text-xs text-muted-foreground">
        We'll email them a real sign-up link — no account is created until they actually finish
        signing up themselves, with their own password or Google.
      </p>
      {error && <p className="sm:col-span-2 text-sm text-destructive">{error}</p>}
      <div className="sm:col-span-2 flex gap-2">
        <button disabled={submitting} className="btn-primary btn-primary-hover disabled:opacity-60">
          {submitting ? "Sending…" : "Send Invite"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-outline">
          Cancel
        </button>
      </div>
    </form>
  );
}

// Loose enough to pull a real address out of whatever separator the admin's
// paste used — newline, space, comma, semicolon, tab, or just run together —
// without requiring any particular one. Anything before/after that doesn't
// match isn't a real address and is silently dropped rather than guessed at.
const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function parseEmails(raw: string): string[] {
  const found = raw.match(EMAIL_TOKEN) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of found) {
    const lower = e.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

type BulkResult = { email: string; ok: boolean; detail: string };

// Paste-a-blob-of-addresses alternative to AddUserForm above, for inviting
// many people at once (e.g. a batch of beta-access approvals) without one
// form submission per person. Same real createUserAccount/admin-create-user
// path as a single invite — just looped, sequentially (not Promise.all) so
// one failure's error message stays attributable to its own address instead
// of racing every send at once against Supabase.
function BulkInviteForm({ onSent }: { onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [wantsBeta, setWantsBeta] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<BulkResult[] | null>(null);

  const parsed = parseEmails(raw);

  async function onSend() {
    if (parsed.length === 0) return;
    setSending(true);
    setResults(null);
    const outcomes: BulkResult[] = [];
    for (const email of parsed) {
      try {
        await createUserAccount({ email, firstName: "", lastName: "", wantsBeta });
        outcomes.push({ email, ok: true, detail: "Invite sent" });
      } catch (err) {
        outcomes.push({
          email,
          ok: false,
          detail: err instanceof Error ? err.message : "Failed",
        });
      }
    }
    setResults(outcomes);
    setSending(false);
    const successEmails = new Set(outcomes.filter((o) => o.ok).map((o) => o.email));
    if (successEmails.size > 0) onSent();
    const failCount = outcomes.length - successEmails.size;
    if (successEmails.size > 0 && failCount === 0) {
      toast.success(
        `Invitations sent to ${successEmails.size} address${successEmails.size === 1 ? "" : "es"}.`,
      );
    } else if (successEmails.size > 0) {
      toast.success(`${successEmails.size} sent, ${failCount} failed — see details below.`);
    } else {
      toast.error("No invites sent — see details below.");
    }
  }

  function reset() {
    setOpen(false);
    setRaw("");
    setResults(null);
  }

  // Starts a genuinely new batch after a completed send — clears the sent
  // list/results so there's nothing left to accidentally resend, distinct
  // from reset() (which closes the whole form).
  function inviteMore() {
    setRaw("");
    setResults(null);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-outline w-fit">
        Bulk Invite
      </button>
    );
  }

  // Once a send has actually completed, this is a distinct confirmation
  // screen — not the same form with "Send N Invites" still sitting there
  // re-armed. Re-showing the live send form after a real send let an admin
  // click it again on the exact same list and re-send every invite a
  // second time (a real, reported duplicate-email incident) — the only way
  // back to a sendable form now is the explicit "Invite More" action below,
  // which starts a genuinely new, empty batch.
  if (results) {
    const successCount = results.filter((r) => r.ok).length;
    const failCount = results.length - successCount;
    return (
      <div className="card-elev p-6 grid gap-4 max-w-2xl">
        <div>
          <p className="font-medium text-sm">
            {successCount > 0
              ? `Invitations sent to ${successCount} address${successCount === 1 ? "" : "es"}.`
              : "No invites were sent."}
          </p>
          {failCount > 0 && (
            <p className="mt-1 text-xs text-destructive">
              {failCount} address{failCount === 1 ? "" : "es"} failed — see details below.
            </p>
          )}
        </div>

        <div className="grid gap-1 text-xs max-h-48 overflow-y-auto rounded-md border border-border p-3">
          {results.map((r) => (
            <div key={r.email} className={r.ok ? "text-success" : "text-destructive"}>
              {r.ok ? "✓" : "✕"} {r.email} — {r.detail}
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={inviteMore} className="btn-outline">
            Invite More
          </button>
          <button type="button" onClick={reset} className="btn-primary btn-primary-hover">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card-elev p-6 grid gap-4 max-w-2xl">
      <div>
        <span className="font-medium text-sm">Paste email addresses</span>
        <p className="text-xs text-muted-foreground">
          One per line, or separated by spaces, commas, or semicolons — any mix is fine. Anything
          that isn't a real address is ignored.
        </p>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={6}
          placeholder={"jane@example.com\njohn@example.com, sam@example.com"}
          className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={wantsBeta}
          onChange={(e) => setWantsBeta(e.target.checked)}
        />
        Grant beta access (free, full access) to everyone invited here
      </label>

      <p className="text-xs text-muted-foreground">
        {parsed.length === 0
          ? "No valid addresses found yet."
          : `${parsed.length} address${parsed.length === 1 ? "" : "es"} recognized.`}
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSend}
          disabled={sending || parsed.length === 0}
          className="btn-primary btn-primary-hover disabled:opacity-60"
        >
          {sending
            ? "Sending…"
            : `Send ${parsed.length || ""} Invite${parsed.length === 1 ? "" : "s"}`}
        </button>
        <button type="button" onClick={reset} className="btn-outline">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Groups by the protest's own filing year (AdminProtestRecord.protestFilingYear —
// see the field's doc comment in src/lib/admin.ts for why that's not the same as
// the property's current tax_year), newest year first, with an "unknown" bucket
// for pre-tax_year-column requests trailing at the end. Within a group, requests
// stay in listAllProtests()'s own order (requested_at descending).
function groupProtestsByYear(
  protests: AdminProtestRecord[],
): { year: number | null; records: AdminProtestRecord[] }[] {
  const byYear = new Map<number | null, AdminProtestRecord[]>();
  for (const p of protests) {
    const year = p.protestFilingYear;
    const bucket = byYear.get(year);
    if (bucket) bucket.push(p);
    else byYear.set(year, [p]);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    })
    .map(([year, records]) => ({ year, records }));
}

function ProtestRow({
  record,
  requesterEmail,
  expanded,
  onToggleExpand,
  onStatusChange,
  onNotesChange,
  onOpenCase,
  delayMs = 0,
}: {
  record: AdminProtestRecord;
  requesterEmail: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onStatusChange: (status: ProtestStatus) => void;
  onNotesChange: (notes: string) => Promise<void>;
  onOpenCase: () => void;
  delayMs?: number;
}) {
  const [notes, setNotes] = useState(record.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [documents, setDocuments] = useState<AdminDocumentRecord[] | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CaseSummaryResult | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    setNotes(record.notes ?? "");
  }, [record.notes]);

  useEffect(() => {
    if (!expanded || documents !== null) return;
    listDocumentsForProperty(record.propertyId)
      .then(setDocuments)
      .catch((err) =>
        setDocsError(err instanceof Error ? err.message : "Could not load documents."),
      );
  }, [expanded, documents, record.propertyId]);

  async function handleSaveNotes() {
    setSavingNotes(true);
    try {
      await onNotesChange(notes);
      toast.success("Notes saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save notes.");
    } finally {
      setSavingNotes(false);
    }
  }

  async function handleAiSummary() {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const statusLabel =
        PROTEST_STATUS_OPTIONS.find((o) => o.value === record.status)?.label ?? record.status;
      const propertyContext = [
        record.propertyAddress ?? "(property removed)",
        record.propertyCad && `CAD: ${record.propertyCad}`,
        record.accountNumber && `Account #: ${record.accountNumber}`,
        record.taxYear && `Tax year: ${record.taxYear}`,
        record.totalValue != null && `Total value: ${currency(record.totalValue)}`,
        record.landValue != null && `Land value: ${currency(record.landValue)}`,
        record.improvementValue != null &&
          `Improvement value: ${currency(record.improvementValue)}`,
        record.protestDeadline && `Protest deadline: ${record.protestDeadline}`,
      ]
        .filter(Boolean)
        .join("\n");
      const protestContext = [
        `Status: ${statusLabel}`,
        `Requested: ${new Date(record.requestedAt).toLocaleDateString()}`,
        `Requester: ${requesterEmail}`,
        notes.trim() && `Staff notes: ${notes.trim()}`,
      ]
        .filter(Boolean)
        .join("\n");
      const documentsContext = documents?.length
        ? documents
            .map(
              (d) =>
                `- ${d.fileName} (${d.documentType ?? "unknown type"}), uploaded ${new Date(d.uploadedAt).toLocaleDateString()}`,
            )
            .join("\n")
        : "(none uploaded)";
      const result = await getCaseSummary({ propertyContext, protestContext, documentsContext });
      setSummary(result);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Could not generate summary.");
    } finally {
      setSummaryLoading(false);
    }
  }

  return (
    <div className="card-elev row-hover p-4" style={{ animationDelay: `${delayMs}ms` }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="font-medium">{record.propertyAddress ?? "Property removed"}</div>
          <div className="text-xs text-muted-foreground">
            {requesterEmail} • Requested {new Date(record.requestedAt).toLocaleDateString()}
            {record.protestDeadline && ` • Deadline ${record.protestDeadline}`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={record.status}
            onChange={(e) => onStatusChange(e.target.value as ProtestStatus)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {PROTEST_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button onClick={onToggleExpand} className="btn-outline text-sm">
            {expanded ? "Hide details" : "View details"}
          </button>
          <button onClick={onOpenCase} className="btn-outline text-sm">
            Case Progress
          </button>
        </div>
      </div>

      {/* CSS grid-rows collapse: the wrapper's row size animates between 0fr
          and 1fr instead of the content mounting/unmounting instantly, so
          both opening AND closing are smooth. Content stays mounted (the
          lazy document fetch above is still gated on `expanded` itself, not
          on JSX mount) and is just clipped to zero height when collapsed. */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
        aria-hidden={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-4 border-t border-border pt-4 grid gap-4">
            <div className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
              {record.propertyCad && <div>CAD: {record.propertyCad}</div>}
              {record.accountNumber && (
                <div className="inline-flex items-center gap-1">
                  Account #: {record.accountNumber}
                  <CopyButton value={record.accountNumber} label="Account number copied" />
                </div>
              )}
              {record.taxYear && <div>Tax year: {record.taxYear}</div>}
              {record.totalValue != null && <div>Total value: {currency(record.totalValue)}</div>}
            </div>

            <div>
              <div className="text-sm font-medium mb-1">Documents</div>
              {docsError ? (
                <p className="text-sm text-destructive">{docsError}</p>
              ) : documents === null ? (
                <Skeleton className="h-4 w-40" />
              ) : documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No documents uploaded.</p>
              ) : (
                <ul className="text-sm text-muted-foreground grid gap-1">
                  {documents.map((d) => (
                    <li key={d.id}>
                      {d.fileName} — {d.documentType ?? "unknown type"} •{" "}
                      {new Date(d.uploadedAt).toLocaleDateString()}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="text-sm font-medium mb-1">Staff Notes</div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="Internal notes about this case…"
              />
              <button
                onClick={handleSaveNotes}
                disabled={savingNotes}
                className="btn-outline text-sm mt-2 disabled:opacity-60"
              >
                {savingNotes ? "Saving…" : "Save Notes"}
              </button>
            </div>

            <div>
              <button
                onClick={handleAiSummary}
                disabled={summaryLoading}
                className="btn-primary btn-primary-hover text-sm disabled:opacity-60"
              >
                {summaryLoading ? "Generating…" : "AI Case Summary"}
              </button>
              {summaryError && <p className="mt-2 text-sm text-destructive">{summaryError}</p>}
              {summary && (
                <div className="mt-3 rounded-md bg-secondary/50 p-3 text-sm grid gap-2">
                  <p>{summary.summary}</p>
                  {summary.nextAction && (
                    <p>
                      <span className="font-medium">Next action:</span> {summary.nextAction}
                    </p>
                  )}
                  {summary.evidenceGaps.length > 0 && (
                    <div>
                      <span className="font-medium">Evidence gaps:</span>
                      <ul className="list-disc list-inside">
                        {summary.evidenceGaps.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UserRow({
  record,
  isSelf,
  selected,
  onToggleSelect,
  expanded,
  onToggleExpand,
  onPlanChange,
  onToggleAdmin,
  onDelete,
  onImpersonate,
  delayMs = 0,
  protests,
  protestsLoading,
  expandedProtestId,
  onToggleExpandProtest,
  onProtestStatusChange,
  onProtestNotesChange,
  onOpenCase,
}: {
  record: AdminUserRecord;
  isSelf: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onPlanChange: (plan: PlanValue) => void;
  onToggleAdmin: (makeAdmin: boolean) => void;
  onDelete: () => void;
  onImpersonate: () => void;
  delayMs?: number;
  // Protest requests filed by this specific user — folded into this row's
  // own expanded panel (alongside UserProperties below) rather than a
  // separate top-level "Protest Requests" tab, so the admin page doesn't
  // keep growing as more requests come in; you only see a user's requests
  // when you actually expand that user.
  protests: AdminProtestRecord[];
  protestsLoading: boolean;
  expandedProtestId: string | null;
  onToggleExpandProtest: (protestId: string) => void;
  onProtestStatusChange: (protestId: string, status: ProtestStatus) => void;
  onProtestNotesChange: (protestId: string, notes: string) => Promise<void>;
  onOpenCase: (record: AdminProtestRecord) => void;
}) {
  return (
    <div className="card-elev row-hover p-6" style={{ animationDelay: `${delayMs}ms` }}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          {/* Hidden for yourself — same self-protection as the single-row
              Delete User button below; you can't select your own account
              for bulk delete either. */}
          {!isSelf && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              className="mt-1.5"
              aria-label={`Select ${record.email}`}
            />
          )}
          <div>
            <h3 className="font-serif text-lg font-semibold">
              {record.firstName} {record.lastName}
              {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
              {record.isAdmin && (
                <span className="ml-2 badge-soft text-[10px] align-middle">Admin</span>
              )}
            </h3>
            <p className="text-sm text-muted-foreground">
              {record.email} • {record.phone}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Joined {new Date(record.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={record.plan}
            onChange={(e) => onPlanChange(e.target.value as PlanValue)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {PLAN_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <button onClick={onToggleExpand} className="btn-outline text-sm">
            {expanded ? "Hide details" : "View details"}
            {protests.length > 0 && (
              <span className="ml-1 opacity-70">
                ({protests.length} protest{protests.length === 1 ? "" : "s"})
              </span>
            )}
          </button>
          {/* Hidden for yourself — logging in as your own account is meaningless.
              Shown for other admins too (not just customers), per an explicit
              call that senior staff may need to access a junior admin's account. */}
          {!isSelf && (
            <button onClick={onImpersonate} className="btn-outline text-sm">
              Log in as user
            </button>
          )}
          {/* Hidden for yourself so an admin can't accidentally revoke their own access. */}
          {!isSelf && (
            <button onClick={() => onToggleAdmin(!record.isAdmin)} className="btn-outline text-sm">
              {record.isAdmin ? "Remove Admin" : "Make Admin"}
            </button>
          )}
          {!isSelf && (
            <button onClick={onDelete} className="btn-outline text-sm text-destructive">
              Delete User
            </button>
          )}
        </div>
      </div>
      {/* UserProperties fetches fresh on every mount (no lazy-fetch guard
          like ProtestRow's documents check), so this stays a real
          mount/unmount rather than the always-mounted grid-rows collapse
          used above — that would mean every row fetches on render
          regardless of whether it's expanded. Animates in on expand;
          collapse is instant. */}
      {expanded && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-300">
          <UserProperties userId={record.id} />

          <div className="mt-6">
            <h4 className="text-sm font-semibold text-muted-foreground">Protest Requests</h4>
            {protestsLoading ? (
              <div className="mt-3">
                <PropertyRowSkeleton />
              </div>
            ) : protests.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No protest requests from this user.
              </p>
            ) : (
              <div className="mt-3 grid gap-6">
                {groupProtestsByYear(protests).map((group) => (
                  <div key={group.year ?? "unknown"}>
                    <h5 className="text-xs font-semibold text-muted-foreground">
                      {group.year ? `Tax Year ${group.year}` : "Year not on file"}
                      <span className="ml-2 font-normal">
                        ({group.records.length} request{group.records.length === 1 ? "" : "s"})
                      </span>
                    </h5>
                    <div className="mt-2 grid gap-3">
                      {group.records.map((p, i) => (
                        <ProtestRow
                          key={p.id}
                          record={p}
                          requesterEmail={record.email}
                          expanded={expandedProtestId === p.id}
                          onToggleExpand={() => onToggleExpandProtest(p.id)}
                          onStatusChange={(status) => onProtestStatusChange(p.id, status)}
                          onNotesChange={(notes) => onProtestNotesChange(p.id, notes)}
                          onOpenCase={() => onOpenCase(p)}
                          delayMs={Math.min(i * 40, 320)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UserProperties({ userId }: { userId: string }) {
  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [propsLoading, setPropsLoading] = useState(true);
  const [propsError, setPropsError] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [adding, setAdding] = useState(false);
  // See the matching state in intake.tsx for why this exists — blocks
  // submitting a Google-sourced address before its Place Details upgrade
  // (real street name, not e.g. "Market Pl Blvd") has landed.
  const [resolvingAddress, setResolvingAddress] = useState(false);

  useEffect(() => {
    listProperties(userId)
      .then(setProperties)
      .catch((err) =>
        setPropsError(err instanceof Error ? err.message : "Could not load properties."),
      )
      .finally(() => setPropsLoading(false));
  }, [userId]);

  // Shared by the form's own submit and by picking an address suggestion
  // directly (see onPlaceSelected below) — takes the address as a parameter
  // rather than reading `newAddress` state, since onPlaceSelected already
  // hands over the final, fully-resolved value.
  async function addAddress(addr: string) {
    if (!addr.trim()) return;
    setAdding(true);
    try {
      const created = await addProperty(userId, { address: addr.trim() });
      setProperties((prev) => [created, ...prev.filter((p) => p.id !== created.id)]);
      setNewAddress("");
      toast.success("Property added.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add property.");
    } finally {
      setAdding(false);
    }
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (resolvingAddress) return;
    addAddress(newAddress);
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Remove this property?")) return;
    try {
      await deleteProperty(id);
      setProperties((prev) => prev.filter((p) => p.id !== id));
      toast.success("Property removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove property.");
    }
  }

  return (
    <div className="mt-4 border-t border-border pt-4">
      {propsError && <p className="mb-2 text-sm text-destructive">{propsError}</p>}
      <form onSubmit={handleAdd} className="flex gap-2 mb-3">
        <AddressAutocomplete
          value={newAddress}
          onChange={setNewAddress}
          onResolving={setResolvingAddress}
          onPlaceSelected={addAddress}
          placeholder="Add a property address"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          disabled={adding || resolvingAddress}
          className="btn-outline text-sm disabled:opacity-60"
        >
          {adding ? "Adding…" : resolvingAddress ? "Resolving…" : "Add"}
        </button>
      </form>
      {propsLoading ? (
        <div className="grid gap-2">
          <PropertyRowSkeleton />
          <PropertyRowSkeleton />
        </div>
      ) : properties.length === 0 ? (
        <p className="text-sm text-muted-foreground">No properties.</p>
      ) : (
        <div className="grid gap-2">
          {properties.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-3 py-2 text-sm"
            >
              <div>
                <div className="font-medium">{p.address}</div>
                <div className="text-xs text-muted-foreground">
                  {p.cad} {p.totalValue != null && `• ${currency(p.totalValue)}`}
                </div>
              </div>
              <button
                onClick={() => handleDelete(p.id)}
                className="text-destructive text-xs shrink-0"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UserRowSkeleton() {
  return (
    <div className="card-elev p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="grid gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    </div>
  );
}

function PropertyRowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-3 py-2">
      <div className="grid gap-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-32" />
      </div>
      <Skeleton className="h-3 w-10" />
    </div>
  );
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  create_user: "Invited user",
  delete_user: "Deleted user",
  update_plan: "Changed plan",
  update_admin_status: "Changed admin access",
  update_protest_status: "Updated protest status",
  update_protest_notes: "Updated protest notes",
  impersonate_user: "Logged in as user",
};

function BetaLeadRow({
  lead,
  onInvited,
  onDeleted,
}: {
  lead: BetaLead;
  onInvited: (id: string, invitedAt: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [inviting, setInviting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Same real sign-up-link invite AddUserForm above uses — no account is
  // created here, just a real branded email with a prefilled sign-up link
  // (see createUserAccount in src/lib/admin.ts). Splits the lead's one
  // free-text name into first/last since createUserAccount expects them
  // separately; a single-word name becomes both.
  async function handleInvite() {
    setInviting(true);
    try {
      const [firstName, ...rest] = lead.fullName.trim().split(/\s+/);
      const lastName = rest.join(" ") || firstName;
      // wantsBeta: true — approving a beta-access request should grant the
      // free, full-access beta plan by default, not the paid-tier default.
      await createUserAccount({
        email: lead.workEmail,
        firstName,
        lastName,
        wantsBeta: true,
      });
      const invitedAt = await markBetaLeadInvited(lead.id);
      onInvited(lead.id, invitedAt);
      toast.success(`Invite sent to ${lead.workEmail}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the invite.");
    } finally {
      setInviting(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${lead.fullName}'s beta signup? This can't be undone.`)) return;
    setDeleting(true);
    try {
      await deleteBetaLead(lead.id);
      onDeleted(lead.id);
      toast.success("Beta signup deleted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete this signup.");
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-md bg-secondary/40 px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{lead.fullName}</span>
          <span className="text-muted-foreground"> — {lead.company}</span>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {lead.workEmail}
            <CopyButton value={lead.workEmail} label="Email copied" />
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <div className="text-right text-xs text-muted-foreground">
            {lead.sourceDoor && <div>via {lead.sourceDoor}</div>}
            <div>{new Date(lead.createdAt).toLocaleString()}</div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Always clickable, even after a prior invite — the invited
                account may since have been deleted (a real, clean delete
                on Supabase's side, so the same email can be re-invited
                fine), and there's no reliable way to tell from here
                whether that happened, so this never locks the button out
                on its own say-so. The date is just a hint, not a block. */}
            {lead.invitedAt && (
              <span className="text-xs text-muted-foreground">
                Invited {new Date(lead.invitedAt).toLocaleDateString()}
              </span>
            )}
            <button
              type="button"
              onClick={handleInvite}
              disabled={inviting}
              className="btn-outline text-xs disabled:opacity-60"
            >
              {inviting ? "Inviting…" : lead.invitedAt ? "Re-invite" : "Invite User"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="btn-outline text-xs text-destructive disabled:opacity-60"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
      <div className="mt-1.5 text-xs">
        <span className="font-medium text-muted-foreground">Interested in:</span>{" "}
        {lead.areaOfInterest}
      </div>
      {lead.useCase && <div className="mt-1 text-xs text-muted-foreground">"{lead.useCase}"</div>}
    </div>
  );
}

function InvitedUserRow({
  invite,
  onResent,
  onDelete,
  selected,
  onToggleSelect,
}: {
  invite: InvitedUserRecord;
  onResent: () => void;
  onDelete: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const [resending, setResending] = useState(false);
  const name = [invite.firstName, invite.lastName].filter(Boolean).join(" ");

  async function handleResend() {
    setResending(true);
    try {
      await resendInvite(invite);
      onResent();
      toast.success(`Invite resent to ${invite.email}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resend the invite.");
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="rounded-md bg-secondary/40 px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="mt-0.5"
            aria-label={`Select ${invite.email}`}
          />
          <div className="min-w-0">
            {name && <span className="font-medium">{name}</span>}
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {invite.email}
              <CopyButton value={invite.email} label="Email copied" />
              {invite.wantsBeta && <span className="badge-soft ml-1">Beta</span>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <div className="text-right text-xs text-muted-foreground">
            <div>Invited {new Date(invite.invitedAt).toLocaleDateString()}</div>
            {invite.resendCount > 0 && (
              <div>
                Resent {invite.resendCount}× — last{" "}
                {new Date(invite.lastSentAt).toLocaleDateString()}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleResend}
            disabled={resending}
            className="btn-outline text-xs disabled:opacity-60"
          >
            {resending ? "Sending…" : "Resend Invite"}
          </button>
          <button type="button" onClick={onDelete} className="btn-outline text-xs text-destructive">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function AuditLogRow({ entry }: { entry: AdminAuditEntry }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md bg-secondary/40 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <span className="font-medium">{AUDIT_ACTION_LABELS[entry.action] ?? entry.action}</span>
        {entry.targetEmail && <span className="text-muted-foreground"> — {entry.targetEmail}</span>}
        {entry.detail && <div className="text-xs text-muted-foreground">{entry.detail}</div>}
      </div>
      <div className="shrink-0 text-right text-xs text-muted-foreground">
        <div>{entry.actorEmail}</div>
        <div>{new Date(entry.createdAt).toLocaleString()}</div>
      </div>
    </div>
  );
}
