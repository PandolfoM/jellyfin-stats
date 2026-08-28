// @vitest-environment jsdom
//
// The editor's job is to never lose what the operator typed. Every test below
// is anchored on that: a save that fails keeps the draft, a save that succeeds
// leaves the textarea showing what was actually stored, and Clear stays
// reachable regardless of draft state because it is the way back from a
// stylesheet that has made the page hard to use.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { THEME_TEMPLATE } from "../../lib/themeTemplate";
import { SettingsCustomCssCard } from "./SettingsCustomCssCard";

function renderCard(overrides: Partial<Parameters<typeof SettingsCustomCssCard>[0]> = {}) {
  const onSave = vi.fn(async () => {});
  render(<SettingsCustomCssCard savedCss="" loading={false} onSave={onSave} {...overrides} />);
  return onSave;
}

const editor = () => screen.getByLabelText("Custom CSS") as HTMLTextAreaElement;

describe("SettingsCustomCssCard", () => {
  it("seeds the editor from the saved stylesheet", () => {
    renderCard({ savedCss: "body { color: red; }" });

    expect(editor()).toHaveValue("body { color: red; }");
  });

  it("prefills the theme tokens when nothing is saved", () => {
    // A blank textarea says custom CSS is possible without saying which tokens
    // exist, and the names are not guessable.
    renderCard({ savedCss: "" });

    expect(editor()).toHaveValue(THEME_TEMPLATE);
    expect(editor().value).toContain("--primary");
  });

  it("does not claim unsaved changes on first paint", () => {
    // The prefill is the dirty baseline, not just the initial text. Comparing
    // the draft against the saved empty string instead would light up "Unsaved
    // changes" before the operator touched anything, and offer to save a
    // stylesheet identical to the defaults.
    renderCard({ savedCss: "" });

    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("enables Save once the prefilled template is edited", () => {
    renderCard({ savedCss: "" });

    fireEvent.change(editor(), { target: { value: `${THEME_TEMPLATE}body { color: red; }` } });

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("prefers a saved stylesheet over the template", () => {
    // The template is a starting point for an empty configuration only; it must
    // never overwrite what the operator actually stored.
    renderCard({ savedCss: "body { color: red; }" });

    expect(editor().value).not.toContain("--primary");
  });

  it("shows a skeleton, not an empty editor, while settings are loading", () => {
    // An empty textarea during load looks exactly like "nothing is saved", and
    // an operator could save over their own stylesheet believing it was blank.
    renderCard({ savedCss: null, loading: true });

    expect(screen.queryByLabelText("Custom CSS")).not.toBeInTheDocument();
  });

  it("re-seeds when the saved value arrives after the first render", () => {
    const onSave = vi.fn(async () => {});
    const { rerender } = render(
      <SettingsCustomCssCard savedCss={null} loading={false} onSave={onSave} />,
    );

    rerender(<SettingsCustomCssCard savedCss="a {}" loading={false} onSave={onSave} />);

    expect(editor()).toHaveValue("a {}");
  });

  it("disables Save until the draft differs from what is stored", () => {
    renderCard({ savedCss: "a {}" });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(editor(), { target: { value: "b {}" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("submits the draft and reports success", async () => {
    const onSave = renderCard({ savedCss: "a {}" });

    fireEvent.change(editor(), { target: { value: "b {}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(onSave).toHaveBeenCalledWith("b {}");
  });

  it("keeps the draft and surfaces an error when saving fails", async () => {
    // The failure mode that would actually hurt: losing a stylesheet the
    // operator just wrote because the request happened to fail.
    const onSave = vi.fn(async () => {
      throw new Error("nope");
    });
    render(<SettingsCustomCssCard savedCss="a {}" loading={false} onSave={onSave} />);

    fireEvent.change(editor(), { target: { value: "b {}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(editor()).toHaveValue("b {}");
  });

  it("clears by saving an empty string, and returns the editor to the template", async () => {
    // Not a blank box: an empty editor would throw away the starting point the
    // operator needs to write the next stylesheet.
    const onSave = renderCard({ savedCss: "a {}" });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(""));
    expect(editor()).toHaveValue(THEME_TEMPLATE);
  });

  it("keeps Clear reachable even when the draft matches what is saved", () => {
    // Save is disabled in this state, but Clear must not be — this is the
    // recovery path from a stylesheet that has already been saved and has made
    // the page hard to use.
    renderCard({ savedCss: "a {}" });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
  });

  it("disables Clear only when there is genuinely nothing to clear", () => {
    renderCard({ savedCss: "" });

    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("drops a stale 'Saved' message once the draft changes again", async () => {
    renderCard({ savedCss: "a {}" });

    fireEvent.change(editor(), { target: { value: "b {}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());

    fireEvent.change(editor(), { target: { value: "c {}" } });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
