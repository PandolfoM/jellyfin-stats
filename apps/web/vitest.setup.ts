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
