import {
  cookieHeader,
  cookieName,
  pkceChallenge,
  randomValue,
  readCookie,
  seal,
  unseal,
} from "./cookies";

export interface AuthEnv {
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;

interface Session {
  refreshToken: string;
  expiresAt: number;
}

interface Login {
  state: string;
  verifier: string;
  expiresAt: number;
}

interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
}

class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function originFor(request: Request, env: AuthEnv): string {
  if (!env.APP_ORIGIN) {
    throw new AuthError(
      503,
      "configuration",
      "Configure the Worker's APP_ORIGIN and Google OAuth secrets before connecting.",
    );
  }
  const url = new URL(env.APP_ORIGIN);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    env.APP_ORIGIN !== url.origin ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new AuthError(
      503,
      "configuration",
      "APP_ORIGIN must be an HTTPS origin, or localhost for development.",
    );
  }
  if (new URL(request.url).origin !== url.origin) {
    throw new AuthError(403, "origin", "This origin is not configured for Google authorization.");
  }
  return url.origin;
}

function requireSecrets(env: AuthEnv) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.COOKIE_ENCRYPTION_KEY) {
    throw new AuthError(
      503,
      "configuration",
      "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and COOKIE_ENCRYPTION_KEY on the Worker.",
    );
  }
}

function requireBrowserPost(request: Request, origin: string) {
  if (request.headers.get("Origin") !== origin || request.headers.get("X-GSA-Request") !== "1") {
    throw new AuthError(403, "csrf", "The authorization request must come from this app.");
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function redirect(url: string): Response {
  return new Response(null, { status: 303, headers: { Location: url } });
}

function isSession(value: unknown): value is Session {
  return (
    !!value &&
    typeof value === "object" &&
    "refreshToken" in value &&
    typeof value.refreshToken === "string" &&
    !!value.refreshToken &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number" &&
    value.expiresAt > Date.now()
  );
}

function isLogin(value: unknown): value is Login {
  return (
    !!value &&
    typeof value === "object" &&
    "state" in value &&
    typeof value.state === "string" &&
    "verifier" in value &&
    typeof value.verifier === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number" &&
    value.expiresAt > Date.now()
  );
}

export function createAuthHandler(fetcher: typeof fetch = fetch) {
  async function googleTokens(
    env: AuthEnv,
    parameters: Record<string, string>,
  ): Promise<GoogleTokens> {
    let response: Response;
    try {
      response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          ...parameters,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AuthError(
        502,
        "google_unavailable",
        "Google could not be reached. Please try again.",
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    const data = (payload && typeof payload === "object" ? payload : {}) as GoogleTokens;
    if (data.error === "invalid_grant") {
      throw new AuthError(
        401,
        "expired",
        "Your Google connection expired or was revoked. Reconnect to continue.",
      );
    }
    if (
      !response.ok ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 30
    ) {
      throw new AuthError(
        502,
        "google_unavailable",
        "Google did not return a valid access token. Please try again.",
      );
    }
    if (
      data.scope !== undefined &&
      (typeof data.scope !== "string" || !data.scope.split(" ").includes(YOUTUBE_SCOPE))
    ) {
      throw new AuthError(401, "permissions", "Grant YouTube access when reconnecting Google.");
    }
    return data;
  }

  async function sessionFor(
    request: Request,
    env: AuthEnv,
    origin: string,
  ): Promise<Session | null> {
    const cookie = readCookie(request, cookieName(origin, "session"));
    if (!cookie) return null;
    requireSecrets(env);
    const session = await unseal(cookie, env.COOKIE_ENCRYPTION_KEY, `${origin}:session`);
    return isSession(session) ? session : null;
  }

  async function route(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true });
    }
    const methods: Record<string, string> = {
      "/auth/start": "GET",
      "/auth/callback": "GET",
      "/auth/token": "POST",
      "/auth/logout": "POST",
      "/auth/revoke": "POST",
    };
    const method = methods[url.pathname];
    if (!method) return json({ error: "not_found", message: "Endpoint not found." }, 404);
    if (request.method !== method) {
      const response = json({ error: "method", message: "Method not allowed." }, 405);
      response.headers.set("Allow", method);
      return response;
    }
    const origin = originFor(request, env);
    if (method === "POST") requireBrowserPost(request, origin);

    if (url.pathname === "/auth/start") {
      const site = request.headers.get("Sec-Fetch-Site");
      if (site && site !== "same-origin" && site !== "none") {
        throw new AuthError(403, "csrf", "Start Google authorization from this app.");
      }
      requireSecrets(env);
      const login: Login = {
        state: randomValue(),
        verifier: randomValue(),
        expiresAt: Date.now() + LOGIN_SECONDS * 1000,
      };
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${origin}/auth/callback`,
        response_type: "code",
        scope: YOUTUBE_SCOPE,
        access_type: "offline",
        prompt: "consent select_account",
        state: login.state,
        code_challenge: await pkceChallenge(login.verifier),
        code_challenge_method: "S256",
      }).toString();
      const response = redirect(authorization.href);
      response.headers.append(
        "Set-Cookie",
        cookieHeader(
          origin,
          "login",
          await seal(login, env.COOKIE_ENCRYPTION_KEY, `${origin}:login`),
          LOGIN_SECONDS,
        ),
      );
      return response;
    }

    if (url.pathname === "/auth/callback") {
      requireSecrets(env);
      const cookie = readCookie(request, cookieName(origin, "login"));
      const login = cookie
        ? await unseal(cookie, env.COOKIE_ENCRYPTION_KEY, `${origin}:login`)
        : null;
      let response: Response;
      try {
        if (!isLogin(login) || login.state !== url.searchParams.get("state")) {
          throw new AuthError(400, "state", "Google sign-in expired. Please try again.");
        }
        if (url.searchParams.has("error")) {
          throw new AuthError(400, "cancelled", "Google authorization was cancelled.");
        }
        const code = url.searchParams.get("code");
        if (!code)
          throw new AuthError(400, "state", "Google did not return an authorization code.");
        const tokens = await googleTokens(env, {
          grant_type: "authorization_code",
          code,
          redirect_uri: `${origin}/auth/callback`,
          code_verifier: login.verifier,
        });
        // Never reuse another account's existing refresh token after an account switch.
        if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
          throw new AuthError(400, "offline_access", "Reconnect Google and grant offline access.");
        }
        const seconds = Math.floor(
          Math.min(SESSION_SECONDS, tokens.refresh_token_expires_in ?? SESSION_SECONDS),
        );
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new AuthError(
            401,
            "expired",
            "Google's offline access has expired. Reconnect to continue.",
          );
        }
        const session: Session = {
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + seconds * 1000,
        };
        response = redirect(`${origin}/`);
        response.headers.append(
          "Set-Cookie",
          cookieHeader(
            origin,
            "session",
            await seal(session, env.COOKIE_ENCRYPTION_KEY, `${origin}:session`),
            seconds,
          ),
        );
      } catch (error) {
        // Only fixed error codes leave the Worker; Google responses and credentials never do.
        const code = error instanceof AuthError ? error.code : "configuration";
        response = redirect(`${origin}/?auth_error=${code}`);
      }
      response.headers.append("Set-Cookie", cookieHeader(origin, "login", "", 0));
      return response;
    }

    if (url.pathname === "/auth/logout" || url.pathname === "/auth/revoke") {
      if (url.pathname === "/auth/revoke") {
        const session = await sessionFor(request, env, origin);
        if (session) {
          let result: Response;
          try {
            result = await fetcher("https://oauth2.googleapis.com/revoke", {
              method: "POST",
              body: new URLSearchParams({ token: session.refreshToken }),
              signal: AbortSignal.timeout(15_000),
            });
          } catch {
            throw new AuthError(
              502,
              "google_unavailable",
              "Google could not be reached. Please try revoking again.",
            );
          }
          const data = result.ok
            ? null
            : ((await result.json().catch(() => null)) as { error?: string } | null);
          if (!result.ok && !(result.status === 400 && data?.error === "invalid_token")) {
            throw new AuthError(
              502,
              "google_unavailable",
              "Google could not revoke access. Please try again.",
            );
          }
        }
      }
      const response = new Response(null, { status: 204 });
      response.headers.append("Set-Cookie", cookieHeader(origin, "session", "", 0));
      response.headers.append("Set-Cookie", cookieHeader(origin, "login", "", 0));
      return response;
    }

    const session = await sessionFor(request, env, origin);
    if (!session) {
      const response = json(
        { error: "unauthenticated", message: "Connect YouTube to continue." },
        401,
      );
      response.headers.append("Set-Cookie", cookieHeader(origin, "session", "", 0));
      return response;
    }
    try {
      const tokens = await googleTokens(env, {
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      });
      const response = json({
        accessToken: tokens.access_token,
        expiresAt: Date.now() + tokens.expires_in! * 1000,
      });
      // Preserve the absolute session deadline; refreshes do not extend sessions indefinitely.
      if (
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token &&
        tokens.refresh_token !== session.refreshToken
      ) {
        const updated = { ...session, refreshToken: tokens.refresh_token };
        response.headers.append(
          "Set-Cookie",
          cookieHeader(
            origin,
            "session",
            await seal(updated, env.COOKIE_ENCRYPTION_KEY, `${origin}:session`),
            Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
          ),
        );
      }
      return response;
    } catch (error) {
      if (!(error instanceof AuthError) || error.status !== 401) throw error;
      const response = json({ error: error.code, message: error.message }, 401);
      response.headers.append("Set-Cookie", cookieHeader(origin, "session", "", 0));
      return response;
    }
  }

  return async (request: Request, env: AuthEnv): Promise<Response> => {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      response =
        error instanceof AuthError
          ? json({ error: error.code, message: error.message }, error.status)
          : json(
              {
                error: "configuration",
                message: "Authorization is unavailable. Check the Worker's configuration.",
              },
              503,
            );
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  };
}

export default { fetch: createAuthHandler() };
