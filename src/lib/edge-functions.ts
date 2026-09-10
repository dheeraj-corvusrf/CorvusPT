import { supabase } from "./supabase";

const MAX_RETRIES_429 = 2;
const BASE_DELAY_MS = 800;

// A 504 (see below) gets more attempts and near-zero delay between them — it's
// not a quota to back off from like 429, it's "that one connection to Gemini
// was slow, try a fresh one now." Live testing while chasing the "modules
// spin forever" report found Gemini genuinely dropping ~2 of every 3 calls
// into a 20s+ stall during a congested stretch; MAX_RETRIES_429's 2 retries
// (3 attempts, ~70% odds of at least one landing) left a real chance of still
// surfacing an error to the user during exactly that kind of stretch. 4
// retries (5 attempts) pushes the odds to ~87% at that same failure rate,
// while every individual attempt still fails fast (20s) instead of hanging.
const MAX_RETRIES_504 = 4;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// supabase-js's default error.message on a non-2xx Edge Function response is a
// generic "non-2xx status code" string — the function's actual { error: "..." }
// reason lives in the response body, which this pulls out so callers can show it.
//
// Every AI-backed function forwards Gemini's 429 as-is (see e.g. the `res.status
// === 429` check in ai-report-modules/index.ts) rather than absorbing it, since
// it's a transient "try again shortly" condition, not a real failure — so this
// retries those with exponential backoff before surfacing an error. Any other
// status fails immediately; retrying those wouldn't help.
//
// 504 is the other retryable case — every AI-backed function now times out its
// own Gemini call at 20s (see GEMINI_TIMEOUT_MS in ai-health-score/index.ts and
// ai-report-modules/index.ts) rather than hanging indefinitely, which is what
// used to surface as a module spinning on "Analyzing" forever with no way out.
// A 504 means Gemini was slow/congested that one time, not that the request is
// bad — see MAX_RETRIES_504 above for why it gets its own, more generous budget.
export async function invokeEdgeFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  let refreshedOn401 = false;

  for (let attempt = 0; ; attempt++) {
    // supabase-js keeps the Functions client's auth token in sync only via
    // auth events (TOKEN_REFRESHED / SIGNED_IN). If a scheduled refresh was
    // missed — the tab was backgrounded or the laptop asleep past the token's
    // 1-hour expiry — that cached token goes stale. Ordinary DB queries
    // self-heal (each re-checks the session), but functions.invoke() does
    // not, so an authenticated call comes back 401 "unauthenticated" even
    // though the user is still signed in. getSession() refreshes an expired
    // session, so read it here and pass the fresh token explicitly.
    let authHeaders: Record<string, string> | undefined;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) authHeaders = { Authorization: `Bearer ${token}` };
    } catch {
      // no session / storage blocked — let the call go out unauthenticated
      // (guest-accessible functions still work; gated ones return their own 401)
    }

    const { data, error } = await supabase.functions.invoke<T>(name, {
      body,
      ...(authHeaders ? { headers: authHeaders } : {}),
    });
    if (!error) return data as T;

    const context = (error as { context?: Response }).context;
    let extractedMessage: string | undefined;
    if (context) {
      try {
        const payload = (await context.clone().json()) as { error?: string };
        extractedMessage = payload?.error;
      } catch {
        // response body wasn't JSON — fall through to the generic error below
      }
    }
    const thrown = extractedMessage ? new Error(extractedMessage) : error;

    // A 401 despite an attached token means the token was rejected server-side
    // (expired between getSession() and the request, or clock skew). Force one
    // real refresh and retry before surfacing "unauthenticated" to the user.
    if (context?.status === 401 && !refreshedOn401) {
      refreshedOn401 = true;
      await supabase.auth.refreshSession().catch(() => {});
      continue;
    }

    if (context?.status === 504) {
      if (attempt >= MAX_RETRIES_504) throw thrown;
      await sleep(Math.random() * 250); // just enough jitter to avoid a thundering herd
      continue;
    }
    if (context?.status !== 429 || attempt >= MAX_RETRIES_429) throw thrown;
    await sleep(BASE_DELAY_MS * 2 ** attempt + Math.random() * 300);
  }
}
