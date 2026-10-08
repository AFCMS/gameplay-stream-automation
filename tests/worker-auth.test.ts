import { afterEach, describe, expect, it, vi } from "vitest";

import { cookieHeader, cookieName, seal, unseal } from "../worker/cookies";
import { createAuthHandler, type AuthEnv } from "../worker/index";

const scope = "https://www.googleapis.com/auth/youtube";
const env: AuthEnv = {
  APP_ORIGIN: "https://streams.example.com",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  COOKIE_ENCRYPTION_KEY: btoa("a".repeat(32)),
};
const sessionName = cookieName(env.APP_ORIGIN, "session");
const loginName = cookieName(env.APP_ORIGIN, "login");

function request(path: string, cookie?: string, method = "GET", origin = env.APP_ORIGIN): Request {
  return new Request(`${env.APP_ORIGIN}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "POST" ? { Origin: origin, "X-GSA-Request": "1" } : {}),
    },
  });
}

function cookie(response: Response, name: string): string {
  const entry = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!entry) throw new Error("Cookie missing");
  return entry.split(";")[0];
}

function tokens(extra = {}) {
  return Response.json({
    access_token: "short-lived-token",
    refresh_token: "long-lived-token",
    expires_in: 3600,
    scope,
    ...extra,
  });
}

async function sessionCookie(expiresAt = Date.now() + 86400_000): Promise<string> {
  const value = await seal(
    { refreshToken: "long-lived-token", expiresAt },
    env.COOKIE_ENCRYPTION_KEY,
    `${env.APP_ORIGIN}:session`,
  );
  return `${sessionName}=${value}`;
}

async function loginCallback(handler: ReturnType<typeof createAuthHandler>, overrides = "") {
  const start = await handler(request("/auth/start"), env);
  const location = new URL(start.headers.get("Location")!);
  const state = location.searchParams.get("state")!;
  return handler(
    request(`/auth/callback?state=${state}&code=test-code${overrides}`, cookie(start, loginName)),
    env,
  );
}

afterEach(() => vi.useRealTimers());

describe("stateless Google authorization", () => {
  it("performs offline authorization with state and PKCE, then restores access in a fresh handler", async () => {
    const upstream = vi.fn<typeof fetch>(async () => tokens());
    const handler = createAuthHandler(upstream);
    const start = await handler(request("/auth/start"), env);
    const authorization = new URL(start.headers.get("Location")!);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${env.APP_ORIGIN}/auth/callback`);
    expect(start.headers.get("Cache-Control")).toBe("no-store");
    expect(start.headers.get("Set-Cookie")).toContain("Secure");
    expect(start.headers.get("Set-Cookie")).toContain("HttpOnly");

    const callback = await handler(
      request(
        `/auth/callback?state=${authorization.searchParams.get("state")}&code=code`,
        cookie(start, loginName),
      ),
      env,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe(`${env.APP_ORIGIN}/`);
    expect(callback.headers.get("Set-Cookie")).not.toContain("long-lived-token");
    const parameters = upstream.mock.calls[0][1]!.body as URLSearchParams;
    expect(parameters.get("client_secret")).toBe("test-secret");
    expect(parameters.get("grant_type")).toBe("authorization_code");
    expect(parameters.get("code_verifier")).toBeTruthy();

    const restored = await createAuthHandler(upstream)(
      request("/auth/token", cookie(callback, sessionName), "POST"),
      env,
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      accessToken: "short-lived-token",
      expiresAt: expect.any(Number),
    });
    expect((upstream.mock.calls[1][1]!.body as URLSearchParams).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(restored.headers.get("Cache-Control")).toBe("no-store");
    expect(restored.headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects mismatched state and does not exchange a code", async () => {
    const upstream = vi.fn<typeof fetch>();
    const handler = createAuthHandler(upstream);
    const start = await handler(request("/auth/start"), env);
    const result = await handler(
      request("/auth/callback?state=attacker&code=code", cookie(start, loginName)),
      env,
    );
    expect(result.headers.get("Location")).toBe(`${env.APP_ORIGIN}/?auth_error=state`);
    expect(upstream).not.toHaveBeenCalled();
    expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("handles consent cancellation and expired login cookies without exchanging codes", async () => {
    const upstream = vi.fn<typeof fetch>();
    const handler = createAuthHandler(upstream);
    expect(
      (await loginCallback(handler, "&error=access_denied")).headers.get("Location"),
    ).toContain("auth_error=cancelled");
    const start = await handler(request("/auth/start"), env);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const result = await handler(
      request(`/auth/callback?state=${state}&code=code`, cookie(start, loginName)),
      env,
    );
    expect(result.headers.get("Location")).toContain("auth_error=state");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never adopts an existing account's token when the new grant has no refresh token", async () => {
    const handler = createAuthHandler(async () => tokens({ refresh_token: undefined }));
    const result = await loginCallback(handler);
    expect(result.headers.get("Location")).toContain("auth_error=offline_access");
    expect(result.headers.getSetCookie().some((value) => value.startsWith(`${sessionName}=`))).toBe(
      false,
    );
  });

  it("rejects denied YouTube scopes", async () => {
    const result = await loginCallback(createAuthHandler(async () => tokens({ scope: "openid" })));
    expect(result.headers.get("Location")).toContain("auth_error=permissions");
  });

  it("encrypts cookies and rejects tampering, wrong keys, and different purposes/origins", async () => {
    const value = await seal(
      { secret: "refresh-token" },
      env.COOKIE_ENCRYPTION_KEY,
      "origin:session",
    );
    expect(value).not.toContain("refresh-token");
    expect(await unseal(value, env.COOKIE_ENCRYPTION_KEY, "origin:session")).toEqual({
      secret: "refresh-token",
    });
    expect(
      await unseal(`${value.slice(0, -4)}aaaa`, env.COOKIE_ENCRYPTION_KEY, "origin:session"),
    ).toBeNull();
    expect(await unseal(value, btoa("b".repeat(32)), "origin:session")).toBeNull();
    expect(await unseal(value, env.COOKIE_ENCRYPTION_KEY, "origin:login")).toBeNull();
    expect(await unseal(value, env.COOKIE_ENCRYPTION_KEY, "other:session")).toBeNull();
  });

  it("rejects absent, malformed, and expired sessions before contacting Google", async () => {
    const upstream = vi.fn<typeof fetch>();
    const handler = createAuthHandler(upstream);
    for (const saved of [
      undefined,
      `${sessionName}=invalid`,
      await sessionCookie(Date.now() - 1),
    ]) {
      const result = await handler(request("/auth/token", saved, "POST"), env);
      expect(result.status).toBe(401);
      expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests, missing CSRF headers, and unsupported methods", async () => {
    const upstream = vi.fn<typeof fetch>();
    const handler = createAuthHandler(upstream);
    const saved = await sessionCookie();
    expect(
      (await handler(request("/auth/token", saved, "POST", "https://evil.example"), env)).status,
    ).toBe(403);
    const missingHeader = request("/auth/logout", saved, "POST");
    missingHeader.headers.delete("X-GSA-Request");
    expect((await handler(missingHeader, env)).status).toBe(403);
    expect((await handler(request("/auth/token", saved), env)).status).toBe(405);
    expect((await handler(new Request("https://evil.example/auth/start"), env)).status).toBe(403);
    expect(
      (
        await handler(
          new Request(`${env.APP_ORIGIN}/auth/start`, {
            headers: { "Sec-Fetch-Site": "cross-site" },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("clears revoked sessions, but retains cookies during a temporary Google failure", async () => {
    const saved = await sessionCookie();
    const revoked = await createAuthHandler(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    )(request("/auth/token", saved, "POST"), env);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("Set-Cookie")).toContain("Max-Age=0");
    for (const upstream of [
      async () => Response.json({ error: "server_error" }, { status: 500 }),
      async () => {
        throw new Error("network");
      },
    ]) {
      const temporary = await createAuthHandler(upstream)(
        request("/auth/token", saved, "POST"),
        env,
      );
      expect(temporary.status).toBe(502);
      expect(temporary.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("rotates refresh tokens without extending the session deadline", async () => {
    const expiresAt = Date.now() + 60_000;
    const result = await createAuthHandler(async () => tokens({ refresh_token: "rotated" }))(
      request("/auth/token", await sessionCookie(expiresAt), "POST"),
      env,
    );
    const value = cookie(result, sessionName).slice(sessionName.length + 1);
    expect(await unseal(value, env.COOKIE_ENCRYPTION_KEY, `${env.APP_ORIGIN}:session`)).toEqual({
      refreshToken: "rotated",
      expiresAt,
    });
    expect(result.headers.get("Set-Cookie")).toMatch(/Max-Age=5[89]/);
  });

  it("clears cookies on logout and can explicitly revoke Google access", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const handler = createAuthHandler(upstream);
    const saved = await sessionCookie();
    const logout = await handler(request("/auth/logout", saved, "POST"), env);
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()).toHaveLength(2);
    expect(upstream).not.toHaveBeenCalled();
    const revoked = await handler(request("/auth/revoke", saved, "POST"), env);
    expect(revoked.status).toBe(204);
    expect(upstream.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/revoke");
  });

  it("uses unprefixed local cookies over localhost HTTP, and reports missing configuration safely", async () => {
    expect(cookieHeader("http://localhost:5173", "session", "value", 30)).toBe(
      "gsa_session=value; Path=/; HttpOnly; SameSite=Lax; Max-Age=30",
    );
    const response = await createAuthHandler()(request("/auth/start"), {
      ...env,
      GOOGLE_CLIENT_SECRET: "",
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("test-secret");
  });

  it("does not report a failed revocation as success or clear the cookie", async () => {
    const result = await createAuthHandler(async () =>
      Response.json({ error: "invalid_request" }, { status: 400 }),
    )(request("/auth/revoke", await sessionCookie(), "POST"), env);
    expect(result.status).toBe(502);
    expect(result.headers.get("Set-Cookie")).toBeNull();
  });

  it("treats malformed Google responses as temporary failures without deleting the session", async () => {
    const result = await createAuthHandler(async () => Response.json(null))(
      request("/auth/token", await sessionCookie(), "POST"),
      env,
    );
    expect(result.status).toBe(502);
    expect(result.headers.get("Set-Cookie")).toBeNull();
  });
});
