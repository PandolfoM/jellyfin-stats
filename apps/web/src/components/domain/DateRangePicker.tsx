import type { ChangeEvent } from "react";

import { cn } from "../../lib/cn";
import { clampRangeDays, type DateRange } from "../../lib/range";
import { Button } from "../ui/button";

export interface DateRangePreset {
  label: string;
  range: DateRange;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  /**
   * Fully-resolved ranges, not day counts — the picker does no date math of
   * its own beyond `clampRangeDays`, so "last 7 days" has to already mean a
   * concrete `{ from, to }` by the time it gets here. That keeps this
   * component ignorant of what "now" is, which is what makes it a props-only
   * domain component rather than one with an implicit dependency on the
   * clock.
   */
  presets?: DateRangePreset[];
  className?: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const fieldClassName =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

/**
 * A controlled from/to date range control: it renders `value`, calls
 * `onChange` with the next range, and otherwise holds no state and fetches
 * nothing — the route that renders it owns whatever query `value` feeds.
 *
 * Every range this emits, whether from typing a date or from a preset, is
 * run through `clampRangeDays` first. That is what keeps this a *reusable*
 * control rather than one the caller has to defend against: it can never
 * hand back a reversed pair or a span past the API's MAX_RANGE_DAYS cap, so
 * nothing downstream has to catch an `invalid_range` response that
 * originated here.
 */
export function DateRangePicker({ value, onChange, presets, className }: DateRangePickerProps) {
  function handleFromChange(event: ChangeEvent<HTMLInputElement>) {
    const from = event.target.value;
    if (!DAY_PATTERN.test(from)) return;
    onChange(clampRangeDays({ from, to: value.to }));
  }

  function handleToChange(event: ChangeEvent<HTMLInputElement>) {
    const to = event.target.value;
    if (!DAY_PATTERN.test(to)) return;
    onChange(clampRangeDays({ from: value.from, to }));
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      {presets !== undefined && presets.length > 0 && (
        <div role="group" aria-label="Date range presets" className="flex flex-wrap gap-1">
          {presets.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(clampRangeDays(preset.range))}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor="date-range-from" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          From
          <input
            id="date-range-from"
            type="date"
            value={value.from}
            max={value.to}
            onChange={handleFromChange}
            className={fieldClassName}
          />
        </label>
        <label htmlFor="date-range-to" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          To
          <input
            id="date-range-to"
            type="date"
            value={value.to}
            min={value.from}
            onChange={handleToChange}
            className={fieldClassName}
          />
        </label>
      </div>
    </div>
  );
}
