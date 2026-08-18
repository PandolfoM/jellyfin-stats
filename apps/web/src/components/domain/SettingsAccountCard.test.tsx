// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsAccountCard } from "./SettingsAccountCard";

afterEach(() => vi.restoreAllMocks());

describe("SettingsAccountCard", () => {
  it("shows the signed-in account's name", () => {
    render(<SettingsAccountCard userName="Ada Lovelace" onLogout={vi.fn()} />);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("calls onLogout when the logout control is used, and nothing else", async () => {
    const onLogout = vi.fn();
    render(<SettingsAccountCard userName="Ada Lovelace" onLogout={onLogout} />);

    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("renders exactly one control: the logout button — no input, switch, or save control", () => {
    render(<SettingsAccountCard userName="Ada Lovelace" onLogout={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
