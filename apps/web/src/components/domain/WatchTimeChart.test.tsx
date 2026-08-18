// @vitest-environment jsdom
//
// Recharts' `ResponsiveContainer` measures its DOM node before it renders
// anything, using `ResizeObserver` and `getBoundingClientRect`. jsdom
// implements neither with real layout — both report zero — so without this
// polyfill the chart renders an empty container and every assertion below
// would pass vacuously (0 dots because nothing rendered, not because the
// data was handled correctly). The mock gives the container a fixed,
// nonzero size so Recharts actually lays out the chart's SVG.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SeriesResponse } from "../../api/queries";
import { type DayPoint, WatchTimeChart } from "./WatchTimeChart";

// `beforeEach`, not `beforeAll`: the root vitest.config.ts sets
// `unstubGlobals: true`, which unstubs every `vi.stubGlobal` before each
// test runs. A one-time `beforeAll` stub would apply to the first test only
// and silently vanish for the rest of this file's tests.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 280 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 600, height: 280, top: 0, left: 0, right: 600, bottom: 280, x: 0, y: 0, toJSON() {} }) as DOMRect;

  class MockResizeObserver implements ResizeObserver {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      this.#callback(
        [{ target, contentRect: { width: 600, height: 280 } } as unknown as ResizeObserverEntry],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => vi.restoreAllMocks());

const POINTS: SeriesResponse = [
  { day: "2026-01-01", plays: 0, watchMs: 0 },
  { day: "2026-01-02", plays: 3, watchMs: 120_000 },
  { day: "2026-01-03", plays: 0, watchMs: 0 },
  { day: "2026-01-04", plays: 1, watchMs: 6_000 },
  { day: "2026-01-05", plays: 0, watchMs: 0 },
];

describe("WatchTimeChart", () => {
  it("shows a skeleton, not a chart, while loading", () => {
    render(<WatchTimeChart points={POINTS} loading />);

    expect(document.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeInTheDocument();
  });

  it("renders exactly one point per day, including the zero-watch days", () => {
    render(<WatchTimeChart points={POINTS} loading={false} />);

    // The concrete failure this catches: an implementation that filters
    // `points` down to non-zero days (e.g. `points.filter((p) => p.watchMs >
    // 0)`) before handing them to the chart would render 2 dots instead of
    // 5, reintroducing the gap-connecting distortion the server's
    // `generate_series` zero-fill exists to prevent.
    const dots = document.querySelectorAll(".recharts-dot");
    expect(dots).toHaveLength(POINTS.length);
  });

  it("renders a single continuous area path rather than a gap around the zero days", () => {
    render(<WatchTimeChart points={POINTS} loading={false} />);

    // Recharts always renders exactly one `.recharts-area-area` <path> DOM
    // node for a single Area, whether or not its data has gaps — so a bare
    // element-count assertion here would pass regardless of what happened to
    // the zero days (a hollow check). What actually changes across a gap is
    // the `d` attribute: a null/undefined value breaks the path into a new
    // "M" (moveto) subpath, so a continuous run of real values — zeros
    // included — must produce exactly one "M" for the whole span. A
    // zero-to-null regression (as distinct from the zero-to-filtered-out
    // regression the dot-count test above catches) would raise this above 1.
    const areaPath = document.querySelector(".recharts-area-area");
    const d = areaPath?.getAttribute("d") ?? "";
    expect(d.match(/M/g)).toHaveLength(1);
  });

  it("renders an empty state instead of an empty chart when there are no points", () => {
    render(<WatchTimeChart points={[]} loading={false} />);

    expect(screen.getByText("No watch time yet")).toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeInTheDocument();
  });
});

/**
 * Type-only compile-time guard, checked by `tsc --build` (`pnpm typecheck`)
 * and never executed by `vitest run` — the same mechanism as the seven
 * field-access guards in `queries.test.ts` and the four RPC-chain guards in
 * `client.test.ts`.
 *
 * `WatchTimeChart.tsx` derives its tooltip's `DayPoint` type from
 * `SeriesResponse[number]` (`type DayPoint = SeriesResponse[number]`) rather
 * than restating the shape by hand, precisely so it can't silently drift
 * from the wire type the way a hand-written literal did before this guard
 * existed. This checks the derivation holds in *both* directions rather than
 * just one: a `DayPoint` narrowed relative to `SeriesResponse[number]` (a
 * dropped or renamed field) fails the first line below; a `DayPoint`
 * widened relative to it (an extra field nothing in `SeriesResponse` has)
 * fails the second. Either failure means `AssertTrue` can't resolve its
 * argument to `true` and `pnpm typecheck` goes red — which is the direction
 * that actually matters here, since the runtime failure mode (a stale field
 * silently read as `undefined` in the tooltip) produces no crash and no
 * test failure on its own.
 */
type AssertTrue<T extends true> = T;
type _DayPointIsNotNarrowerThanSeriesPoint = AssertTrue<DayPoint extends SeriesResponse[number] ? true : false>;
type _DayPointIsNotWiderThanSeriesPoint = AssertTrue<SeriesResponse[number] extends DayPoint ? true : false>;
