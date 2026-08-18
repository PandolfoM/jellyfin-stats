// @vitest-environment jsdom
//
// AppShell is deliberately a props-only component — no `useSession`, no data
// fetching — so it must render standalone from just `userName`, `onLogout`,
// and `children`. The one thing it needs that a plain unit test doesn't
// normally supply is a router context, because its nav items are real
// `Link`s (real `<a href>`s, so middle-click and open-in-new-tab work), and
// `Link` reads the router from context. That harness below is scaffolding
// for `Link` itself, not application state: no `SessionProvider`, no
// `QueryClientProvider`, nothing AppShell would need to know about.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";

afterEach(() => vi.restoreAllMocks());

const EXPECTED_LINKS: ReadonlyArray<[label: string, href: string]> = [
  ["Overview", "/"],
  ["Live", "/live"],
  ["History", "/history"],
  ["Users", "/users"],
  ["Libraries", "/libraries"],
  ["Settings", "/settings"],
];

function renderAppShell(onLogout: () => void) {
  // A throwing fetch mock makes "no fetching of its own" a real assertion
  // rather than an absence of evidence — if AppShell (or anything it
  // renders) ever called fetch, this test fails loudly instead of silently
  // passing because nothing happened to notice.
  const fetchSpy = vi.fn(() => {
    throw new Error("AppShell must not fetch anything itself");
  });
  vi.stubGlobal("fetch", fetchSpy);

  const testRootRoute = createRootRoute({
    component: () => (
      <AppShell userName="Ada Lovelace" onLogout={onLogout}>
        <div data-testid="shell-children">page content</div>
      </AppShell>
    ),
  });
  const router = createRouter({
    routeTree: testRootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(<RouterProvider router={router} />);
  return fetchSpy;
}

describe("AppShell", () => {
  it("renders exactly the six nav links, as real anchors to the right paths", async () => {
    renderAppShell(vi.fn());

    const nav = await screen.findByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");

    expect(links).toHaveLength(EXPECTED_LINKS.length);
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual(
      EXPECTED_LINKS.map(([label, href]) => [label, href]),
    );
    // Real anchors, not a `<button onClick={navigate}>` standing in for one —
    // this is what makes middle-click / open-in-new-tab work.
    for (const link of links) {
      expect(link.tagName).toBe("A");
    }
  });

  it("shows the signed-in user's name", async () => {
    renderAppShell(vi.fn());

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("renders the children it was given", async () => {
    renderAppShell(vi.fn());

    expect(await screen.findByTestId("shell-children")).toHaveTextContent("page content");
  });

  it("calls onLogout when the logout control is used, and nothing else", async () => {
    const onLogout = vi.fn();
    renderAppShell(onLogout);

    await userEvent.click(await screen.findByRole("button", { name: /log out/i }));

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("does not fetch anything itself", async () => {
    const fetchSpy = renderAppShell(vi.fn());

    await screen.findByRole("navigation", { name: "Main" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
