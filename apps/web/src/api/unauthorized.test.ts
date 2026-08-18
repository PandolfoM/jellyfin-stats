import { describe, expect, it, vi } from "vitest";

import { notifyUnauthorized, subscribeUnauthorized } from "./unauthorized";

describe("unauthorized pub/sub", () => {
  it("calls every currently-subscribed listener when notified", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = subscribeUnauthorized(a);
    const unsubscribeB = subscribeUnauthorized(b);

    notifyUnauthorized();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubscribeA();
    unsubscribeB();
  });

  it("stops calling a listener after its own unsubscribe function runs", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUnauthorized(listener);
    unsubscribe();

    notifyUnauthorized();

    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribing one listener leaves a different, still-subscribed listener intact", () => {
    // The concrete failure this catches: an `unsubscribe` implemented as
    // `listeners.clear()` instead of `listeners.delete(listener)` would pass
    // the test above (nothing left to call) but silently drop every other
    // subscriber too — this proves the removal is scoped to the one listener
    // whose own unsubscribe function was invoked.
    const removed = vi.fn();
    const kept = vi.fn();
    const unsubscribeRemoved = subscribeUnauthorized(removed);
    const unsubscribeKept = subscribeUnauthorized(kept);

    unsubscribeRemoved();
    notifyUnauthorized();

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);

    unsubscribeKept();
  });

  it("does nothing when notified with no subscribers", () => {
    expect(() => notifyUnauthorized()).not.toThrow();
  });
});
