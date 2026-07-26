import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

// Public half of a keypair generated once for dev-mode identity stability.
// Committing the public half is safe — it does not authorize anyone to
// publish updates. Its only purpose is to fix the extension ID across reloads
// so message ports, storage, and dev tooling can address the extension by a
// stable URL/id. The matching private key lives outside the repo and is only
// needed by the Chrome Web Store publisher (a person, not this repo).
//
// Generated with:
//   openssl genrsa 2048 | openssl rsa -pubout -outform DER | base64 | tr -d '\n'
// (regenerate before Web Store submission — you'll want your own keypair.)
const DEV_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1FubDiLnTTY8JueiSib' +
  'pixluXsSi5/V9BYVtuFOvvKut04P/2FJAxc33PwTnwTZsvmWMSQlkJeBrDUa54Cc' +
  'z2XZkpuGG7UKbTW8spRaeb2cj3k8IOdnckmKRa0xlxoxga55hGP6FBSTmXTZ5avM' +
  'GYSXboAEclJoQ+MU1nX6rA9vd29Sc+YQyUknZ21anmBWSLl7mf9KAqYIJyjuY49D' +
  'js+Uarv1qGiledi4vm+u0ksAFtbuGwdbt+KAa/rQ2DTZT/JZhaKn3OoTHptilsOJ' +
  'LvoR7JiY2F4Ux7axZk4JYdFBViAE3Qtt4MedESRzqfVN/A0OlyyeUYHod2nYAo7g' +
  'wwIDAQAB';

export default defineManifest({
  manifest_version: 3,
  name: 'Takeout for Brightwheel',
  short_name: 'Takeout',
  description:
    'Google-Takeout-style exporter for Brightwheel. One-shot ZIP of every photo, note, and message for your family.',
  version: pkg.version,
  // @crxjs types `author` as { email } (Chrome's own MV3 accepts a plain
  // string too, but we go with what the plugin's types allow). CWS uses the
  // developer console account as the canonical contact — no need to duplicate
  // a real email in the manifest and open a scraper target.
  author: { email: 'noreply@brightwheel-takeout.local' },
  homepage_url: 'https://github.com/ChaseBro/brightwheel-takeout',
  key: DEV_PUBLIC_KEY,
  minimum_chrome_version: '116',
  action: {
    default_title: 'Takeout for Brightwheel',
    default_popup: 'src/popup/popup.html',
    default_icon: {
      '16': 'public/icons/icon-16.png',
      '32': 'public/icons/icon-32.png',
      '48': 'public/icons/icon-48.png',
      '128': 'public/icons/icon-128.png',
    },
  },
  icons: {
    '16': 'public/icons/icon-16.png',
    '32': 'public/icons/icon-32.png',
    '48': 'public/icons/icon-48.png',
    '128': 'public/icons/icon-128.png',
  },
  background: {
    service_worker: 'src/background/worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://schools.mybrightwheel.com/*'],
      js: ['src/content/detect.ts'],
      run_at: 'document_idle',
    },
  ],
  // Kept lean for CWS review. Only `storage` is actually required:
  //  - `storage` — chrome.storage.local for the session/history snapshot,
  //     and chrome.storage.session for the last-discovery cache.
  //  Not requested (would inflate the install-time permission prompt):
  //   - `cookies` — the BW session cookie rides along automatically via
  //     `credentials: 'include'` because our host_permissions cover the
  //     domain; no chrome.cookies.* call exists in this repo.
  //   - `activeTab` / `tabs` — chrome.tabs.query({url: bw*}) and
  //     chrome.tabs.sendMessage(tabId, ...) both work off host_permissions
  //     alone for the tabs whose URLs we already declare. chrome.tabs.create
  //     needs no permission at all.
  permissions: ['storage'],
  // Only the two hosts the API + CDN actually use — verified live:
  // /api/v1/students/{id}/activities returns every `media.image_url` from
  // cdn.mybrightwheel.com (BW's own CloudFront distribution behind a
  // CNAME — signed-URL behavior is identical to cloudfront.net, but the
  // hostname is stable). No `*.cloudfront.net` wildcard needed.
  host_permissions: [
    'https://schools.mybrightwheel.com/*',
    'https://cdn.mybrightwheel.com/*',
  ],
  web_accessible_resources: [
    {
      resources: ['src/takeout-page/takeout.html', 'public/*'],
      matches: ['https://schools.mybrightwheel.com/*'],
    },
  ],
});
