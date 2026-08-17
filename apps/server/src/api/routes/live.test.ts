import type { LiveSession } from "@jfstats/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerLiveRoute, type LiveDeps } from "./live.js";

const SESSION: LiveSession = {
  sessionId: "s-1",
  userId: "u-1",
  userName: "alpha",
  itemId: "i-1",
  itemName: "A Movie",
  deviceId: "d-1",
  deviceName: "Living Room",
  client: "Jellyfin Web",
  playMethod: "DirectPlay",
  positionTicks: 10,
  runtimeTicks: 100,
  isPaused: false,
  remoteEndpoint: "192.0.2.10",
};

function build(overrides: Partial<LiveDeps> = {}) {
  const unsubscribe = vi.fn(async () => {});
  const deps: LiveDeps = {
    loadCurrent: vi.fn(async () => [SESSION]),
    subscribe: vi.fn(async () => unsubscribe),
    ...overrides,
  };
  const app = new Hono();
  registerLiveRoute(app, deps);
  return { app, deps, unsubscribe };
}

async function firstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const chunk = await reader?.read();
  await reader?.cancel();
  return new TextDecoder().decode(chunk?.value);
}

describe("GET /api/live", () => {
  it("responds with an event stream", async () => {
    const { app } = build();

    const response = await app.request("/api/live");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  it("sends the current snapshot immediately rather than waiting for the next poll", async () => {
    const { app, deps } = build();

    const response = await app.request("/api/live");
    const text = await firstChunk(response);

    expect(deps.loadCurrent).toHaveBeenCalled();
    expect(text).toContain("data:");
    expect(text).toContain("A Movie");
  });

  it("sends an empty array when nothing is playing, not an empty body", async () => {
    const { app } = build({ loadCurrent: vi.fn(async () => []) });

    const text = await firstChunk(await app.request("/api/live"));

    expect(text).toContain("data: []");
  });

  it("subscribes to the live channel", async () => {
    const { app, deps } = build();

    const response = await app.request("/api/live");
    await firstChunk(response);

    expect(deps.subscribe).toHaveBeenCalled();
  });

  it("still opens the stream when the snapshot cannot be read", async () => {
    const { app } = build({
      loadCurrent: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });

    // A failed snapshot read must not stop the stream — the next poll recovers it.
    const response = await app.request("/api/live");

    expect(response.status).toBe(200);
  });

  it("relays a message from the live channel to the client", async () => {
    let deliver: ((payload: string) => void) | undefined;
    const { app } = build({
      subscribe: vi.fn(async (onMessage) => {
        deliver = onMessage;
        return async () => {};
      }),
    });

    const response = await app.request("/api/live");
    const reader = response.body?.getReader();
    await reader?.read(); // consume the initial snapshot frame

    const relayed: LiveSession = { ...SESSION, sessionId: "s-2", itemName: "Second Movie" };
    deliver?.(JSON.stringify([relayed]));
    const next = await reader?.read();
    const text = new TextDecoder().decode(next?.value);
    await reader?.cancel();

    expect(text).toContain("Second Movie");
  });

  it("unsubscribes when the client disconnects, so a page refresh does not leak a connection", async () => {
    const { app, unsubscribe } = build();

    const response = await app.request("/api/live");
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    // Cancelling the reader aborts the underlying stream; give the abort
    // subscriber a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unsubscribe).toHaveBeenCalled();
  });
});
