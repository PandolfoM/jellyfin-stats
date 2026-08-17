import { z } from "zod";

const playMethodSchema = z.enum(["DirectPlay", "DirectStream", "Transcode"]);

const nowPlayingItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Type: z.string(),
  SeriesId: z.string().nullish(),
  SeasonId: z.string().nullish(),
  RunTimeTicks: z.number().nullish(),
  ProductionYear: z.number().nullish(),
  ImageTags: z.object({ Primary: z.string().nullish() }).nullish(),
});

export const sessionSchema = z.object({
  PlaySessionId: z.string().nullish(),
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
