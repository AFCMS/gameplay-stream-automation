# Gameplay Stream Automation

> [!WARNING]
> Mostly LLM generated and intended for private use. Use at your own risk.

Static React app for managing gameplay playlists and preparing public YouTube broadcasts for OBS. No backend; the library is stored in IndexedDB and Google tokens stay in memory.

## Setup

Requires Node 24, pnpm 12, and Tampermonkey.

```sh
pnpm install
cp .env.example .env
```

Set `VITE_GOOGLE_CLIENT_ID` to a Google OAuth **Web application** client. Enable YouTube Data API v3, register `http://localhost:5173` as an authorized JavaScript origin, and add your account as a consent-screen test user if needed.

```sh
pnpm dev
```

Open `http://localhost:5173`, install the userscript via **Install helper**, then reload the app and YouTube Studio. Sign in to Studio with the connected channel and run **Check connection**. Keep a Studio tab open when game assignment requires it; exact game selection uses undocumented Studio APIs.

## Use

1. Connect YouTube and create or import a playlist.
2. Set the series name, catalog game, language, and optional thumbnail.
3. **Prepare broadcast**, review the episode and metadata, then confirm.
4. Select the event in OBS and stream. OBS binds the ingestion stream; YouTube starts and stops automatically.

Use **Retry unfinished steps** to resume interrupted setup on the same broadcast. If creation lost its response, use **Find the created broadcast** before clearing the attempt.

Use **Export library** for backups; clearing browser data removes the library. Backups exclude tokens, Studio sessions, and unfinished operations.

## Deploy

Set `VITE_APP_ORIGIN` to your production origin and register it in the OAuth client.

```sh
pnpm build
```

Serve `dist/` on an HTTPS static host. Configure Vite's `base` for subpath deployments. Reinstall the generated helper after changing its code or the app origin. Never include an OAuth client secret.

## Checks

```sh
pnpm exec vitest run
pnpm lint
pnpm format:check
pnpm build
```
