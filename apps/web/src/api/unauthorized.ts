type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Fired by `unwrap` (client.ts) for every 401 it observes, regardless of
 * which query hit it. `SessionProvider` (auth/session.tsx) is the sole
 * subscriber: it treats this exactly like `/api/auth/me` returning 401 on
 * first load — the session has expired or been revoked, so the visitor is
 * anonymous now, and the protected-route gate in `routes/__root.tsx`
 * redirects to `/login` on its own.
 *
 * This lives in its own module (rather than session.tsx importing client.ts
 * more deeply, or client.ts importing session.tsx) so the two files stay in
 * their existing one-directional dependency shape — client.ts has no
 * knowledge of React or session state, it only ever calls `notifyUnauthorized`.
 *
 * Centralizing this here is what keeps "a 401 means log out, not an error
 * card" a single piece of logic instead of five near-identical checks, one
 * per route that fetches data (Overview, Live, History, Users/Libraries,
 * Settings) — every one of those routes' queries already funnels through
 * `unwrap`, so every one of them gets this for free.
 */
export function notifyUnauthorized(): void {
  for (const listener of listeners) listener();
}

export function subscribeUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
