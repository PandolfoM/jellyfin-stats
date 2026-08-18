import type { LiveSession } from "@jfstats/shared";
import { useEffect, useState } from "react";

import { api, unwrap } from "./client";

export interface UseLiveSessionsResult {
  sessions: LiveSession[];
  connected: boolean;
}

/** The one named event `GET /api/live` ever emits — see apps/server/src/api/routes/live.ts. */
const SESSIONS_EVENT = "sessions";

/**
 * Subscribes to the server's live-sessions feed (`GET /api/live`, Server-Sent
 * Events) and keeps `sessions` in sync with whatever the server last pushed
 * under its `sessions` event. This is the one screen in the app that does
 * not use TanStack Query: SSE is a push stream, not a request the query
 * layer's cache-and-refetch model fits.
 *
 * ## The 401 problem, and why this hook probes `/api/auth/me` on `error`
 *
 * `/api/live` sits behind `requireAdmin` (apps/server/src/api/app.ts), so an
 * expired session gets a 401 at the SSE handshake, before the stream ever
 * opens. Two facts about `EventSource` make that dangerous to ignore:
 *
 * 1. It exposes no HTTP status on its `error` event — there is no way to
 *    tell "the server said 401" apart from "the network blipped" from
 *    inside `onerror` alone.
 * 2. It auto-reconnects on its own, forever, by default.
 *
 * Put together: an expired session does not fail loudly, it becomes a
 * silent, endless reconnect loop behind whatever `sessions` snapshot arrived
 * last — the UI looks exactly as "live" whether the feed has been up for an
 * hour or failing every handshake for one. `requireAdmin` also never
 * re-runs mid-stream (an SSE connection is one long-lived request, checked
 * once at the top), so a session that expires *after* the stream already
 * opened does not close the connection either — both facts confirmed by
 * reading the server route directly.
 *
 * The fix: on every `error` event, this hook makes one request to
 * `GET /api/auth/me` through the existing typed client and `unwrap`. That
 * request funnels through the same 401 pipeline every other query in this
 * app already uses — `unwrap` calls `notifyUnauthorized()` on a 401,
 * `SessionProvider` is the sole subscriber and flips to "anonymous", and the
 * protected-route gate in `routes/__root.tsx` redirects to `/login` — so an
 * expired session is caught the moment `EventSource` next reports trouble,
 * reusing infrastructure this app already trusts instead of inventing a
 * second "the session ended" signal. A transient network drop (the server
 * itself unreachable, not just this one connection) answers the probe with
 * a rejected promise or some other non-401 status; nothing here forces a
 * redirect for that case, `connected` just stays false until `EventSource`'s
 * own retry succeeds and a fresh `open`/`sessions` event arrives.
 *
 * The alternative considered — replacing `EventSource` with `fetch` +
 * `ReadableStream`, which does expose the response status directly — was
 * rejected: it would throw away `EventSource`'s built-in reconnect-with-retry
 * for free, which would then need to be hand-rolled (backoff, connection
 * lifecycle, partial-line buffering for `event:`/`data:` framing). The
 * probe-on-error approach keeps that behavior and adds only the one missing
 * piece — telling a 401 apart from any other kind of trouble.
 *
 * A server-side `event: unauthorized` (suggested by an earlier task) was
 * also considered and rejected: it needs a server change, and — per the
 * mid-stream fact above — still could not catch a session expiring after
 * the stream is already open, since `requireAdmin` never re-evaluates it.
 *
 * ## Why `connected` does not clear `sessions`
 *
 * On `error`, this hook sets `connected` to `false` but leaves `sessions`
 * exactly as it was. Clearing the list on every transient drop would make
 * a healthy connection with an occasional blip look like nothing is
 * playing, which is its own false signal. The route that renders this hook
 * (`routes/live.tsx`) is what turns `connected: false` into a visible
 * "disconnected" state layered over the last-known list — the fix for the
 * "stale data that looks current" failure mode belongs at the UI layer,
 * where there's something a viewer can actually see, not by discarding data
 * this hook has no reason to distrust.
 */
export function useLiveSessions(): UseLiveSessionsResult {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Guards the async probe's state updates below: once this effect's
    // cleanup has run (unmount, or React 18 Strict Mode's mount/unmount/
    // remount cycle), the in-flight `/api/auth/me` request from a prior
    // `error` event must not call `setConnected`/notify anything after the
    // fact.
    let cancelled = false;

    const source = new EventSource("/api/live");

    const handleOpen = (): void => {
      setConnected(true);
    };

    const handleSessions = (event: Event): void => {
      const raw = (event as MessageEvent<string>).data;
      let parsed: LiveSession[];
      try {
        parsed = JSON.parse(raw) as LiveSession[];
      } catch {
        // A malformed payload is not "connected with good data" — leave
        // both `sessions` and `connected` exactly as they were rather than
        // replacing a good list with nothing, or claiming a bad message
        // means the feed is live.
        return;
      }
      setSessions(parsed);
      setConnected(true);
    };

    const handleError = (): void => {
      setConnected(false);

      // See the doc comment above for why this specific request. `unwrap`
      // itself calls `notifyUnauthorized()` on a 401 — this handler does not
      // need to inspect the status or redirect itself, only trigger the probe.
      void api.api.auth.me.$get().then(
        (response) => {
          if (cancelled) return;
          void unwrap(response).catch(() => {
            // A non-401 failure (e.g. a 500) here is not this hook's
            // concern — that's an ordinary server-is-broken condition
            // SessionProvider's own bootstrap already surfaces elsewhere.
            // This probe exists only to catch the 401 case, which `unwrap`
            // has already reported via `notifyUnauthorized` by this point.
          });
        },
        () => {
          // The probe itself couldn't reach the server — an ordinary
          // network drop, not an auth problem. `connected` stays false;
          // EventSource's own retry will fire another `error` (and another
          // probe) until either the stream or this probe succeeds.
        },
      );
    };

    source.addEventListener("open", handleOpen);
    source.addEventListener(SESSIONS_EVENT, handleSessions);
    source.addEventListener("error", handleError);

    return () => {
      cancelled = true;
      source.removeEventListener("open", handleOpen);
      source.removeEventListener(SESSIONS_EVENT, handleSessions);
      source.removeEventListener("error", handleError);
      // The operationally important line: an EventSource left open past
      // unmount holds a Redis subscriber open server-side (see
      // apps/server/src/api/routes/live.ts) for as long as the tab stays
      // open, even after navigating away from /live.
      source.close();
    };
  }, []);

  return { sessions, connected };
}
