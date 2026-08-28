import { useState } from "react";

import { cn } from "../../lib/cn";
import { clampRangeDays, type DateRange } from "../../lib/range";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

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

/**
 * `YYYY-MM-DD` to a Date positioned at LOCAL midnight, which is the only
 * position that makes react-day-picker highlight the intended square.
 *
 * Deliberately not `new Date(day)`: that parses a bare date string as UTC
 * midnight, which the calendar then renders through local accessors and draws
 * as the *previous* day for anyone west of Greenwich. Same trap `formatDay`
 * and `parseUtcDay` document — this is the mirror of it, and the reason the
 * two conversions here are hand-rolled rather than one `toISOString()` call.
 */
function dayToDate(day: string): Date | undefined {
  if (!DAY_PATTERN.test(day)) return undefined;
  // Destructuring would give `number | undefined` under noUncheckedIndexedAccess,
  // even though the pattern above guarantees exactly three parts.
  const parts = day.split("-").map(Number);
  return new Date(parts[0] as number, (parts[1] as number) - 1, parts[2] as number);
}

/**
 * The inverse, reading the same local fields `dayToDate` wrote. Never
 * `toISOString()`, which would convert to UTC first and shift the day back
 * across midnight in any negative offset.
 */
function dateToDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * A controlled from/to date range control: it renders `value`, calls
 * `onChange` with the next range, and otherwise holds no state beyond which
 * popover is open and fetches nothing — the route that renders it owns
 * whatever query `value` feeds.
 *
 * Every range this emits, whether from picking a date or from a preset, is
 * run through `clampRangeDays` first. That is what keeps this a *reusable*
 * control rather than one the caller has to defend against: it can never
 * hand back a reversed pair or a span past the API's MAX_RANGE_DAYS cap, so
 * nothing downstream has to catch an `invalid_range` response that
 * originated here.
 *
 * The two endpoints are separate single-date calendars rather than one
 * `mode="range"` calendar. A range calendar has an intermediate state where
 * only one end is chosen, which would either emit a half-range or require
 * this component to hold a draft — and holding a draft is exactly what makes
 * a controlled component start disagreeing with its own `value` prop.
 */
export function DateRangePicker({ value, onChange, presets, className }: DateRangePickerProps) {
  const [openField, setOpenField] = useState<"from" | "to" | null>(null);

  function handleSelect(field: "from" | "to", date: Date | undefined) {
    // react-day-picker calls back with `undefined` when the selected day is
    // clicked again to deselect it. There is no "no date" state to represent
    // here, so that is a no-op rather than a range with a missing end.
    if (date === undefined) return;
    const day = dateToDay(date);
    onChange(
      clampRangeDays(
        field === "from" ? { from: day, to: value.to } : { from: value.from, to: day },
      ),
    );
    setOpenField(null);
  }

  function field(name: "from" | "to", label: string, day: string) {
    const selected = dayToDate(day);

    return (
      <div className="flex items-center gap-1.5">
        {/*
          The trigger is a `<button>`, which a `<label>` cannot be associated
          with the way it could with the `<input type="date">` this replaced —
          so the accessible name is set directly on the button instead. It has
          to carry the field name, not just the date, because "From" and "To"
          are otherwise indistinguishable to a screen reader; and it must not
          be a page-unique `id`, since two pickers can render at once.
        */}
        <span className="text-sm text-muted-foreground">{label}</span>
        <Popover
          open={openField === name}
          onOpenChange={(open) => setOpenField(open ? name : null)}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`${label} ${day}`}
              className="font-normal tabular-nums"
            >
              {day}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              autoFocus
              selected={selected}
              defaultMonth={selected}
              onSelect={(date) => handleSelect(name, date)}
              // Mirrors the `min`/`max` the native inputs carried: the
              // out-of-order days are unreachable rather than merely swapped
              // after the fact by `clampRangeDays`. The clamp stays as the
              // real guarantee, since presets bypass this entirely.
              disabled={
                name === "from"
                  ? { after: dayToDate(value.to) ?? new Date(8.64e15) }
                  : { before: dayToDate(value.from) ?? new Date(-8.64e15) }
              }
            />
          </PopoverContent>
        </Popover>
      </div>
    );
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
        {field("from", "From", value.from)}
        {field("to", "To", value.to)}
      </div>
    </div>
  );
}
