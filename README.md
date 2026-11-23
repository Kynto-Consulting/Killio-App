# Killio App

Native Killio for Windows, macOS, Linux and Android, written in Rust with Tauri 2. It replaces Killio
Vault.

It does not carry its own copy of the interface. It opens the Killio frontend of the server the user
picks (killio.dev or an organization's own deployment) inside the system's webview, and adds what a
browser tab cannot do. A change deployed to the frontend reaches every installed app with no new
release.

## What the app adds

| Feature | Where |
|---|---|
| Server picker: killio.dev or any organization URL, remembered between launches | `ui/index.html`, `open_tenant` |
| Switch server without leaving the app (menu, `Ctrl+Shift+T`, or the account menu in the frontend) | `switch_tenant` |
| Starts at sign-in, never the marketing landing | `open_tenant` |
| No-connection screen with retry / open offline | `ui/index.html`, `probe_tenant` |
| Screenshot of the primary screen for the page (desktop) | `capture_screenshot` |
| Save a screenshot to `Pictures/Killio` (`Ctrl+Shift+S`, desktop) | `save_screenshot_to_pictures` |
| Open links in the system browser | `open_external` |

Sign-in, OAuth, teams and everything else are the frontend's own; the app only decides which server
to load.

## How the frontend talks to the app

`src-tauri/src/init.js` is injected into every page before its scripts. It defines
`window.__KILLIO_APP__` and `window.killioApp`. The frontend wraps both in
`Killio-Frontend/src/lib/app-shell/index.ts`; nothing else there touches them.

Any page loaded in the window can reach the IPC, so **every command checks in Rust who is calling**
(`commands.rs`, `caller()`): launcher-only commands reject the tenant, and native features reject any
page that is not the launcher or the chosen server's origin (a sign-in provider's page, for example).

Adding a native feature: write the command in `commands.rs`, list it in `build.rs` and in
`capabilities/default.json` (`allow-<command-name>`), register it in `lib.rs`, expose it in `init.js`
and type it in the frontend's `app-shell/index.ts`.

## Run and build

```
npm install
npm run dev          # debug window
npm run build        # installer for the current OS, in src-tauri/target/release/bundle
cargo test --lib     # from src-tauri/
```

Android needs the Android SDK + NDK and the Rust Android targets: `npm run android:init` once, then
`npm run android:build`. macOS and Linux installers must be built on those systems;
`.github/workflows/build.yml` builds all four.

## Not done yet

- Bundling the frontend inside the installer (full offline on first launch). Today offline shows what
  the frontend's service worker cached on earlier visits.
- Killio Vault's device features: voice diary, on-device speech-to-text, wake word, local agents and
  memory, phone actions (call, open app). None are ported.
- Screenshots on Android.
- An attach-screenshot button in the chat composer (`captureScreenshotFile()` is ready for it).
- Device tools in the other agent surfaces (rooms assistant, AI generation panel); today only chats
  built on `use-agent-chat` run them.
- Signed release builds and auto-update.

## The agent's device tools

The backend can pause an agent turn so the user's device runs a tool (`client_action` stream event)
and resume it with the result. This used to exist only for Killio Vault. Now any client sends
`clientActions: string[]` with each message, naming the device tools it can run; the backend offers
the model only those and never pauses for one the client did not declare
(`Killio-Backend/src/modules/agent/tools/tool-registry.ts`, `resolveClientActionScope`).

Killio App declares `open_browser` and, on desktop, `vault_upload_screenshot`
(`Killio-Frontend/src/lib/app-shell/client-actions.ts`). Both ask the user before acting. To add
one: implement it there, and add the native command it needs.
