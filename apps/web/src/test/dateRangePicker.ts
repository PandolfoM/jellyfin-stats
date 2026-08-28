import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Day buttons in react-day-picker's grid are named with a full date, e.g.
 * "Thursday, January 15th, 2026", and the current selection has ", selected"
 * appended. The month-navigation buttons live in the same subtree and are the
 * reason this has to match on shape rather than just taking every button.
 */
const DAY_LABEL = /, \d{4}(, selected)?$/;

/**
 * Changes a route's `from` date through the real DateRangePicker and returns
 * the `YYYY-MM-DD` it landed on.
 *
 * Route tests care that *changing the range* refetches with the new value —
 * not which specific day was chosen — so this picks the first selectable day
 * in the open grid rather than computing a target and paging the calendar to
 * reach it. That also keeps these tests independent of the wall clock: the
 * default range ends "today", so any fixed target date would drift in and out
 * of the visible month depending on when the suite runs.
 *
 * The returned value is read back off the trigger *after* the click, so it is
 * whatever the component actually committed — a test asserting the request
 * used it cannot pass by coincidence against a value this helper predicted.
 */
export function changeFromDate(): string {
  fireEvent.click(screen.getByRole("button", { name: /^From / }));

  const dialog = screen.getByRole("dialog");
  const days = within(dialog)
    .getAllByRole("button")
    .filter((button) => DAY_LABEL.test(button.getAttribute("aria-label") ?? ""));

  // Skip the currently-selected day: clicking it deselects rather than
  // changing anything, and the calling test would then be asserting against a
  // range that never moved.
  const target = days.find(
    (button) =>
      !(button.getAttribute("aria-label") ?? "").endsWith("selected") &&
      !button.hasAttribute("disabled"),
  );

  if (target === undefined) {
    throw new Error("No selectable day in the From calendar");
  }

  fireEvent.click(target);

  return screen.getByRole("button", { name: /^From / }).textContent?.trim() ?? "";
}
