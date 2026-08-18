import { hc } from "hono/client";
import type { AppType } from "../../../server/src/api/app.js";

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
    throw new ApiError(response.status, `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}
