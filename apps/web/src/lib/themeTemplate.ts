/**
 * The starting point the custom-CSS editor is prefilled with when nothing is
 * saved yet: every theme token this app reads, at its current default.
 *
 * A blank textarea is a bad prompt — it tells an operator that custom CSS is
 * possible without telling them what is worth overriding, and the token names
 * are not guessable. Prefilling with the real values turns "write CSS" into
 * "change a hex code".
 *
 * This mirrors the `:root` block in `index.css`, and is duplicated rather than
 * imported because CSS custom properties are not readable from a module at
 * build time. `themeTemplate.test.ts` reads that stylesheet directly and fails
 * if the two ever disagree, so the copy cannot silently drift.
 */
export const THEME_TEMPLATE = `:root {
  --radius: 0.75rem;

  --background: #0a0b0e;
  --foreground: #eceef2;

  --card: #121319;
  --card-foreground: #eceef2;

  --popover: #16171f;
  --popover-foreground: #eceef2;

  --primary: #7c3aed;
  --primary-foreground: #faf9ff;

  --secondary: #1c1e26;
  --secondary-foreground: #eceef2;

  --muted: #171820;
  --muted-foreground: #9799a6;

  --accent: #1f2029;
  --accent-foreground: #eceef2;

  --destructive: #e5484d;
  --destructive-foreground: #faf9ff;

  --border: #22242e;
  --input: #22242e;
  --ring: #8b7cf9;
}
`;
