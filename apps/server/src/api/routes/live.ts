import type { LiveSession } from "@jfstats/shared";
import type { Env, Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface LiveDeps {
  /** Resolves once subscribed; the resolved function unsubscribes and closes the connection. */
  subscribe(onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  loadCurrent(): Promise<LiveSession[]>;
}

// Comfortably inside the 30-60s window a typical idle-timeout proxy enforces.
const HEARTBEAT_MS = 25_000;

export function registerLiveRoute<E extends Env>(app: Hono<E>, deps: LiveDeps): void {
  app.get("/api/live", (c) => {
    return streamSSE(c, async (stream) => {
      // Track abort before calling subscribe() at all — registered synchronously,
      // before cb's first await, so it is in place before the caller can possibly
      // have gotten hold of a reader to cancel. subscribe() does a real network
      // round trip in production (SUBSCRIBE over a fresh connection); a client
      // that disconnects while that is still in flight must not leak the
      // duplicated Redis connection it eventually resolves to.
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });

      const unsubscribe = await deps.subscribe((payload) => {
        void stream.writeSSE({ event: "sessions", data: payload });
      });

      if (aborted) {
        // The client is already gone; nothing else has been set up yet
        // (no heartbeat, no second onAbort), so unsubscribing is the only cleanup.
        await unsubscribe();
        return;
      }

      // Idle proxies close a silent connection; a periodic comment keeps it open
      // without dispatching a "message" or named event to the client at all.
      const heartbeat = setInterval(() => {
        void stream.write(":\n\n");
      }, HEARTBEAT_MS);

      stream.onAbort(() => {
        clearInterval(heartbeat);
        void unsubscribe();
      });

      // Send what is playing right now. Without this the page is blank until the
      // worker's next poll, which looks like nothing is playing.
      try {
        await stream.writeSSE({ event: "sessions", data: JSON.stringify(await deps.loadCurrent()) });
      } catch {
        await stream.writeSSE({ event: "sessions", data: "[]" });
      }

      // Hold the handler open until the client disconnects; writeSSE calls above
      // keep pushing data through this same stream in the meantime.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });
}
