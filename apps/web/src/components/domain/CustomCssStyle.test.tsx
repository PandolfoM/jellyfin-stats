// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomCssStyle } from "./CustomCssStyle";

afterEach(() => vi.restoreAllMocks());

function mockSettings(customCss: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          sessionPollIntervalMs: 5_000,
          referenceSyncIntervalMs: 900_000,
          completionThreshold: 0.9,
          jellyfinUrl: "http://jellyfin.example.invalid",
          customCss,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
}

function renderStyle() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CustomCssStyle />
    </QueryClientProvider>,
  );
}

describe("CustomCssStyle", () => {
  it("renders the saved stylesheet into a style element", async () => {
    mockSettings(":root { --primary: red; }");

    renderStyle();

    const style = await screen.findByTestId("custom-css");
    expect(style.tagName).toBe("STYLE");
    expect(style.textContent).toBe(":root { --primary: red; }");
  });

  it("renders nothing at all when no stylesheet is saved", async () => {
    // An empty <style> is harmless but pointless; more importantly this proves
    // the component does not render before the query resolves either.
    mockSettings("");

    renderStyle();

    await waitFor(() => expect(screen.queryByTestId("custom-css")).not.toBeInTheDocument());
  });

  it("escapes the CSS rather than injecting it as markup", async () => {
    // The one real escalation path: CSS itself is inert, but a payload that
    // closes the tag would not be. React escapes a text child, so this must
    // land as text inside the style element and never as a live <script>.
    mockSettings("</style><script>window.__pwned = true;</script>");

    renderStyle();

    const style = await screen.findByTestId("custom-css");
    expect(style.querySelector("script")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    // The payload is still present, as inert text.
    expect(style.textContent).toContain("script");
  });
});
