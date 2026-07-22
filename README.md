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
- Bundles a standalone `index.html` viewer inside the archive so it's browsable offline forever.
- Runs entirely inside your own browser. No third-party server ever sees your session, your child's photos, or that you used the extension at all.

## Not affiliated with Brightwheel

"Brightwheel" is a trademark of Brightwheel, Inc. Takeout for Brightwheel is an independent, guardian-built data-portability tool. It is not made by, endorsed by, or affiliated with Brightwheel, Inc.

## For guardians

Once the Chrome Web Store listing goes live, install from there. Until then, load it unpacked — see [familytakeout.com/install](https://familytakeout.com/install).

## For developers

```bash
npm install
npm test           # vitest unit tests
npm run test:e2e   # Playwright end-to-end with mocked Brightwheel
npm run build      # produces dist/
npm run package    # produces releases/brightwheel-takeout-v<version>.zip
```

Source lives entirely under `src/`. The extension is Manifest V3, TypeScript, bundled with Vite via `@crxjs/vite-plugin`.

## Privacy

Takeout for Brightwheel runs entirely in your browser. It reads your existing Brightwheel session cookie so it can call the same guardian-facing API that the Brightwheel web app itself calls, then writes the fetched content to a ZIP file (or a folder you pick) on your own computer. Nothing is uploaded, no telemetry is sent, and there is no server operated by the extension author. Full policy: [familytakeout.com/privacy](https://familytakeout.com/privacy).

## License

MIT — see [`LICENSE`](LICENSE).
