import { describe, expect, it, vi } from "vitest";
import type { LiveSession } from "@jfstats/shared";
import { createSnapshotStore } from "./snapshot-store.js";

function session(id: string): LiveSession {
  return {
    sessionId: id,
    userId: "user-1",
    userName: "ada",
    itemId: "item-1",
    itemName: "Example Movie",
    deviceId: "device-1",
    deviceName: "Living Room",
    client: "Jellyfin Web",
    playMethod: "DirectPlay",
    positionTicks: 0,
    runtimeTicks: null,
    isPaused: false,
    remoteEndpoint: null,
  };
}

describe("snapshot store", () => {
  it("round-trips the diff snapshot", async () => {
    const store = createSnapshotStore();
    await store.save({
      "a:b": { sessionId: "a", itemId: "b", positionTicks: 5, isPaused: false, observedAt: 1 },
    });
    expect(await store.load()).toEqual({
      "a:b": { sessionId: "a", itemId: "b", positionTicks: 5, isPaused: false, observedAt: 1 },
    });
  });

  it("starts empty", async () => {
    expect(await createSnapshotStore().load()).toEqual({});
  });

  it("delivers a publish to an attached subscriber", async () => {
    const store = createSnapshotStore();
    const seen: LiveSession[][] = [];
    store.subscribe((s) => seen.push(s));

    await store.publish([session("s1")]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.sessionId).toBe("s1");
  });

  it("returns an empty array from loadLive before anything has been published", async () => {
    // Nothing else exercises loadLive() pre-publish: every other test calls it
    // only after a publish. If `live` were ever misinitialized to something
    // other than [], a freshly-connecting dashboard would render whatever that
    // was instead of nothing, before the first poll ever ran.
    expect(await createSnapshotStore().loadLive()).toEqual([]);
  });

  // The reason loadLive() exists. A client attaching after the publish gets
  // nothing from the event, so without the cache its first render is blank.
  it("gives a late subscriber the current sessions via loadLive", async () => {
    const store = createSnapshotStore();
    await store.publish([session("s2")]);

    const seen: LiveSession[][] = [];
    store.subscribe((s) => seen.push(s));

    expect(seen).toHaveLength(0);
    // Full toEqual, not just a sessionId check: guards against loadLive ever
    // degrading to the reducer's minimal SessionSnapshotEntry shape, which
    // drops userName/itemName/deviceName — a real regression that a
    // sessionId-only assertion would not catch.
    expect(await store.loadLive()).toEqual([session("s2")]);
  });

  it("reflects only the latest publish, not an accumulation of earlier ones", async () => {
    const store = createSnapshotStore();
    const other = session("s7");

    await store.publish([session("s2")]);
    await store.publish([other]);

    expect(await store.loadLive()).toEqual([other]);
  });

  it("stops delivering after unsubscribe", async () => {
    const store = createSnapshotStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);

    await store.publish([session("s3")]);
    off();
    await store.publish([session("s4")]);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers to every attached subscriber, and unsubscribing one leaves the other", async () => {
    const store = createSnapshotStore();
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    store.subscribe(b);

    offA();
    await store.publish([session("s5")]);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  // A throwing listener is one dashboard tab misbehaving. It must not stop the
  // other tabs from getting the update, and must not reject publish() — which
  // is awaited on the poll path and would fail the whole poll.
  it("isolates a throwing subscriber from the others and from publish", async () => {
    const store = createSnapshotStore();
    store.subscribe(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    store.subscribe(healthy);

    await expect(store.publish([session("s6")])).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
