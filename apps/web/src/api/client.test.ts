import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, unwrap } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("unwrap", () => {
  it("returns the parsed body for a 2xx response", async () => {
    const response = new Response(JSON.stringify({ plays: 3 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(unwrap<{ plays: number }>(response)).resolves.toEqual({ plays: 3 });
  });

  it("throws ApiError carrying the status for a 401", async () => {
    const response = new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });

    await expect(unwrap(response)).rejects.toMatchObject({ status: 401 });
  });

  it("throws ApiError for a 500 too, so callers can distinguish it from a 401", async () => {
    const response = new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });

    // The session layer treats 401 as "log in" and everything else as "something
    // broke". Collapsing them would bounce a user to the login page on a server
    // fault, where logging in again cannot possibly help.
    await expect(unwrap(response)).rejects.toMatchObject({ status: 500 });
  });

  it("is an ApiError instance so callers can narrow on it", async () => {
    await expect(unwrap(new Response("{}", { status: 401 }))).rejects.toBeInstanceOf(ApiError);
  });

  it("does not throw on a non-JSON 2xx body", async () => {
    // The image proxy returns binary; unwrap is only used for JSON routes, but a
    // parse failure must not masquerade as an auth problem.
    await expect(unwrap(new Response("not json", { status: 200 }))).rejects.not.toMatchObject({
      status: 401,
    });
  });
});
