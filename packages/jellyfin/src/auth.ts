import { z } from "zod";

export class JellyfinAuthError extends Error {
  readonly kind: "invalid_credentials" | "unreachable";

  constructor(kind: "invalid_credentials" | "unreachable", message: string) {
    super(message);
    this.name = "JellyfinAuthError";
    this.kind = kind;
  }
}

export interface JellyfinAuthResult {
  userId: string;
  userName: string;
  isAdmin: boolean;
  accessToken: string;
}

export const authResponseSchema = z.object({
  AccessToken: z.string(),
  User: z.object({
    Id: z.string(),
    Name: z.string(),
    Policy: z.object({ IsAdministrator: z.boolean().nullish() }).nullish(),
  }),
});

/**
 * Jellyfin rejects AuthenticateByName unless the caller identifies itself. DeviceId is
 * stable so repeated logins reuse one device entry rather than littering the server's
 * device list with a new one per sign-in.
 */
export function clientIdentificationHeader(): string {
  return [
    'MediaBrowser Client="Jellyfin Stats"',
    'Device="jellyfin-stats-api"',
    'DeviceId="jellyfin-stats-api"',
    'Version="1.0.0"',
  ].join(", ");
}
