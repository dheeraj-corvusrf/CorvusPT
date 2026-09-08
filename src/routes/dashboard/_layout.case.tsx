import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { listProperties, type PropertyRecord } from "@/lib/properties";
import { listProtests, type ProtestRecord } from "@/lib/protests";
import { CaseDetailView } from "@/components/CaseDetailModal";
import { Skeleton } from "@/components/ui/skeleton";

// View Case's own page — previously CaseDetailModal opened as an overlay
// wherever "View Case" was clicked (Properties, the AI Report's case banner,
// Your Protests); it's now a real URL instead, so refreshing, sharing, or
// hitting Back behaves like any other page. propertyId is the only thing a
// caller needs to know — the matching protest is looked up here, the same
// way every prior call site already did it (listProtests + find by
// propertyId), so this page is a self-contained fetch, not a hand-off of
// already-loaded data.
export const Route = createFileRoute("/dashboard/_layout/case")({
  validateSearch: (search: Record<string, unknown>): { propertyId?: string } => ({
    propertyId: typeof search.propertyId === "string" ? search.propertyId : undefined,
  }),
  component: CasePage,
});

function CasePage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { propertyId } = Route.useSearch();
  const [property, setProperty] = useState<PropertyRecord | null>(null);
  const [protest, setProtest] = useState<ProtestRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!user || !propertyId) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    Promise.all([listProperties(user.id), listProtests(user.id)])
      .then(([properties, protests]) => {
        if (cancelled) return;
        const p = properties.find((row) => row.id === propertyId) ?? null;
        const pr = protests.find((row) => row.propertyId === propertyId) ?? null;
        if (!p || !pr) {
          setNotFound(true);
        } else {
          setProperty(p);
          setProtest(pr);
        }
      })
      .catch((err) => {
        console.error("Failed to load case:", err);
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on user.id, NOT the user object — Supabase hands AuthProvider a
    // fresh user object on every background TOKEN_REFRESHED / tab-focus
    // session check, and depending on the object here made this whole page
    // flash back to a skeleton and refetch (remounting CaseDetailView and
    // resetting its transient state) every time the tab regained focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, propertyId]);

  function goToProperties() {
    nav({ to: "/dashboard/properties" });
  }

  if (!propertyId) {
    return (
      <div>
        <p className="text-muted-foreground">No property specified.</p>
        <button onClick={goToProperties} className="btn-outline text-sm mt-4">
          ← Back to Properties
        </button>
      </div>
    );
  }

  if (loading || !user) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-40 w-full mt-4" />
      </div>
    );
  }

  if (notFound || !property || !protest) {
    return (
      <div>
        <p className="text-muted-foreground">
          Couldn't find that case — it may have been removed, or you may not have access to it.
        </p>
        <button onClick={goToProperties} className="btn-outline text-sm mt-4">
          ← Back to Properties
        </button>
      </div>
    );
  }

  return (
    <CaseDetailView
      userId={user.id}
      property={property}
      protest={protest}
      onBack={goToProperties}
    />
  );
}
