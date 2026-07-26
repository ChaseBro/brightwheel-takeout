import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Each test launches its OWN chromium.launchPersistentContext with a fresh
  // mkdtemp user-data-dir (see e2e/takeout.spec.ts) — there's no shared
  // browser, port, or on-disk state between tests, so parallel workers are
  // safe. Capped rather than left at Playwright's CPU-count default because
  // each worker launches a full (non-headless-shell) Chromium + MV3
  // extension, which is heavy; 4 is a reasonable default for a reviewer
  // laptop/CI box. Override with `PW_WORKERS` if a given machine needs less.
  fullyParallel: true,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 4,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-extension',
      // The extension is loaded per-test via chromium.launchPersistentContext
      // with --load-extension — see launchWithExtension() in
      // e2e/takeout.spec.ts (there is no separate e2e/fixtures/ helper).
    },
  ],
});
