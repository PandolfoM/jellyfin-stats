import * as React from "react";

import { cn } from "../../lib/cn";

/**
 * A plain native `<select>`, styled to match the other form controls in
 * `ui/` (`DateRangePicker`'s `<input type="date">`, `history.tsx`'s old text
 * inputs). Not a Radix/Headless combobox — this repo has no such dependency
 * yet, and a native element is all a "pick one of a short, known list of
 * options" control needs. Generic and domain-free like every other file in
 * `ui/`: it takes no opinion on what the options are, only how the control
 * looks. `history.tsx` is the first caller, using it to replace raw-GUID
 * text inputs with name-backed pickers.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { Select };
