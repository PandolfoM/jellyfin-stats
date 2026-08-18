export interface PanelErrorProps {
  testId: string;
}

/**
 * A single panel's error fallback for a route container that owns one or
 * more queries independently and must not let one failing query blank a
 * panel that loaded fine. Deliberately route-layout scaffolding rather than
 * a `domain/` component — it renders no data of its own, only the
 * "something broke" state a route falls back to.
 *
 * Originally local to `routes/index.tsx` with a comment reserving
 * promotion for "if a second route ends up needing the same fallback,
 * that's the point to promote it, not before." `routes/history.tsx`'s
 * single `history` query needed the identical fallback, which is that
 * second route.
 */
export function PanelError({ testId }: PanelErrorProps) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"
    >
      Could not load this data. Try again.
    </div>
  );
}
