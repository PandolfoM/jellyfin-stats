import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { THEME_TEMPLATE } from "./themeTemplate";

/**
 * THEME_TEMPLATE hand-copies the `:root` block from index.css, because CSS
 * custom properties cannot be imported into a module. That copy is exactly the
 * kind of duplication that rots silently — a token renamed or recoloured in the
 * stylesheet would leave the editor prefilling values that no longer match what
 * the app actually renders, and nothing else would notice.
 *
 * So this reads the real stylesheet and compares. It is the whole reason the
 * duplication is acceptable.
 */
const cssPath = fileURLToPath(new URL("../index.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

/** `--name: value;` pairs from the first `:root { ... }` block only. */
function rootTokens(source: string): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
  // Comments are stripped first so a hex code mentioned inside one cannot be
  // mistaken for a declaration.
  const declarations = block.replace(/\/\*[\s\S]*?\*\//g, "");

  const tokens = new Map<string, string>();
  for (const match of declarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1] as string, (match[2] as string).trim());
  }
  return tokens;
}

describe("THEME_TEMPLATE", () => {
  it("lists exactly the tokens index.css defines on :root", () => {
    const fromCss = [...rootTokens(css).keys()].sort();
    const fromTemplate = [...rootTokens(THEME_TEMPLATE).keys()].sort();

    // Equality both ways: a token added to the stylesheet must appear in the
    // prefill, and a token removed must disappear from it.
    expect(fromTemplate).toEqual(fromCss);
  });

  it("uses the same value as index.css for every token", () => {
    const fromCss = rootTokens(css);
    const fromTemplate = rootTokens(THEME_TEMPLATE);

    for (const [name, value] of fromCss) {
      expect(fromTemplate.get(name), `token ${name}`).toBe(value);
    }
  });

  it("actually found tokens, so the two assertions above cannot pass vacuously", () => {
    // Both comparisons succeed trivially if the regex matches nothing — e.g.
    // after a refactor that reformats index.css beyond what it parses.
    expect(rootTokens(css).size).toBeGreaterThan(10);
  });
});
