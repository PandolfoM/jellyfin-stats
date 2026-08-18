// @vitest-environment jsdom
//
// session.test.tsx's "surfaces the API's distinct login failures as distinct
// errors" test only proves `status` returns to "anonymous" for each of the
// four codes — it pushes the loop's own constant into `seen` unconditionally,
// so it would still pass even if every status mapped to the same message.
// This file closes that gap by asserting the actual rendered text per code,
// which is what the brief's message table is really pinning.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../auth/session";
import { LoginRoute } from "./login";

afterEach(() => vi.restoreAllMocks());

function mockFetch(loginStatus: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/auth/login")) {
        return new Response(JSON.stringify({ error: "does-not-matter" }), { status: loginStatus });
      }
      // /api/auth/me — session status is irrelevant to this component's own
      // rendering, only `login` needs to exist on the context.
      return new Response("{}", { status: 401 });
    }),
  );
}

function renderLoginRoute() {
  return render(
    <SessionProvider>
      <LoginRoute />
    </SessionProvider>,
  );
}

async function submit(username: string, password: string) {
  await userEvent.type(screen.getByLabelText("Username"), username);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginRoute", () => {
  it.each([
    [401, "That username or password was not accepted by Jellyfin."],
    [403, "That account is not a Jellyfin administrator. This dashboard is admin-only."],
    [429, "Too many attempts. Wait a few minutes and try again."],
    [503, "Could not reach your Jellyfin server. Check that it is running."],
  ])("renders the specific message for a %i response", async (status, message) => {
    mockFetch(status);
    renderLoginRoute();

    await submit("admin", "wrong-password");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
  });

  it("does not clear the username field after a failed login", async () => {
    mockFetch(401);
    renderLoginRoute();

    const usernameInput = screen.getByLabelText("Username");
    await submit("admin", "wrong-password");

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(usernameInput).toHaveValue("admin");
  });

  it("disables the submit button while the request is in flight", async () => {
    let resolveLogin: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/api/auth/login")) {
          return new Promise<Response>((resolve) => {
            resolveLogin = resolve;
          });
        }
        return new Response("{}", { status: 401 });
      }),
    );
    renderLoginRoute();

    const submitButton = screen.getByRole("button", { name: /sign in/i });
    await userEvent.type(screen.getByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "secret");
    await userEvent.click(submitButton);

    await waitFor(() => expect(submitButton).toBeDisabled());

    resolveLogin(new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 }));

    await waitFor(() => expect(submitButton).not.toBeDisabled());
  });
});
