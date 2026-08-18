// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatCard } from "./StatCard";

afterEach(() => vi.restoreAllMocks());

describe("StatCard", () => {
  it("renders a skeleton and hides the value while loading", () => {
    render(<StatCard label="Plays" value="42" loading />);

    expect(screen.queryByText("42")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });

  it("renders the value, not a skeleton, once loaded", () => {
    render(<StatCard label="Plays" value="42" />);

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
  });

  it("always renders the label", () => {
    render(<StatCard label="Active users" value="7" loading />);

    expect(screen.getByText("Active users")).toBeInTheDocument();
  });

  it("renders the hint only once loaded", () => {
    render(<StatCard label="Plays" value="42" hint="last 30 days" loading />);
    expect(screen.queryByText("last 30 days")).not.toBeInTheDocument();

    render(<StatCard label="Plays" value="42" hint="last 30 days" />);
    expect(screen.getByText("last 30 days")).toBeInTheDocument();
  });
});
