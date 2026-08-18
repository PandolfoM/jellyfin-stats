// @vitest-environment jsdom
//
// DateRangePicker is deliberately a props-only control — value in, onChange
// out, no fetching — so every test here drives it purely through props and
// DOM events, the same shape AppShell.test.tsx uses for its own props-only
// component.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateRangePicker } from "./DateRangePicker";

afterEach(() => vi.restoreAllMocks());

const VALUE = { from: "2026-01-01", to: "2026-01-31" };

describe("DateRangePicker", () => {
  it("does not fetch anything itself", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("DateRangePicker must not fetch anything itself");
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<DateRangePicker value={VALUE} onChange={vi.fn()} />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the controlled value in both date inputs", () => {
    render(<DateRangePicker value={VALUE} onChange={vi.fn()} />);

    expect(screen.getByLabelText("From")).toHaveValue("2026-01-01");
    expect(screen.getByLabelText("To")).toHaveValue("2026-01-31");
  });

  it("calls onChange with the new range when `from` changes, leaving `to` alone", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={VALUE} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-10" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ from: "2026-01-10", to: "2026-01-31" });
  });

  it("calls onChange with the new range when `to` changes, leaving `from` alone", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={VALUE} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-20" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ from: "2026-01-01", to: "2026-01-20" });
  });

  it("swaps rather than sends a range reversed by editing `from` past `to`", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={VALUE} onChange={onChange} />);

    // Bypasses the native `max` constraint the same way a user typing digits
    // directly into the field can on browsers that don't block it — the
    // component's own clamp is what has to catch this, not the HTML attribute.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-02-15" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ from: "2026-01-31", to: "2026-02-15" });
  });

  it("ignores an incomplete or empty date value rather than emitting a malformed range", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={VALUE} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not render a presets group when none are supplied", () => {
    render(<DateRangePicker value={VALUE} onChange={vi.fn()} />);

    expect(screen.queryByRole("group", { name: "Date range presets" })).not.toBeInTheDocument();
  });

  it("clicking a preset calls onChange with that preset's (clamped) range", () => {
    const onChange = vi.fn();
    render(
      <DateRangePicker
        value={VALUE}
        onChange={onChange}
        presets={[{ label: "Last 7 days", range: { from: "2026-01-25", to: "2026-01-31" } }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ from: "2026-01-25", to: "2026-01-31" });
  });

  it("clamps an over-long preset range rather than emitting it as-is", () => {
    const onChange = vi.fn();
    render(
      <DateRangePicker
        value={VALUE}
        onChange={onChange}
        presets={[{ label: "Everything", range: { from: "2000-01-01", to: "2026-08-18" } }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Everything" }));

    const result = onChange.mock.calls[0]?.[0] as { from: string; to: string } | undefined;
    expect(result).toBeDefined();
    expect(result?.to).toBe("2026-08-18");

    const spanDays =
      (Date.parse(`${result?.to}T00:00:00.000Z`) - Date.parse(`${result?.from}T00:00:00.000Z`)) /
        86_400_000 +
      1;
    expect(spanDays).toBe(1000);
  });

  it("supports two instances on the same page without id collisions or cross-talk", () => {
    // This is the control's actual reuse case — six later tasks compose it
    // into their own screens, and nothing stops two of those screens (or two
    // copies of the same screen) from mounting at once. A literal `id` on the
    // inputs would collide the moment that happens: invalid HTML, and
    // `getByLabelText` starts throwing "found multiple elements" instead of
    // resolving to one field.
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const { container } = render(
      <>
        <div data-testid="picker-a">
          <DateRangePicker value={VALUE} onChange={onChangeA} />
        </div>
        <div data-testid="picker-b">
          <DateRangePicker value={{ from: "2026-02-01", to: "2026-02-28" }} onChange={onChangeB} />
        </div>
      </>,
    );

    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);

    const pickerA = within(screen.getByTestId("picker-a"));
    const pickerB = within(screen.getByTestId("picker-b"));

    fireEvent.change(pickerA.getByLabelText("From"), { target: { value: "2026-01-15" } });
    fireEvent.change(pickerB.getByLabelText("To"), { target: { value: "2026-02-20" } });

    expect(onChangeA).toHaveBeenCalledTimes(1);
    expect(onChangeA).toHaveBeenCalledWith({ from: "2026-01-15", to: "2026-01-31" });
    expect(onChangeB).toHaveBeenCalledTimes(1);
    expect(onChangeB).toHaveBeenCalledWith({ from: "2026-02-01", to: "2026-02-20" });
  });
});
