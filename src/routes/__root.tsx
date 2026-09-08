import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { SiteNav, SiteFooter } from "../components/SiteChrome";
import { AuthProvider, useAuth } from "../lib/auth";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { JourneyTracker } from "../components/JourneyTracker";
import { AskAiWidget } from "../components/AskAiWidget";
import { LegalGate } from "../components/LegalGate";
import { AppShell, shouldShowShell } from "../components/AppShell";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "CorvusPT — Texas Property Tax, Powered by AI" },
      {
        name: "description",
        content:
          "AI-powered Texas property tax platform for real property protest, BPP rendition, tax bill tracking, payments, and annual savings.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: `${import.meta.env.BASE_URL}favicon.svg`, type: "image/svg+xml" },
      { rel: "icon", href: `${import.meta.env.BASE_URL}favicon.ico`, type: "image/x-icon" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider delayDuration={200}>
          {/* Keyboard/screen-reader users otherwise have to tab through the
              entire nav (7 links, sign-in/profile menu) on every single page
              before reaching real content — invisible until focused, so
              sighted mouse users never see it. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-foreground focus:shadow-elev"
          >
            Skip to main content
          </a>
          <div className="print:hidden">
            <SiteNav />
          </div>
          <main id="main-content" className="min-h-[70vh]">
            <AppShell>
              <Outlet />
            </AppShell>
          </main>
          <div className="print:hidden">
            <SignedInJourney />
            <SiteFooter />
          </div>
          <AskAiWidget />
          <LegalGate />
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

// Shown at the bottom of every page, but only once auth has resolved to a real
// signed-in user — guests (and the brief loading window before we know) see
// nothing here rather than a flash of a tracker they can't act on.
function SignedInJourney() {
  const { user, loading } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Deliberately narrower than AppShell's own shouldShowShell (which also
  // excludes "/" and "/sign-in", where a signed-in visitor's journey should
  // still show) — an admin's own property journey, if they happen to have
  // one, has no business showing up while they're working the admin panel,
  // a different persona entirely from "my properties."
  const isAdminRoute =
    pathname === "/admin" || pathname.startsWith("/admin/") || pathname === "/admin-login";
  if (loading || !user || isAdminRoute) return null;
  // Matches AppShell's own width/padding scheme (not container-page's
  // centered max-w-80rem) wherever AppShell actually wraps the page above
  // this — otherwise, on a wide viewport, this card sits visibly narrower
  // than the dashboard content it's stacked directly under (container-page
  // caps out and centers with gutters; AppShell's w-full doesn't). Falls
  // back to container-page on the pages AppShell skips ("/", "/sign-in"),
  // which use container-page for their own sections, so this still lines
  // up with THOSE instead.
  return (
    <div
      className={
        shouldShowShell(pathname)
          ? "w-full px-6 sm:px-10 lg:px-16 pt-10 pb-10"
          : "container-page pt-10 pb-10"
      }
    >
      <JourneyTracker />
    </div>
  );
}
