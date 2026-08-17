export type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";

/** One currently-playing stream as reported by Jellyfin's /Sessions endpoint. */
export interface LiveSession {
  /**
   * Jellyfin's session `Id` — the identifier for the client connection, stable across
   * items played on it. Not `PlaySessionId`: 10.11.11's /Sessions response does not
   * include that field at all.
   */
  sessionId: string;
  userId: string;
  userName: string;
  itemId: string;
  itemName: string;
  deviceId: string;
  deviceName: string;
  client: string;
  playMethod: PlayMethod;
  positionTicks: number;
  /** Null when Jellyfin does not report a runtime (e.g. live TV). */
  runtimeTicks: number | null;
  isPaused: boolean;
  remoteEndpoint: string | null;
}

/**
 * What we remember about a stream between two polls. Deliberately minimal: it is
 * a cache, and Postgres remains the source of truth if it is lost.
 */
export interface SessionSnapshotEntry {
  sessionId: string;
  itemId: string;
  positionTicks: number;
  isPaused: boolean;
  /** Epoch milliseconds at which this entry was observed. */
  observedAt: number;
}

/** Keyed by `${sessionId}:${itemId}` — see snapshotKey() in Task 4. */
export type SessionSnapshot = Record<string, SessionSnapshotEntry>;

export type SessionEvent =
  | { type: "started"; key: string; session: LiveSession; at: number }
  | {
      type: "progressed";
      key: string;
      positionTicks: number;
      watchedMs: number;
      isPaused: boolean;
      at: number;
    }
  | {
      type: "paused";
      key: string;
      positionTicks: number;
      watchedMs: number;
      isPaused: boolean;
      at: number;
    }
  | { type: "resumed"; key: string; positionTicks: number; at: number }
  | { type: "ended"; key: string; positionTicks: number; watchedMs: number; at: number };
