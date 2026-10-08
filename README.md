# Gameplay Stream Automation

> [!WARNING]
> Mostly LLM generated and intended for private use. Use at your own risk.

React SPA for managing gameplay playlists and preparing public YouTube broadcasts for OBS. Cloudflare Workers serves the Vite frontend and Google authorization endpoints. There is no server database: the library is stored in IndexedDB, refresh tokens live in encrypted HttpOnly browser cookies, and access tokens stay in memory.

## Setup

Requires Node 24, pnpm 12, and Tampermonkey.

```sh
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
openssl rand -base64 32
```

Configure `.dev.vars` with a Google OAuth **Web application** client's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Enable YouTube Data API v3 and register `http://localhost:5173/auth/callback` as an **authorized redirect URI**. Add your account as a consent-screen test user if needed. The app requests `https://www.googleapis.com/auth/youtube` using the server authorization code flow with offline access, OAuth state, and PKCE.

Put the generated 32-byte base64 key in `COOKIE_ENCRYPTION_KEY`. Set `APP_ORIGIN=http://localhost:5173` in `.dev.vars` and the matching `VITE_APP_ORIGIN` in `.env`. Never put the client secret or encryption key in `VITE_*` variables. `.dev.vars` is ignored by Git; `.dev.vars.example` contains placeholders only.

```sh
pnpm dev
```

Open `http://localhost:5173` (not `127.0.0.1`). Vite runs frontend HMR and the backend in the local Workers runtime together. Install the userscript via **Install helper**, then reload the app and YouTube Studio. Sign in to Studio with the connected channel and run **Check connection**. Keep a Studio tab open when game assignment requires it; exact game selection uses undocumented Studio APIs.

## Persistent Google connection

**Connect YouTube** redirects through Google's account selection and consent screen and returns to the app. Reloads restore the session automatically. Access tokens renew before expiry, when a tab wakes, and before API requests if needed. Renewal reads the channel list again and stops writes if the connected channel changes. YouTube API calls continue to run directly from the browser; Studio authorization remains separate.

The Worker uses AES-256-GCM encryption bound to the origin and cookie purpose. HTTPS cookies use `__Host-`, `Secure`, `HttpOnly`, and `SameSite=Lax`; localhost HTTP uses unprefixed HttpOnly cookies. Sessions last at most 30 days from login, or less if Google specifies a shorter refresh-token lifetime. Renewal does not extend that deadline. Clearing cookies or an expired/revoked Google grant requires reconnecting.

External OAuth projects in **Testing** receive refresh tokens that expire after seven days for the YouTube scope. Production status removes that testing-specific limit; Google can still invalidate grants. See [Google's expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

**Disconnect** clears this browser's session without revoking the grant on other devices. Without a database, a copied cookie cannot be individually invalidated. Revoking Google access invalidates the grant; rotating the encryption key invalidates all app sessions. Cookies and tokens are excluded from library backups.

The backend exposes:

| Endpoint             | Behavior                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `GET /auth/start`    | Start Google authorization                                          |
| `GET /auth/callback` | Validate state, exchange the code, set the encrypted session cookie |
| `POST /auth/token`   | Refresh and return an access token                                  |
| `POST /auth/logout`  | Clear session and login cookies                                     |
| `POST /auth/revoke`  | Revoke the Google grant and clear cookies                           |
| `GET /api/health`    | Runtime health check                                                |

All responses use `Cache-Control: no-store`. POST endpoints require the app's `Origin` and `X-GSA-Request: 1` header. Revocation may affect other sessions using the same Google grant. Refresh tokens and the client secret are never returned to frontend JavaScript.

## Use

1. Connect YouTube and create or import a playlist.
2. Set the series name, catalog game, language, and optional thumbnail.
3. **Prepare broadcast**, review the episode and metadata, then confirm.
4. Select the event in OBS and stream. OBS binds the ingestion stream; YouTube starts and stops automatically.

Use **Retry unfinished steps** to resume interrupted setup on the same broadcast. If creation lost its response, use **Find the created broadcast** before clearing the attempt.

Use **Export library** for backups; clearing browser data removes the library. Backups exclude tokens, Studio sessions, and unfinished operations.

## Preview and deploy

```sh
pnpm build
pnpm preview
```

Preview runs the built frontend and Worker together on `http://localhost:5173`; stop the development server first. Keep local origin settings in `.env` and `.dev.vars` for this check. The Cloudflare plugin copies local runtime secrets into the server build for preview; Wrangler does not deploy that secrets file. Do not upload the whole `dist/` directory to a static host.

For production:

1. Set `VITE_APP_ORIGIN` to the production HTTPS origin before building. Configure that custom domain on the Worker in Cloudflare, and register its `/auth/callback` URL in the Google OAuth client.
2. Authenticate Wrangler and run `pnpm deploy`. This builds and deploys the frontend and Worker together.
3. Set these runtime bindings with `pnpm exec wrangler secret put NAME`, or as secrets in Cloudflare's Variables and Secrets dashboard:

| Binding                 | Production value                                                     |
| ----------------------- | -------------------------------------------------------------------- |
| `APP_ORIGIN`            | Exact HTTPS origin, without a trailing slash                         |
| `GOOGLE_CLIENT_ID`      | Google Web application client ID                                     |
| `GOOGLE_CLIENT_SECRET`  | That client's secret                                                 |
| `COOKIE_ENCRYPTION_KEY` | A separate random 32-byte base64 key, kept stable across deployments |

These bindings are separate from frontend build variables. Auth reports a configuration error until they are set; static assets and `/api/health` still work. Use distinct local and production encryption keys.

This targets **Workers with static assets**, using the [official Cloudflare Vite integration](https://developers.cloudflare.com/workers/vite-plugin/tutorial/), rather than Pages Functions. Use `wrangler deploy`, not `wrangler pages deploy`. The plugin generates `dist/client/` plus a Worker build and deployment configuration. `/auth/*` and `/api/*` run the Worker before SPA fallback, including browser navigation to the OAuth callback. No database or scheduled refresh job is needed.

The helper is emitted only into the frontend build. Reinstall it after changing its code or app origin. `worker/` contains the stateless OAuth backend; `src/services/auth.ts` manages in-memory browser authorization.

## Checks

```sh
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

Auth tests mock Google and cover state/PKCE, cookie tampering, CSRF, expiry/revocation, restoration with a fresh backend handler, token rotation, concurrent renewal, channel changes, and disconnect during refresh. Live Google OAuth requires configured credentials and consent. The [Google server authorization guide](https://developers.google.com/identity/protocols/oauth2/web-server) describes the underlying flow.
