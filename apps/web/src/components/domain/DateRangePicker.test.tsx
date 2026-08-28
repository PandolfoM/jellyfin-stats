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

/**
 * Opens one endpoint's calendar and clicks a day in it.
 *
 * The endpoints are `<button>`s now, not `<input type="date">`, so there is no
 * value to `fireEvent.change`. Triggers are found by accessible name, which is
 * "From <date>" / "To <date>" — the date is part of the name deliberately, so
 * two pickers on one page stay distinguishable without ids.
 *
 * Day names come from react-day-picker and are full dates ("Saturday, January
 * 10th, 2026"), with ", selected" appended to the current selection. Matching
 * on the whole string rather than the day number avoids hitting the outside
 * days of the adjacent month, which the grid also renders.
 */
function pickDay(scope: ReturnType<typeof within>, field: "From" | "To", dayLabel: string) {
  fireEvent.click(scope.getByRole("button", { name: new RegExp(`^${field} `) }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: dayLabel }));
}

describe("DateRangePicker", () => {
  it("does not fetch anything itself", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("DateRangePicker must not fetch anything itself");
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<DateRangePicker value={VALUE} onChange={vi.fn()} />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the controlled value on both endpoint buttons", () => {
    render(<DateRangePicker value={VALUE} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: /^From / })).toHaveTextContent("2026-01-01");
    expect(screen.getByRole("button", { name: /^To / })).toHaveTextContent("2026-01-31");
  });

  it("calls onChange with the new range when `from` changes, leaving `to` alone", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={VALUE} onChange={onChange} />);

    pickDay(within(document.body), "From", "Saturday, January 10th, 2026");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ from: "2026-01-10", to: "2026-01-31" });
  });

  it("calls onChange with the new range when `to` changes, leaving `from` alone", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={VALUE} onChange={onChange} />);

    pickDay(within(document.body), "To", "Tuesday, January 20th, 2026");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ from: "2026-01-01", to: "2026-01-20" });
  });

  it("makes a day after `to` unpickable in the `from` calendar", () => {
    // The old text field let a reversed range be typed, and `clampRangeDays`
    // swapped it after the fact. The calendar closes that door earlier by
    // disabling the days entirely — so this asserts unreachability, and the
    // swap itself stays covered where it actually lives, in range.test.ts
    // ("corrects a reversed range by swapping the endpoints").
    const onChange = vi.fn();
    // A mid-month `to`, not VALUE's 31 Jan: January 2026 ends on a Saturday, so
    // its grid carries no trailing days from February and there would be no
    // disabled square on screen to assert against.
    render(
      <DateRangePicker value={{ from: "2026-01-01", to: "2026-01-15" }} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^From / }));
    const dialog = screen.getByRole("dialog");
    // 15 Jan is `to` itself and must stay pickable; 16 Jan is past it.
    expect(
      within(dialog).getByRole("button", { name: /^Thursday, January 15th, 2026/ }),
    ).toBeEnabled();
    const pastEnd = within(dialog).getByRole("button", { name: /^Friday, January 16th, 2026/ });
    expect(pastEnd).toBeDisabled();

    fireEvent.click(pastEnd);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a deselect rather than emitting a range with a missing end", () => {
    // Clicking the already-selected day makes react-day-picker report
    // `undefined`. There is no "no date" state in a DateRange, so that has to
    // be a no-op -- the calendar's equivalent of the old empty-string guard.
    const onChange = vi.fn();
    render(<DateRangePicker value={VALUE} onChange={onChange} />);

    pickDay(within(document.body), "From", "Thursday, January 1st, 2026, selected");

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
    // copies of the same screen) from mounting at once. A literal `id` would
    // collide the moment that happens: invalid HTML, and queries start
    // throwing "found multiple elements" instead of resolving to one field.
    // Still relevant with the calendar: Radix generates ids for the popover's
    // trigger/content pairing, and those have to stay unique per instance.
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

    // One at a time: the popover renders into a portal outside both scopes,
    // so two open at once would make `getByRole("dialog")` ambiguous.
    pickDay(pickerA, "From", "Thursday, January 15th, 2026");
    expect(onChangeA).toHaveBeenCalledTimes(1);
    expect(onChangeA).toHaveBeenCalledWith({ from: "2026-01-15", to: "2026-01-31" });
    // B untouched by A's interaction — the cross-talk this test exists for.
    expect(onChangeB).not.toHaveBeenCalled();

    pickDay(pickerB, "To", "Friday, February 20th, 2026");
    expect(onChangeB).toHaveBeenCalledTimes(1);
    expect(onChangeB).toHaveBeenCalledWith({ from: "2026-02-01", to: "2026-02-20" });
    expect(onChangeA).toHaveBeenCalledTimes(1);
  });
});
