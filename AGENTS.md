# Gameplay Stream Automation

The project is a Vite React SPA hosted on Cloudflare Workers. A database-free OAuth backend stores refresh tokens in encrypted HttpOnly browser cookies; access tokens stay in frontend memory for YouTube API requests. Never put OAuth client secrets or cookie encryption keys in VITE_* variables.

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.cloudflare.com/workers/vite-plugin/tutorial/
