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
      // Subscribe — and register the abort cleanup for it — before writing anything.
      // A client can disconnect the instant the first byte arrives; if cleanup were
      // registered only after that first write, an abort landing in between would
      // leak the duplicated Redis connection because Hono's onAbort() does not
      // retroactively notify listeners added after abort() already ran.
      const unsubscribe = await deps.subscribe((payload) => {
        void stream.writeSSE({ event: "sessions", data: payload });
      });

      // Idle proxies close a silent connection; a periodic frame keeps it open.
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
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
