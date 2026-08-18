import { hc } from "hono/client";
import type { AppType } from "../../../server/src/api/app.js";
import { notifyUnauthorized } from "./unauthorized";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Every request carries the session cookie. Without `credentials: "include"` the
 * browser omits it and every admin route answers 401.
 */
export const api = hc<AppType>("/", {
  init: { credentials: "include" },
});

export async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // A 401 from *any* route (not just /api/auth/me) means the session
    // expired or was revoked server-side after the page loaded — every
    // caller of `unwrap` gets this notification for free rather than each
    // route having to check `err.status === 401` itself. See unauthorized.ts
    // for who listens and what they do with it.
    if (response.status === 401) notifyUnauthorized();
    throw new ApiError(response.status, `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}
