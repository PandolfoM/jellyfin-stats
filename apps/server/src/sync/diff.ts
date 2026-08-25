import type {
  LiveSession,
  SessionEvent,
  SessionSnapshot,
  SessionSnapshotEntry,
} from "@jfstats/shared";

export interface DiffOptions {
  /** Epoch milliseconds at which this poll was taken. Injected, never read from the clock. */
  now: number;
  /** Upper bound on a single watch-time credit. */
  maxWatchDeltaMs: number;
}

export interface DiffResult {
  events: SessionEvent[];
  snapshot: SessionSnapshot;
}

/**
 * Jellyfin reuses a session Id across an auto-played next episode, so the item
 * id is part of the identity. Without it, two episodes would merge into one row.
 */
export function snapshotKey(sessionId: string, itemId: string): string {
  return `${sessionId}:${itemId}`;
}

/**
 * Time credited for the interval that just elapsed. Only counts when the stream was
 * playing at the previous observation, and is clamped at both ends so neither a
 * stalled worker nor a backwards clock can corrupt the total.
 */
function creditFor(previous: SessionSnapshotEntry, options: DiffOptions): number {
  if (previous.isPaused) return 0;
  const elapsed = options.now - previous.observedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(elapsed, options.maxWatchDeltaMs);
}

export function diffSessions(
  previous: SessionSnapshot,
  incoming: LiveSession[],
  options: DiffOptions,
): DiffResult {
  const events: SessionEvent[] = [];
  const snapshot: SessionSnapshot = {};
  const seen = new Set<string>();

  for (const live of incoming) {
    // Jellyfin occasionally reports a session with no playback identity; it carries
    // no usable history, so it is dropped rather than stored under an empty key.
    if (live.sessionId === "" || live.itemId === "") continue;

    const key = snapshotKey(live.sessionId, live.itemId);
    seen.add(key);

    const before = previous[key];

    if (before === undefined) {
      events.push({ type: "started", key, session: live, at: options.now });
    } else if (before.isPaused && !live.isPaused) {
      events.push({ type: "resumed", key, positionTicks: live.positionTicks, at: options.now });
    } else if (!before.isPaused && live.isPaused) {
      events.push({
        type: "paused",
        key,
        positionTicks: live.positionTicks,
        watchedMs: creditFor(before, options),
        isPaused: live.isPaused,
        at: options.now,
      });
    } else {
      events.push({
        type: "progressed",
        key,
        positionTicks: live.positionTicks,
        watchedMs: creditFor(before, options),
        isPaused: live.isPaused,
        at: options.now,
      });
    }

    snapshot[key] = {
      sessionId: live.sessionId,
      itemId: live.itemId,
      positionTicks: live.positionTicks,
      isPaused: live.isPaused,
      observedAt: options.now,
    };
  }

  // Anything present last poll but absent now has stopped playing. An item change
  // under one play session lands here too, which is what produces end-then-start.
  for (const [key, before] of Object.entries(previous)) {
    if (seen.has(key)) continue;
    events.push({
      type: "ended",
      key,
      positionTicks: before.positionTicks,
      watchedMs: creditFor(before, options),
      at: options.now,
    });
  }

  // Ended events must be applied before started events. When a client auto-plays the
  // next episode, the applier has to close the old row before opening the new one, or
  // the two writes race on the same play session id.
  const rank = (event: SessionEvent): number => (event.type === "ended" ? 0 : 1);
  events.sort((a, b) => rank(a) - rank(b));

  return { events, snapshot };
}
