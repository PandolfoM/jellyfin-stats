import { useState, type FormEvent } from "react";

import { LoginError, type LoginErrorCode, useSession } from "../auth/session";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  invalid_credentials: "That username or password was not accepted by Jellyfin.",
  not_an_administrator: "That account is not a Jellyfin administrator. This dashboard is admin-only.",
  too_many_attempts: "Too many attempts. Wait a few minutes and try again.",
  jellyfin_unavailable: "Could not reach your Jellyfin server. Check that it is running.",
  unknown_error: "Something went wrong signing in. Try again.",
};

const fieldClassName =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

export function LoginRoute() {
  const { login } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<LoginErrorCode | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // Read straight from FormData at submit time — the password is never
    // assigned to component state, only forwarded to the request.
    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") ?? "");
    const password = String(formData.get("password") ?? "");

    setSubmitting(true);
    setErrorCode(null);

    try {
      await login(username, password);
    } catch (err) {
      setErrorCode(err instanceof LoginError ? err.code : "unknown_error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Sign in with your Jellyfin administrator account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-sm font-medium">
                Username
              </label>
              {/* Uncontrolled on purpose: a failed submit does not clear this field —
                  retyping it is a small insult after a failed login — and an
                  uncontrolled input keeps that value without any extra state. */}
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                disabled={submitting}
                className={fieldClassName}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={submitting}
                className={fieldClassName}
              />
            </div>
            {errorCode !== null && (
              <p role="alert" className="text-sm text-destructive">
                {ERROR_MESSAGES[errorCode]}
              </p>
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
