import type { LiveSession } from "@jfstats/shared";
import type { Env, Hono, Schema } from "hono";
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
 * the supervisor's grace period expires and SIGKILL lands, with the database
 * never closed cleanly.
 */
export interface LiveStreamRegistry {
  /** Resolves once every open stream has been ended and unsubscribed. */
  closeAll(): Promise<void>;
  /** Open stream count. Exposed for tests and diagnostics. */
  readonly size: number;
}

// Comfortably inside the 30-60s window a typical idle-timeout proxy enforces.
const HEARTBEAT_MS = 25_000;

/**
 * Returns one object carrying both the app with this route chained onto it
 * (rather than `void`, for the same reason registerAuthRoutes does — see
 * that file for why) and the LiveStreamRegistry members (`size`, `closeAll`)
 * spread across the same object rather than nested under a `registry` key.
 * That flattening is deliberate: `apps/server/src/api.test.ts` (which must
 * keep passing unchanged) already calls `registerLiveRoute` directly and
 * uses its return value as a `LiveStreamRegistry` — `streams.size`, and
 * passing `streams` straight to `closeApiServer`. A `{ app, registry }` split
 * would have broken that call site's shape. The flattened object still
 * satisfies `LiveStreamRegistry` structurally (the extra `app` property is
 * simply ignored wherever a `LiveStreamRegistry` is expected), so existing
 * callers are untouched while `createApp` can additionally read `.app`. The
 * incoming `S` is generic (not defaulted to Hono's blank schema) so that a
 * caller threading in an already-chained app keeps those routes in the
 * returned type instead of them being erased at this call.
 */
export function registerLiveRoute<E extends Env, S extends Schema>(app: Hono<E, S>, deps: LiveDeps) {
  const openStreams = new Set<() => Promise<void>>();

  const routedApp = app.get("/api/live", (c) => {
    return streamSSE(c, async (stream) => {
      // Track abort before calling subscribe() at all — registered synchronously,
      // before cb's first await, so it is in place before the caller can possibly
      // have gotten hold of a reader to cancel. subscribe() is a synchronous,
      // in-process EventEmitter.on() in production, so there is no real
      // round trip to race — but a client that disconnects before the
      // returned unsubscribe function resolves must still not leak the stream.
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
    app: routedApp,
    get size() {
      return openStreams.size;
    },
    async closeAll() {
      // Snapshotted first: each closeStream removes itself from the set.
      await Promise.all([...openStreams].map((closeStream) => closeStream()));
    },
  };
}
