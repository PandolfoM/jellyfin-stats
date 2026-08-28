import { useQuery } from "@tanstack/react-query";

import { settingsQuery } from "../../api/queries";

/**
 * Injects the operator's saved stylesheet.
 *
 * Rendered inside `AppShell` and nowhere else, which is the whole safety
 * story: the sign-in screen renders outside the shell, so no custom rule can
 * hide the login form and lock an operator out of the screen where they would
 * fix it. The worst case is a dashboard that looks wrong but is still
 * reachable, with a Clear button on the Settings page.
 *
 * `<style>` with a text child, never `dangerouslySetInnerHTML`. React escapes
 * the child, so the string cannot close the tag and inject markup — CSS is
 * inert, but `</style><script>` inside it would not be. That is the one real
 * escalation path here and it is closed by construction rather than by
 * sanitising.
 *
 * The query is shared with the Settings screen, so this costs no extra request
 * on a route that already reads settings, and a save that invalidates
 * `queryKeys.settings()` re-renders this with the new stylesheet immediately.
 */
export function CustomCssStyle() {
  const css = useQuery(settingsQuery()).data?.customCss ?? "";

  if (css === "") return null;

  return <style data-testid="custom-css">{css}</style>;
}
