import type { LiveSession } from "@jfstats/shared";
import type { z } from "zod";
import {
  authResponseSchema,
  clientIdentificationHeader,
  JellyfinAuthError,
  type JellyfinAuthResult,
} from "./auth.js";
import {
  itemsSchema,
  librariesSchema,
  normalisePlayMethod,
  sessionsSchema,
  usersSchema,
} from "./schemas.js";

export interface JellyfinClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected so tests never touch the network. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface JellyfinUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface JellyfinLibrary {
  id: string;
  name: string;
  collectionType: string | null;
}

export interface JellyfinItem {
  id: string;
  name: string;
  type: string;
  libraryId: string | null;
  seriesId: string | null;
  seasonId: string | null;
  productionYear: number | null;
  runtimeTicks: number | null;
  imageTag: string | null;
}

export interface JellyfinClient {
  getSessions(): Promise<LiveSession[]>;
  getUsers(): Promise<JellyfinUser[]>;
  getLibraries(): Promise<JellyfinLibrary[]>;
  getItems(): Promise<JellyfinItem[]>;
  authenticateByName(username: string, password: string): Promise<JellyfinAuthResult>;
  revokeToken(accessToken: string): Promise<void>;
}

export function createJellyfinClient(options: JellyfinClientOptions): JellyfinClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
    const response = await doFetch(`${options.baseUrl}${path}`, {
      headers: {
        // The key goes in a header, never the query string, so it cannot leak
        // into access logs or browser history.
        Authorization: `MediaBrowser Token="${options.apiKey}"`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Jellyfin request failed: ${response.status} ${path}`);
    }

    const parsed = schema.safeParse(await response.json());

    if (!parsed.success) {
      throw new Error(`Unexpected Jellyfin response from ${path}: ${parsed.error.message}`);
    }

    return parsed.data;
  }

  async function getSessions(): Promise<LiveSession[]> {
    const raw = await request("/Sessions", sessionsSchema);

    return raw.flatMap((entry): LiveSession[] => {
      const item = entry.NowPlayingItem;
      // Idle sessions and sessions missing playback identity carry no history.
      if (!item || !entry.Id || !entry.UserId) return [];

      return [
        {
          sessionId: entry.Id,
          userId: entry.UserId,
          userName: entry.UserName ?? "unknown",
          itemId: item.Id,
          itemName: item.Name,
          deviceId: entry.DeviceId ?? "unknown",
          deviceName: entry.DeviceName ?? "unknown",
          client: entry.Client ?? "unknown",
          playMethod: normalisePlayMethod(entry.PlayState?.PlayMethod),
          positionTicks: entry.PlayState?.PositionTicks ?? 0,
          runtimeTicks: item.RunTimeTicks ?? null,
          isPaused: entry.PlayState?.IsPaused ?? false,
          remoteEndpoint: entry.RemoteEndPoint ?? null,
        },
      ];
    });
  }

  async function getUsers(): Promise<JellyfinUser[]> {
    const raw = await request("/Users", usersSchema);
    return raw.map((user) => ({
      id: user.Id,
      name: user.Name,
      isAdmin: user.Policy?.IsAdministrator ?? false,
    }));
  }

  async function getLibraries(): Promise<JellyfinLibrary[]> {
    const raw = await request("/Library/VirtualFolders", librariesSchema);
    return raw.map((library) => ({
      id: library.ItemId,
      name: library.Name,
      collectionType: library.CollectionType ?? null,
    }));
  }

  async function getItems(): Promise<JellyfinItem[]> {
    // An item carries no "library id" field of its own — ParentId is the item's
    // immediate parent (season for an episode, collection folder for a movie), not
    // the library's id from /Library/VirtualFolders. So the library has to be
    // established by the query: fetch each library's descendants separately and
    // tag every returned item with the library id it was queried under.
    const libraries = await getLibraries();

    const perLibrary = await Promise.all(
      libraries.map(async (library) => {
        const raw = await request(
          `/Items?ParentId=${encodeURIComponent(library.id)}&Recursive=true&IncludeItemTypes=Movie,Episode,Audio&Fields=ProductionYear&EnableImages=true`,
          itemsSchema,
        );

        return raw.Items.map((item) => ({
          id: item.Id,
          name: item.Name,
          type: item.Type,
          libraryId: library.id,
          seriesId: item.SeriesId ?? null,
          seasonId: item.SeasonId ?? null,
          productionYear: item.ProductionYear ?? null,
          runtimeTicks: item.RunTimeTicks ?? null,
          imageTag: item.ImageTags?.Primary ?? null,
        }));
      }),
    );

    return perLibrary.flat();
  }

  async function authenticateByName(username: string, password: string) {
    let response: Response;

    try {
      response = await doFetch(`${options.baseUrl}/Users/AuthenticateByName`, {
        method: "POST",
        headers: {
          Authorization: clientIdentificationHeader(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        // Credentials travel in the body. Never the query string — it would land
        // in access logs and browser history.
        body: JSON.stringify({ Username: username, Pw: password }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new JellyfinAuthError("unreachable", "Could not reach Jellyfin");
    }

    if (response.status === 401 || response.status === 403) {
      throw new JellyfinAuthError("invalid_credentials", "Jellyfin rejected the credentials");
    }

    if (!response.ok) {
      throw new JellyfinAuthError("unreachable", `Jellyfin returned ${response.status}`);
    }

    // A 200 does not guarantee a JSON body — a proxy in front of Jellyfin could return
    // an HTML maintenance page, or the body could be empty or truncated. That is a
    // server problem, not a credentials problem, so it must classify as unreachable
    // rather than let a raw SyntaxError escape unclassified.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new JellyfinAuthError("unreachable", "Jellyfin returned a non-JSON response");
    }

    const parsed = authResponseSchema.safeParse(body);

    if (!parsed.success) {
      throw new JellyfinAuthError("unreachable", "Unexpected authentication response");
    }

    return {
      userId: parsed.data.User.Id,
      userName: parsed.data.User.Name,
      isAdmin: parsed.data.User.Policy?.IsAdministrator ?? false,
      accessToken: parsed.data.AccessToken,
    };
  }

  async function revokeToken(accessToken: string) {
    // Best effort. A failure here must never surface to a user who just logged in
    // successfully — the worst case is one stale device entry on the Jellyfin server.
    try {
      await doFetch(`${options.baseUrl}/Sessions/Logout`, {
        method: "POST",
        headers: {
          Authorization: `MediaBrowser Token="${accessToken}"`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // swallowed deliberately
    }
  }

  return { getSessions, getUsers, getLibraries, getItems, authenticateByName, revokeToken };
}
