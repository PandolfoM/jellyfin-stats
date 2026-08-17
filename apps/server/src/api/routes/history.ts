import { MAX_HISTORY_LIMIT, type HistoryOptions, type HistoryRow } from "@jfstats/db";
import type { Env, Hono } from "hono";
import { InvalidRangeError, parseRange } from "./stats.js";

export interface HistoryDeps {
  getHistory(options: HistoryOptions): Promise<{ rows: HistoryRow[]; total: number }>;
}

export function registerHistoryRoutes<E extends Env>(app: Hono<E>, deps: HistoryDeps): void {
  app.get("/api/history", async (c) => {
    const hasRange = c.req.query("from") !== undefined || c.req.query("to") !== undefined;

    let from: string | undefined;
    let to: string | undefined;

    if (hasRange) {
      try {
        ({ from, to } = parseRange(c.req.query()));
      } catch (error) {
        if (error instanceof InvalidRangeError) return c.json({ error: "invalid_range" }, 400);
        throw error;
      }
    }

    const requestedLimit = Number(c.req.query("limit") ?? 50);
    const requestedOffset = Number(c.req.query("offset") ?? 0);

    // Clamped here too, not only in the repository: an unbounded limit from a
    // query string should never even reach the repository layer.
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(1, Math.trunc(requestedLimit)), MAX_HISTORY_LIMIT)
      : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.trunc(requestedOffset)) : 0;

    const result = await deps.getHistory({
      limit,
      offset,
      userId: c.req.query("userId"),
      libraryId: c.req.query("libraryId"),
      from,
      to,
    });

    return c.json(result);
  });
}
