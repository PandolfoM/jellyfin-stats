import { z } from "zod";

const playMethodSchema = z.enum(["DirectPlay", "DirectStream", "Transcode"]);

const nowPlayingItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Type: z.string(),
  SeriesId: z.string().nullish(),
  SeasonId: z.string().nullish(),
  // Episodes only. Jellyfin returns these on BaseItemDto by default (they are not
  // opt-in `Fields` values), and they are absent — not zero — on movies and audio.
  // `IndexNumber` is the episode number within its season, `ParentIndexNumber` the
  // season number; a special outside any season carries ParentIndexNumber 0.
  SeriesName: z.string().nullish(),
  IndexNumber: z.number().nullish(),
  ParentIndexNumber: z.number().nullish(),
  RunTimeTicks: z.number().nullish(),
  ProductionYear: z.number().nullish(),
  ImageTags: z.object({ Primary: z.string().nullish() }).nullish(),
});

export const sessionSchema = z.object({
  // The session's own identifier, stable across items played on the same client
  // connection. Jellyfin 10.11.11's /Sessions response does not send a
  // "PlaySessionId" field at all — this Id is the only usable session identity.
  Id: z.string().nullish(),
  UserId: z.string().nullish(),
  UserName: z.string().nullish(),
  DeviceId: z.string().nullish(),
  DeviceName: z.string().nullish(),
  Client: z.string().nullish(),
  RemoteEndPoint: z.string().nullish(),
  PlayState: z
    .object({
      PositionTicks: z.number().nullish(),
      IsPaused: z.boolean().nullish(),
      // Unknown values are tolerated here and normalised by the client, so a new
      // Jellyfin play method does not break session capture entirely.
      PlayMethod: z.string().nullish(),
    })
    .nullish(),
  NowPlayingItem: nowPlayingItemSchema.nullish(),
});

export const sessionsSchema = z.array(sessionSchema);

export const userSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Policy: z.object({ IsAdministrator: z.boolean().nullish() }).nullish(),
});

export const usersSchema = z.array(userSchema);

export const librarySchema = z.object({
  ItemId: z.string(),
  Name: z.string(),
  CollectionType: z.string().nullish(),
});

export const librariesSchema = z.array(librarySchema);

/**
 * The single-item endpoint (`/Items/{id}`) returns the full BaseItemDto, so the
 * descriptive fields the detail page wants arrive without any `Fields=` opt-in.
 * Every one of them is optional: Jellyfin omits what it does not know, and a
 * bare audio track or a freshly scanned file can lack all of them.
 */
export const itemDetailSchema = nowPlayingItemSchema.extend({
  Overview: z.string().nullish(),
  // ISO timestamp; only the calendar date is meaningful (Jellyfin stores it at midnight).
  PremiereDate: z.string().nullish(),
  Genres: z.array(z.string()).nullish(),
  OfficialRating: z.string().nullish(),
  CommunityRating: z.number().nullish(),
  Studios: z.array(z.object({ Name: z.string().nullish() })).nullish(),
});

export const itemsSchema = z.object({
  // No "library id" field exists on an item — an item's ParentId is its immediate
  // parent (season for an episode, collection folder for a movie), not the library
  // it lives in. The library id has to come from the query, not this payload; see
  // getItems() in client.ts.
  Items: z.array(nowPlayingItemSchema),
  TotalRecordCount: z.number(),
});

export function normalisePlayMethod(value: string | null | undefined) {
  const parsed = playMethodSchema.safeParse(value);
  return parsed.success ? parsed.data : ("DirectPlay" as const);
}
