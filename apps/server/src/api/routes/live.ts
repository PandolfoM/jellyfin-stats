import type { LiveSession } from "@jfstats/shared";
import type { Env, Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface LiveDeps {
  /**
   * Resolves once subscribed; the resolved function unsubscribes and closes the
   * connection. It must not reject: it is invoked from the stream's abort path,
   * where Hono runs subscribers through `forEach` with no error handling and
   * nothing can observe a rejection. createLiveSubscriber (api/app.ts) is where
   * that guarantee is implemented.
   */
  subscribe(onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  loadCurrent(): Promise<LiveSession[]>;
}

/**
 * Ends every SSE stream this route currently holds open.
 *
 * An SSE handler parks until the client disconnects, and `server.close()` does
 * not invoke its callback until every in-flight connection has ended — so
 * without this, one attached dashboard tab makes graceful shutdown hang until
 * the supervisor's grace period expires and SIGKILL lands, with the database and
 * Redis never closed cleanly.
 */
export interface LiveStreamRegistry {
  /** Resolves once every open stream has been ended and unsubscribed. */
  closeAll(): Promise<void>;
  /** Open stream count. Exposed for tests and diagnostics. */
  readonly size: number;
}

// Comfortably inside the 30-60s window a typical idle-timeout proxy enforces.
const HEARTBEAT_MS = 25_000;

export function registerLiveRoute<E extends Env>(app: Hono<E>, deps: LiveDeps): LiveStreamRegistry {
  const openStreams = new Set<() => Promise<void>>();

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
        // (no heartbeat, no registry entry), so unsubscribing is the only cleanup.
        await unsubscribe();
        return;
      }

      // Idle proxies close a silent connection; a periodic comment keeps it open
      // without dispatching a "message" or named event to the client at all.
      const heartbeat = setInterval(() => {
        void stream.write(":\n\n");
      }, HEARTBEAT_MS);

      // Memoized so the two ways out — the client disconnecting, and the server
      // shutting down — run the teardown exactly once between them, and so the
      // shutdown path can await teardown that the abort path started.
      let teardown: Promise<void> | undefined;
      const cleanup = (): Promise<void> =>
        (teardown ??= (async () => {
          clearInterval(heartbeat);
          openStreams.delete(closeStream);
          await unsubscribe();
        })());

      // stream.abort() runs every onAbort subscriber, which is what resolves the
      // hold below and starts cleanup — the same path a real disconnect takes,
      // rather than a second teardown route that could drift from it.
      const closeStream = async (): Promise<void> => {
        stream.abort();
        await cleanup();
      };
      openStreams.add(closeStream);

      stream.onAbort(() => {
        void cleanup();
      });

      // Send what is playing right now. Without this the page is blank until the
      // worker's next poll, which looks like nothing is playing.
      try {
        await stream.writeSSE({ event: "sessions", data: JSON.stringify(await deps.loadCurrent()) });
      } catch {
        await stream.writeSSE({ event: "sessions", data: "[]" });
      }

      // Hold the handler open until the client disconnects or the server shuts
      // down; writeSSE calls above keep pushing data through this same stream in
      // the meantime.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });

  return {
    get size() {
      return openStreams.size;
    },
    async closeAll() {
      // Snapshotted first: each closeStream removes itself from the set.
      await Promise.all([...openStreams].map((closeStream) => closeStream()));
    },
  };
}
