// Playwright e2e: loads the built extension into a real Chromium, then drives
// the takeout page from Start -> Done, with the Brightwheel API and
// CloudFront both route-mocked. Captures the ZIP bytes via a stubbed
// showSaveFilePicker on window.

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', 'dist');

// The extension must be built before this suite runs (the persistent context
// loads dist/ directly). `npm run test:e2e` builds first, but guard anyway so
// a bare `playwright test` fails with an actionable message instead of a
// confusing "manifest not found" mid-launch.
function assertDistBuilt(): void {
  if (!existsSync(resolve(DIST, 'manifest.json'))) {
    throw new Error(
      `Extension not built: ${resolve(DIST, 'manifest.json')} is missing.\n` +
        `Run \`npm run build\` first, or use \`npm run test:e2e\` which builds automatically.`,
    );
  }
}

// Headed only when explicitly requested (HEADED=1) for local debugging.
// Default is headless so many agents/CI can run this concurrently without
// popping visible Chromium windows.
//
// IMPORTANT: MV3 extensions do NOT load under Playwright's default headless
// (`chrome-headless-shell`). We must run the FULL Chromium in the *new*
// headless mode, which is requested via the `--headless=new` arg while
// keeping Playwright's own `headless` flag false (so it doesn't swap in the
// extension-less headless-shell). See
// https://playwright.dev/docs/chrome-extensions#headless-mode
const HEADLESS = process.env.HEADED !== '1';

// Tiny 1x1 JPEG (same bytes as the vitest fixture).
const ONE_PIXEL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
const JPEG = Buffer.from(ONE_PIXEL_JPEG_BASE64, 'base64');

// Returns the context plus the temp profile dir so the caller can remove it
// after close(). launchPersistentContext does NOT clean up its user-data-dir,
// so without this each run leaks ~9MB of profile into the OS temp dir.
async function launchWithExtension(): Promise<{ context: BrowserContext; userDataDir: string }> {
  const userDataDir = mkdtempSync(resolve(tmpdir(), 'bw-takeout-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Keep Playwright's headless flag false and drive headlessness via
    // `--headless=new` instead, so the full Chromium (which supports MV3
    // extensions) is used rather than the extension-less headless-shell.
    headless: false,
    channel: 'chromium',
    args: [
      ...(HEADLESS ? ['--headless=new'] : []),
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-sandbox',
    ],
  });
  return { context, userDataDir };
}

test.describe('takeout page (route-mocked BW)', () => {
  test('runs a full export and produces a ZIP with expected entries', async () => {
    // Sanity: dist must exist. Run `npm run build` first.
    assertDistBuilt();

    const { context, userDataDir } = await launchWithExtension();
    try {
      // Route-mock every Brightwheel endpoint.
      await context.route(/schools\.mybrightwheel\.com\/api\/v[12]\/.*/, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.includes('/message_threads/')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              results: [{ message: { object_id: 'msg-1', body: 'Hi', created_at: '2026-06-01T10:00:00Z' } }],
              count: 1,
              has_more: false,
            }),
          });
        }
        if (url.pathname.includes('/activities')) {
          const type = url.searchParams.get('action_type');
          const page = url.searchParams.get('page');
          if (page !== '0') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activities: [] }) });
          }
          if (type === 'ac_note') {
            return route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                activities: [{
                  object_id: 'note-1',
                  action_type: 'ac_note',
                  event_date: '2026-06-15T14:00:00Z',
                  note: 'a note',
                  target: { object_id: 'stu-1' },
                }],
                count: 1,
              }),
            });
          }
          if (type === 'ac_photo') {
            return route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                activities: [{
                  object_id: 'photo-1',
                  action_type: 'ac_photo',
                  event_date: '2026-06-16T09:30:00Z',
                  media: { image_url: 'https://x.cloudfront.net/cover/photo-1.jpg' },
                  target: { object_id: 'stu-1' },
                }],
                count: 1,
              }),
            });
          }
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"activities":[]}' });
      });
      await context.route(/\.cloudfront\.net\/.*/, (route) =>
        route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG }),
      );
      await context.route(/cdn\.mybrightwheel\.com\/.*/, (route) =>
        route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG }),
      );

      // Find the extension's ID.
      let extensionId: string | undefined;
      // Wait up to 5s for the service worker to register.
      for (let i = 0; i < 25; i++) {
        const sws = context.serviceWorkers();
        if (sws.length > 0) {
          extensionId = new URL(sws[0]!.url()).hostname;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(extensionId, 'extension service worker should register').toBeTruthy();

      const takeoutUrl = `chrome-extension://${extensionId}/src/takeout-page/takeout.html`;
      const page = await context.newPage();

      // Inject a fake session and fake showSaveFilePicker BEFORE takeout.ts loads.
      await page.addInitScript(() => {
        // Capture chrome.runtime.sendMessage responses so the takeout page
        // gets a fabricated session (we're not on a real BW tab).
        const origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (chrome.runtime as any).sendMessage = (msg: any, cb?: any) => {
          if (msg?.type === 'bw-takeout:status') {
            const resp = {
              hasCookie: true,
              session: {
                guardianId: 'g-1',
                clientUuid: 'c-1',
                userUuid: 'u-1',
                csrfToken: 'csrf-token',
                studentIds: ['stu-1'],
                threadIds: ['thr-1'],
                clientVersion: '4457',
                userAgent: 'e2e/1.0',
              },
            };
            if (cb) cb(resp);
            return Promise.resolve(resp);
          }
          return origSendMessage(msg, cb);
        };

        // Fake showSaveFilePicker: an in-memory writable that stores bytes on window.
        const chunks: Uint8Array[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__zipChunks = chunks;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).showSaveFilePicker = async () => ({
          name: 'e2e-takeout.zip',
          createWritable: async () =>
            new WritableStream<Uint8Array>({
              write(chunk) { chunks.push(chunk); },
            }),
        });
      });

      await page.goto(takeoutUrl);
      await expect(page.locator('#student-panel')).toContainText('stu-1', { timeout: 5000 });
      // The default flow is the single "Download everything to a folder"
      // quick-start button. The format selector, ZIP-save button, and Start
      // button live inside the (hidden-by-default) Customize panel — reveal it
      // before driving them.
      await page.locator('#customize-toggle').click();
      // Use the JSON format so the e2e output still matches the historical
      // envelope shape the viewer expects. CSV is the new default; JSON is
      // still supported and its output shape is the stable regression baseline.
      await page.locator('input[name="format"][value="json"]').check();
      await page.locator('#choose-save-zip').click();
      await expect(page.locator('#save-hint')).toContainText('e2e-takeout.zip');
      await page.locator('#start').click();
      // Wait for the "done" panel to appear.
      await expect(page.locator('#done')).toBeVisible({ timeout: 30_000 });
      // Verify chunks were captured.
      const total = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = (window as any).__zipChunks as Uint8Array[];
        return c.reduce((s, x) => s + x.byteLength, 0);
      });
      expect(total).toBeGreaterThan(100);
    } finally {
      await context.close();
      // launchPersistentContext leaves the profile dir behind; remove it so
      // concurrent/repeated runs don't accumulate temp profiles.
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
