// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UserAvatar } from "./UserAvatar";

const USER_ID = "0f0e0d0c0b0a09080706050403020100";

describe("UserAvatar", () => {
  it("renders an img whose src is our own avatar proxy, sized for a small circle", () => {
    render(<UserAvatar userId={USER_ID} name="Ada Lovelace" />);

    const img = screen.getByRole("img", { name: "Avatar for Ada Lovelace" });
    expect(img.tagName).toBe("IMG");
    const src = img.getAttribute("src") ?? "";
    expect(src).toBe(`/api/images/users/${USER_ID}?maxWidth=64`);
    expect(src).not.toMatch(/^https?:\/\//);
  });

  it("falls back to the user's initials, not a broken image, when the request fails", () => {
    render(<UserAvatar userId={USER_ID} name="Ada Lovelace" />);

    fireEvent.error(document.querySelector("img") as HTMLImageElement);

    expect(document.querySelector("img")).not.toBeInTheDocument();
    const fallback = screen.getByRole("img", { name: "Avatar for Ada Lovelace" });
    expect(fallback).toHaveTextContent("AL");
  });

  it("uses a single initial for a one-word name and a question mark for an empty one", () => {
    const { rerender } = render(<UserAvatar userId={USER_ID} name="grace" />);
    fireEvent.error(document.querySelector("img") as HTMLImageElement);
    expect(screen.getByRole("img", { name: "Avatar for grace" })).toHaveTextContent("G");

    rerender(<UserAvatar userId="ffffffffffffffffffffffffffffffff" name="" />);
    fireEvent.error(document.querySelector("img") as HTMLImageElement);
    expect(screen.getByRole("img", { name: "Avatar" })).toHaveTextContent("?");
  });
});
