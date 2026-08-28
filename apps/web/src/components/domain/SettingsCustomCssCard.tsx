import { useEffect, useState } from "react";

import { THEME_TEMPLATE } from "../../lib/themeTemplate";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";

export interface SettingsCustomCssCardProps {
  /** The saved stylesheet. `null` while the settings query is still resolving. */
  savedCss: string | null;
  loading: boolean;
  /** Resolves once the value is persisted; rejects to surface a save failure. */
  onSave: (css: string) => Promise<void>;
}

/**
 * Editor for the operator's custom stylesheet, mirroring Jellyfin's own
 * Dashboard → General → Custom CSS.
 *
 * Unlike `SettingsConfigCard`, which renders env-derived values that genuinely
 * cannot be changed at runtime, this one is editable — it is backed by
 * `PUT /api/settings/custom-css` and the `app_settings` table.
 *
 * The draft is local state seeded from `savedCss`, so typing does not refetch
 * and an unsaved edit is visibly distinct from the stored value. The seeding
 * effect deliberately keys on `savedCss` alone: it re-seeds when the *saved*
 * value changes (first load, or after a save invalidates the query), and not
 * on every keystroke, which would fight the user for control of the textarea.
 *
 * With nothing saved, the editor is prefilled with `THEME_TEMPLATE` — every
 * theme token at its current value. A blank textarea says custom CSS is
 * possible without saying what is worth overriding, and the token names are
 * not guessable; the prefill turns "write CSS" into "change a hex code".
 *
 * That prefill is the dirty-check baseline too, not just the initial text.
 * Comparing against `savedCss` directly would mark the card dirty on first
 * paint, before the operator had touched anything, and offer to save a
 * stylesheet identical to the defaults.
 */
export function SettingsCustomCssCard({ savedCss, loading, onSave }: SettingsCustomCssCardProps) {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (savedCss === null) return;
    setDraft(savedCss === "" ? THEME_TEMPLATE : savedCss);
  }, [savedCss]);

  // What "unchanged" means: the stored stylesheet if there is one, otherwise
  // the template the editor was prefilled with.
  const baseline = savedCss === null ? null : savedCss === "" ? THEME_TEMPLATE : savedCss;
  const dirty = baseline !== null && draft !== baseline;

  async function save(next: string) {
    setStatus("saving");
    try {
      await onSave(next);
      // Clearing stores an empty string; the editor returns to the template
      // rather than a blank box, so it stays a usable starting point.
      setDraft(next === "" ? THEME_TEMPLATE : next);
      setStatus("saved");
    } catch {
      // Left on screen rather than thrown: a failed save must not lose the
      // draft the operator just typed.
      setStatus("error");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom CSS</CardTitle>
        <CardDescription>
          Applied to this dashboard for everyone who signs in. The sign-in screen is deliberately
          excluded, so a broken rule can never stop you getting back here to fix it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Textarea
            aria-label="Custom CSS"
            spellCheck={false}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              // Any edit invalidates the previous outcome message, so a stale
              // "Saved" never sits above text that is no longer what was saved.
              setStatus("idle");
            }}
            placeholder={THEME_TEMPLATE}
            className="min-h-40 font-mono text-xs"
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={loading || status === "saving" || !dirty}
            onClick={() => void save(draft)}
          >
            {status === "saving" ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            // Enabled whenever anything is stored or drafted. This is the way
            // back from a stylesheet that has made the page hard to use, so it
            // must not depend on the draft being dirty.
            disabled={
              loading || status === "saving" || (draft === THEME_TEMPLATE && savedCss === "")
            }
            onClick={() => void save("")}
          >
            Clear
          </Button>

          {status === "saved" && (
            <span role="status" className="text-sm text-muted-foreground">
              Saved
            </span>
          )}
          {status === "error" && (
            <span role="alert" className="text-sm text-destructive">
              Could not save. Your changes are still here — try again.
            </span>
          )}
          {status !== "saved" && status !== "error" && dirty && (
            <span className="text-sm text-muted-foreground">Unsaved changes</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
