// Registers jest-dom's matchers (toHaveTextContent, etc.) on Vitest's `expect`,
// and cleans up whatever React Testing Library rendered after each test.
//
// This file is loaded for every test in the monorepo (see the root
// vitest.config.ts), not only apps/web's — importing it does nothing to a
// test that never calls `render()`, since `cleanup()` only touches containers
// RTL actually mounted, and jest-dom's matchers just extend `expect` without
// touching `document` until an assertion using one of them runs.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom has no layout engine and does not implement `window.scrollTo` —
// TanStack Router calls it for scroll restoration on every navigation, which
// otherwise prints "Not implemented: Window's scrollTo() method" to stderr
// once per navigation in every test that renders a router. A no-op is the
// correct behavior for jsdom anyway (there is no scroll position to restore),
// not just a way to silence the noise.
if (typeof window !== "undefined") {
  window.scrollTo = () => {};
}

// Radix's popper-based primitives (Select, Popover) touch four browser APIs
// jsdom does not implement. Without these, opening either one throws rather
// than failing an assertion, so every test that clicks a trigger dies with an
// unrelated TypeError.
//
// These are genuine jsdom gaps, not stubs papering over a bug: jsdom has no
// layout engine, so there is nothing for ResizeObserver to observe and no
// geometry for scrollIntoView to scroll to. A no-op is the honest
// implementation. Pointer capture is real DOM API that jsdom simply omits.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (!("DOMRect" in window)) {
    window.DOMRect = class {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
      ) {}
      static fromRect(rect?: DOMRectInit) {
        return new DOMRect(rect?.x, rect?.y, rect?.width, rect?.height);
      }
      get top() {
        return this.y;
      }
      get left() {
        return this.x;
      }
      get right() {
        return this.x + this.width;
      }
      get bottom() {
        return this.y + this.height;
      }
      toJSON() {
        return { ...this };
      }
    } as unknown as typeof DOMRect;
  }

  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
}
