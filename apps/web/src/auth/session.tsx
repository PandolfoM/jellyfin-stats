import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { ApiError, api, unwrap } from "../api/client";
import { subscribeUnauthorized } from "../api/unauthorized";

export interface SessionUser {
  userId: string;
  userName: string;
  isAdmin: boolean;
}

/**
 * "error" is deliberately its own state, distinct from "anonymous". A 500 from
 * `/api/auth/me` means the server is broken, not that the user is logged out —
 * showing a login form in that case invites the user to type their password at
 * a service that cannot check it.
 */
export type SessionStatus = "loading" | "authenticated" | "anonymous" | "error";

/**
 * The four outcomes the login endpoint distinguishes, each with a different
 * remedy: fix the password, use an admin account, wait, or go check the
 * Jellyfin server. "unknown_error" covers any other status so login.tsx always
 * has something to render, even for a failure mode the API has never returned.
 */
export type LoginErrorCode =
  | "invalid_credentials"
  | "not_an_administrator"
  | "too_many_attempts"
  | "jellyfin_unavailable"
  | "unknown_error";

export class LoginError extends Error {
  readonly code: LoginErrorCode;

  constructor(code: LoginErrorCode) {
    super(code);
    this.name = "LoginError";
    this.code = code;
  }
}

function mapLoginStatus(status: number): LoginErrorCode {
  switch (status) {
    case 401:
      return "invalid_credentials";
    case 403:
      return "not_an_administrator";
    case 429:
      return "too_many_attempts";
    case 503:
      return "jellyfin_unavailable";
    default:
      return "unknown_error";
  }
}

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
}

export interface SessionContextValue extends SessionState {
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const LOADING_STATE: SessionState = { status: "loading", user: null };
const ANONYMOUS_STATE: SessionState = { status: "anonymous", user: null };

/**
 * Resolves the current session from `GET /api/auth/me`, the single source of
 * truth for who (if anyone) is signed in. A 401 is the ordinary "not signed in
 * yet" state; anything else that isn't a 2xx is a real failure and must not be
 * collapsed into "anonymous".
 */
async function resolveSession(): Promise<SessionState> {
  try {
    // `$get()` itself can reject (server unreachable, DNS failure, offline) —
    // it has to be inside this try too, not just the `unwrap` call below, or
    // a network-level failure escapes as a rejection instead of an "error"
    // state, leaving the caller stuck on "loading" forever.
    const response = await api.api.auth.me.$get();
    const user = await unwrap<SessionUser>(response);
    return { status: "authenticated", user };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return ANONYMOUS_STATE;
    }
    return { status: "error", user: null };
  }
}

/**
 * Posts the login request and, on success, re-resolves the session from
 * `/api/auth/me` rather than trusting the login response body — the client's
 * notion of "who is signed in" always comes from the one source of truth. On
 * failure it throws a `LoginError` carrying which of the API's four failure
 * codes occurred, so the login screen can render a specific remedy instead of
 * a generic "login failed".
 *
 * Checks `response.ok` directly instead of going through `unwrap` — this is
 * deliberate, not an oversight: a wrong password here must never call
 * `notifyUnauthorized`. `login.tsx` holds the resulting `LoginErrorCode` in
 * its own component-local state, and the login form is reachable while
 * already authenticated (a signed-in visitor can navigate to /login). If a
 * mistyped password here flipped the session to "anonymous" the same way a
 * stats/history 401 does, `routes/__root.tsx`'s gate would swap
 * `AppShell > Outlet` for a bare `Outlet` mid-request, remounting `login.tsx`
 * from scratch and discarding the very error message this request exists to
 * show the user.
 */
async function performLogin(
  username: string,
  password: string,
  setState: (state: SessionState) => void,
): Promise<void> {
  const response = await api.api.auth.login.$post({ json: { username, password } });

  if (!response.ok) {
    throw new LoginError(mapLoginStatus(response.status));
  }

  setState(await resolveSession());
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(LOADING_STATE);

  useEffect(() => {
    let cancelled = false;

    void resolveSession().then((next) => {
      if (!cancelled) setState(next);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Covers every query that funnels through `unwrap` (api/client.ts) — today
  // that's the stats and history routes queries.ts calls, and any future
  // route that follows that same `unwrap`-wrapped pattern. A 401 from any of
  // them means the session expired or was revoked after this page already
  // loaded; treating it identically to the bootstrap 401 above — flip to
  // "anonymous", never "error" — is what lets the protected-route gate in
  // routes/__root.tsx redirect to /login on its own, instead of every
  // data-fetching route needing its own 401 check.
  //
  // This does NOT cover every protected request in the app, and a future
  // route cannot assume it does:
  //   - `PosterImage` (components/domain/PosterImage.tsx) renders a plain
  //     `<img src="/api/images/items/...">`. An `<img>` load never goes
  //     through `unwrap` — a 401 there degrades to PosterImage's own
  //     broken-image placeholder, not a redirect.
  //   - The Live screen's SSE connection (api/useLiveSessions.ts) does not
  //     go through `unwrap` either — `EventSource` has no `Response` for
  //     `unwrap` to inspect, and exposes no status code on its own `error`
  //     event. That hook handles the 401 case itself: on every `error` it
  //     probes `GET /api/auth/me` through `unwrap`, which does land back on
  //     this same subscription via `notifyUnauthorized` once the probe finds
  //     a 401. See that hook's doc comment for the full mechanism.
  useEffect(() => subscribeUnauthorized(() => setState(ANONYMOUS_STATE)), []);

  // The password is never stored — it lives only as a parameter here, passed
  // straight into the request body, never assigned to state or a ref.
  const login = useCallback((username: string, password: string): Promise<void> => {
    const attempt = performLogin(username, password, setState);

    // A rejection is only "unhandled" (per Node/V8) if nothing has attached a
    // reaction to *this* promise instance by the time it settles. Callers that
    // fire this and forget it (an onClick that does `void login(...)` without
    // awaiting) would otherwise trip that diagnostic even though rejecting on
    // a bad login is the documented behavior. This no-op catch marks `attempt`
    // handled without swallowing the rejection — it is the same promise
    // instance returned below, so a caller that does `await login(...)` in a
    // try/catch (login.tsx) still observes the rejection independently.
    attempt.catch(() => {});

    return attempt;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.api.auth.logout.$post();
    } catch {
      // The cookie is gone either way (or was never valid); local state must
      // still clear even if the request itself failed to reach the server.
    } finally {
      setState(ANONYMOUS_STATE);
    }
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, login, logout }),
    [state, login, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}
