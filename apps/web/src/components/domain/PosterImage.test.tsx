// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PosterImage } from "./PosterImage";

afterEach(() => vi.restoreAllMocks());

// Synthetic — not a real Jellyfin item id, just a well-formed-looking hex
// string so the fixture reads like the real shape.
const ITEM_ID = "0123456789abcdef0123456789abcdef";
const TAG = "synthetic-tag-value";

describe("PosterImage", () => {
  it("renders an img whose src is our own image proxy, carrying the item id and tag", () => {
    render(<PosterImage itemId={ITEM_ID} tag={TAG} alt="Poster for Example Movie" />);

    const img = screen.getByRole("img", { name: "Poster for Example Movie" });
    expect(img.tagName).toBe("IMG");
    const src = img.getAttribute("src") ?? "";
    expect(src).toContain(`/api/images/items/${ITEM_ID}`);
    expect(src).toContain(TAG);
    // The one security-relevant assertion here: this component must never
    // construct a URL pointing at Jellyfin itself, only at our own proxy.
    expect(src).not.toMatch(/^https?:\/\//);
  });

  it("renders a placeholder, not an img element, when tag is null", () => {
    render(<PosterImage itemId={ITEM_ID} tag={null} alt="Poster for Example Movie" />);

    expect(screen.getByRole("img", { name: "Poster for Example Movie" })).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("degrades to the placeholder, not a broken-image icon, when the request fails", () => {
    render(<PosterImage itemId={ITEM_ID} tag={TAG} alt="Poster for Example Movie" />);

    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);

    expect(document.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Poster for Example Movie" })).toBeInTheDocument();
  });
});
