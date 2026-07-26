<h1 align="center">Takeout for Brightwheel</h1>

<p align="center">
  A one-click, browser-only exporter that gives Brightwheel guardians a permanent copy of every photo, note, and message from their child's account.
</p>

<p align="center">
  <a href="https://familytakeout.com">familytakeout.com</a>
</p>

## What it does

- Downloads every photo your child was tagged in, at the highest resolution Brightwheel exposes to guardians, with the Brightwheel event date stamped into EXIF so Apple Photos / Google Photos sort them correctly.
- Downloads every teacher note and every parent-school message thread as structured JSON and as a rendered HTML timeline.
- Bundles a standalone `viewer/index.html` inside the archive so it's browsable offline forever.
- Runs entirely inside your own browser. No third-party server ever sees your session, your child's photos, or that you used the extension at all.

## Not affiliated with Brightwheel

"Brightwheel" is a trademark of Brightwheel, Inc. Takeout for Brightwheel is an independent, guardian-built data-portability tool. It is not made by, endorsed by, or affiliated with Brightwheel, Inc.

## For guardians

Once the Chrome Web Store listing goes live, install from there. Until then, load it unpacked — see [familytakeout.com/install](https://familytakeout.com/install).

## For developers

```bash
npm install
npm run typecheck  # tsc --noEmit
npm test           # vitest unit tests
npm run build      # produces dist/ — required before test:e2e, since it loads the built extension
npm run test:e2e   # Playwright end-to-end, extension loaded into a real Chromium, Brightwheel mocked
npm run package    # produces releases/brightwheel-takeout-v<version>.zip
```

`npm test` doesn't require any special setup or access to a real Brightwheel account — it exercises
the scraper/lib modules against fixture data, synthesizing minimal fixtures automatically if the
maintainer's personal fixture source isn't present.

Source lives entirely under `src/`. The extension is Manifest V3, TypeScript, bundled with Vite via `@crxjs/vite-plugin`.

## Permissions

Verified against [`src/manifest.ts`](src/manifest.ts), the source of truth for what's actually requested:

- **`permissions`: `storage`** — only. Used for `chrome.storage.local` (session/history snapshot) and `chrome.storage.session` (a short-lived discovery cache). That's the entire `permissions` array — no `cookies`, no `activeTab`, no `tabs`.
- **`host_permissions`: `https://schools.mybrightwheel.com/*`, `https://cdn.mybrightwheel.com/*`** — the Brightwheel app itself and the CloudFront-backed CDN that serves your child's photos. Nothing else. These two hosts are also the only ones the extension ever fetches from.
- The session cookie is **never read via a `chrome.cookies.*` call** — there is no such call anywhere in this codebase. It rides along automatically on `fetch()` requests via `credentials: 'include'`, because `host_permissions` already covers the domain it's scoped to.

If you're reviewing this for the Chrome Web Store or as a privacy-conscious guardian, the two bullet points above are the complete permission surface — there is nothing broader hiding elsewhere in the manifest.

## Privacy

Takeout for Brightwheel runs entirely in your browser. It reads your existing Brightwheel session cookie so it can call the same guardian-facing API that the Brightwheel web app itself calls, then writes the fetched content to a ZIP file (or a folder you pick) on your own computer. Nothing is uploaded, no telemetry is sent, and there is no server operated by the extension author. Full policy: [familytakeout.com/privacy](https://familytakeout.com/privacy).

## License

MIT — see [`LICENSE`](LICENSE).
