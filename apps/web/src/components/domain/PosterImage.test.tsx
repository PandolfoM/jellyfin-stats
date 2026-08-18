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
    // Exact, not just `toContain`: this is the "shared path" the tagged
    // case must stay byte-identical to what it built before untagged
    // requests were supported — a change here would mean the tag-present
    // path (TopContentList's real callers, which have real tags) regressed
    // while fixing the null-tag one.
    expect(src).toBe(`/api/images/items/${ITEM_ID}?tag=${TAG}`);
    // The one security-relevant assertion here: this component must never
    // construct a URL pointing at Jellyfin itself, only at our own proxy.
    expect(src).not.toMatch(/^https?:\/\//);
  });

  // A missing tag is a cache-busting hint gone missing, not a missing image
  // — apps/server/src/api/routes/images.ts reads `tag` as an optional query
  // parameter and proxies to Jellyfin's primary-image endpoint either way.
  // The old behavior short-circuited straight to the placeholder on a null
  // tag without ever issuing a request, which meant every LiveSession-backed
  // card on /live (LiveSession has no image tag at all) showed a permanent
  // grey placeholder even when real artwork was one request away.
  it("still requests an image when tag is null, omitting the tag parameter rather than sending a literal null", () => {
    render(<PosterImage itemId={ITEM_ID} tag={null} alt="Poster for Example Movie" />);

    const img = screen.getByRole("img", { name: "Poster for Example Movie" });
    expect(img.tagName).toBe("IMG");
    const src = img.getAttribute("src") ?? "";
    expect(src).toBe(`/api/images/items/${ITEM_ID}`);
    expect(src).not.toContain("tag=");
    // Guards against a lazier fix that just stringified the null/undefined
    // value into the query string instead of omitting it outright — that
    // would still "issue a request" but reach the proxy as a nonsense
    // cache-busting value and risk a confusing upstream 404 instead of a
    // clean, tagless primary-image request.
    expect(src).not.toContain("null");
    expect(src).not.toContain("undefined");
    expect(src).not.toMatch(/^https?:\/\//);
  });

  it("degrades to the placeholder, not a broken-image icon, when the tagged request fails", () => {
    render(<PosterImage itemId={ITEM_ID} tag={TAG} alt="Poster for Example Movie" />);

    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);

    expect(document.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Poster for Example Movie" })).toBeInTheDocument();
  });

  // The genuine no-artwork case, now that a null tag issues a request
  // instead of skipping straight to the placeholder: this is what proves
  // that case didn't regress into a permanent broken-image icon.
  it("degrades to the placeholder when the untagged (null-tag) request fails too", () => {
    render(<PosterImage itemId={ITEM_ID} tag={null} alt="Poster for Example Movie" />);

    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);

    expect(document.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Poster for Example Movie" })).toBeInTheDocument();
  });
});
