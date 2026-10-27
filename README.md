# Discord-Presence-pro

This is the local web editor and Discord Rich Presence animator with animated frames support.

## What it includes

- Activity type, display mode, application ID, name, details, state, and link fields.
- Large and small image keys, hover text, click URLs, party size/max, and all five timestamp modes.
- Two Discord buttons with live preview.
- Browser autosave plus import/export of legacy-compatible `.crp` XML presets.
- A local Node.js Discord IPC bridge for Connect, Update presence, and Disconnect.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` if you want to change the local settings. The included `.env` already contains the application ID supplied for this project.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open `http://127.0.0.1:3000` while the Discord desktop client is running.

Rich Presence uses the Discord desktop client's local IPC connection and the application ID. A Discord bot token and public key are not needed. Never put a bot token in the browser or commit it to this project; rotate the token that was exposed in the original request before using it anywhere.

## Production build

```powershell
npm run build
npm start
```

The server intentionally binds to `127.0.0.1` by default because it controls a local Discord session.
