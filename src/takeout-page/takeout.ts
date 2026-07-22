// Takeout page — the full-tab UI that runs the export.
//
// Why in a page (not the SW): only a page can call showSaveFilePicker /
// showDirectoryPicker (the FS Access API requires a user gesture), and MV3
// service workers die after ~30s idle — a full export takes tens of
// minutes. Keeping the run in a page also lets us maintain a Port to the SW
// so it doesn't idle-out mid-fetch.

import { run, type IncludeKind } from '@/scraper/run.js';
import { NullSync } from '@/lib/sync.js';
import { log } from '@/lib/log.js';
import type { ProgressUpdate, Session } from '@/scraper/types.js';
import { loadCheckpoint, clearCheckpoint, type Checkpoint } from '@/lib/checkpoint.js';
import { $ } from '@/lib/dom.js';
import { sendMessage } from '@/lib/messaging.js';
import {
  FolderSink,
  FolderSinkGuardianMismatchError,
  SingleFileSink,
  ZipSink,
  type DirectoryHandleLike,
  type Sink,
} from '@/scraper/sinks.js';
import { DebugCapture } from '@/scraper/debug-capture.js';
import {
  clearPermaFailedPhotos,
  loadHistory,
  permaFailedPhotoSet,
  recordPermaFailedPhotos,
  recordRun,
  seenAsSets,
  summarize,
} from '@/lib/local-history.js';
import type { OutputFormat } from '@/scraper/formatters/types.js';
import { buildBugReportUrl } from '@/lib/bug-report.js';
import { shouldSuggestDebugMode } from '@/lib/debug-suggest.js';
import { bigExportReasons, shouldConfirmBigExport } from '@/lib/big-export.js';
import { shouldShowFormatSection } from '@/lib/format-visibility.js';
import { suggestFolderName } from '@/lib/folder-suggest.js';
import { folderReadinessSummary, readTopLevelEntries } from '@/lib/folder-readiness.js';
import { BwClient } from '@/scraper/bw-client.js';
import { previewScope, type ScopePreview } from '@/scraper/preview.js';
import {
  escapeHtml,
  formatShortDate,
  renderResumeBannerHtml,
  renderScopePreviewFullHtml,
  renderStudentListHtml,
  renderWelcomeBackHtml,
} from '@/lib/takeout-render.js';
import { parseAction, type PopupAction } from '@/lib/action-router.js';

const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Ring-buffer capacity when Debug mode is on. */
const DEBUG_LOG_CAPACITY = 5000;

interface FriendlyError {
  title: string;
  body: string;
  showOpenBw: boolean;
  primaryLabel: string;
}

function classifyError(err: unknown): FriendlyError {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'BwAuthError') {
    return {
      title: 'Your Brightwheel session expired',
      body: 'Open Brightwheel in another tab, log in again, then come back here and click Resume.',
      showOpenBw: true,
      primaryLabel: 'Resume',
    };
  }
  if (name === 'BwRateLimitError') {
    return {
      title: 'Brightwheel asked us to slow down',
      body: 'You’ve made a lot of requests in a short time. Try again in a few minutes — your progress is saved.',
      showOpenBw: false,
      primaryLabel: 'Try again',
    };
  }
  if (name === 'BwServerError') {
    return {
      title: 'Brightwheel is having trouble right now',
      body: 'This is on Brightwheel’s side, not yours. Try again in a bit — your progress is saved.',
      showOpenBw: false,
      primaryLabel: 'Try again',
    };
  }
  if (name === 'BwNetworkError') {
    return {
      title: 'Couldn’t reach Brightwheel',
      body: 'Check your internet connection and try again. Your progress is saved.',
      showOpenBw: false,
      primaryLabel: 'Try again',
    };
  }
  if (name === 'BwEnvironmentError') {
    return {
      title: 'Update Chrome to continue',
      body: 'Takeout for Brightwheel needs Chrome 116 or newer to save the archive to your disk. Update Chrome from google.com/chrome and reload this page.',
      showOpenBw: false,
      primaryLabel: 'Reload',
    };
  }
  return {
    title: 'Something went wrong',
    body: 'The export didn’t finish. Your progress is saved — Try again picks up where it stopped.',
    showOpenBw: false,
    primaryLabel: 'Try again',
  };
}

let lastError: { err: unknown; message: string } | null = null;

function showError(err: unknown): void {
  const info = classifyError(err);
  const rawMessage = (err as Error | null)?.message ?? String(err);
  lastError = { err, message: rawMessage };
  const panel = $<HTMLElement>('error-panel');
  const prog = $<HTMLElement>('progress');
  const pre = $<HTMLElement>('pre-run');
  const done = $<HTMLElement>('done');
  if (prog) prog.classList.add('panel--hidden');
  if (done) done.classList.add('panel--hidden');
  if (pre) pre.classList.add('panel--hidden');
  if (!panel) return;
  panel.classList.remove('panel--hidden');
  const title = $<HTMLElement>('error-title');
  const body = $<HTMLElement>('error-body');
  const details = $<HTMLElement>('error-details');
  const openBw = $<HTMLAnchorElement>('error-open-bw');
  const primary = $<HTMLButtonElement>('error-primary');
  if (title) title.textContent = info.title;
  if (body) body.textContent = info.body;
  if (details) details.textContent = rawMessage;
  if (openBw) openBw.hidden = !info.showOpenBw;
  if (primary) {
    primary.textContent = info.primaryLabel;
    primary.onclick = () => window.location.reload();
  }
  // C: nudge the user to enable Debug mode for code bugs (not for
  // user-fixable errors like auth expiry or rate-limit).
  const suggest = $<HTMLDivElement>('debug-suggest');
  if (suggest) {
    const debugEnabled = $<HTMLInputElement>('debug-mode')?.checked ?? false;
    const show = shouldSuggestDebugMode({
      hasError: true,
      debugEnabled,
      errorName: (err as { name?: string } | null)?.name,
    });
    suggest.hidden = !show;
  }
}

/**
 * Called from the debug-suggest hint's inline "Enable Debug mode" button.
 * Ticks the Debug checkbox, expands Advanced so the state is visible,
 * opens the Customize panel, AND hides the error panel + shows the pre-run
 * panel — otherwise the user just sees the error still onscreen and thinks
 * nothing happened. Also scrolls the Advanced section into view.
 */
function enableDebugForRetry(): void {
  const cb = $<HTMLInputElement>('debug-mode');
  if (cb) cb.checked = true;
  const advanced = document.querySelector<HTMLDetailsElement>('.settings-section--advanced');
  if (advanced) advanced.open = true;
  openCustomizePanel();
  const suggest = $<HTMLDivElement>('debug-suggest');
  if (suggest) suggest.hidden = true;
  // Bring the pre-run panel back so the user actually sees the state change.
  // Without this, the error panel stays onscreen covering everything and the
  // "click" reads as a no-op even though state was updated correctly.
  const errorPanel = $<HTMLElement>('error-panel');
  const pre = $<HTMLElement>('pre-run');
  if (errorPanel) errorPanel.classList.add('panel--hidden');
  if (pre) pre.classList.remove('panel--hidden');
  advanced?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  log.info('debug-suggest: user opted in — next run will capture raw responses');
}

interface StatusResp {
  hasCookie: boolean;
  session?:
    | (Partial<Session> & {
        csrfToken?: string | null;
        guardianId?: string | null;
        studentNames?: Record<string, string>;
        discoveryWarning?: {
          steps: Array<{ step: 'roster' | 'threads' | 'users-me'; detail: string }>;
        };
      })
    | null;
}

function askStatus(): Promise<StatusResp> {
  return sendMessage<StatusResp>({ type: 'bw-takeout:status' });
}

async function refreshCsrfFromSw(): Promise<string | undefined> {
  try {
    const r = await sendMessage<{ session?: { csrfToken?: string | null } } | undefined>({
      type: 'bw-takeout:refresh-session',
    });
    return r?.session?.csrfToken ?? undefined;
  } catch {
    return undefined;
  }
}

// ---- Save-target state ----------------------------------------------------

type SaveTarget =
  | { kind: 'zip'; handle: FileSystemFileHandle }
  | { kind: 'folder'; handle: DirectoryHandleLike & { name?: string } };

let saveTarget: SaveTarget | null = null;
let cachedSession: Session | null = null;
let cachedStudentNames: Record<string, string> = {};
let pendingResume: Checkpoint | null = null;
/**
 * When true, the next run passes an empty permaFailedPhotos set and clears
 * the LocalHistory row afterwards — a one-shot "give them another chance"
 * mode driven by the takeout page's Retry-failed button.
 */
let retryPermaFailedPhotos = false;
/** Most recent scope preview — used by the big-export confirm gate on Start. */
let cachedScope: ScopePreview | null = null;

/**
 * Peek at the API to figure out how big the export will be, then render a
 * summary banner. Best-effort — a network hiccup shouldn't block Start.
 */
async function refreshScopePreview(): Promise<void> {
  const el = $<HTMLDivElement>('scope-preview');
  if (!el || !cachedSession || !cachedSession.csrfToken || !cachedSession.clientUuid) {
    if (el) el.classList.add('scope-preview--hidden');
    return;
  }
  el.className = 'scope-preview scope-preview--loading';
  el.innerHTML =
    '<span class="scope-preview__spinner" aria-hidden="true"></span>' +
    'Peeking at Brightwheel to see how big this export will be…';
  try {
    const client = new BwClient(
      {
        clientUuid: cachedSession.clientUuid,
        userUuid: cachedSession.userUuid ?? cachedSession.guardianId,
        csrfToken: cachedSession.csrfToken,
        studentId: cachedSession.studentIds[0],
        clientVersion: cachedSession.clientVersion,
        userAgent: cachedSession.userAgent,
      },
      { refreshCsrf: refreshCsrfFromSw },
    );
    const scope = await previewScope(client, {
      guardianId: cachedSession.guardianId,
      studentIds: cachedSession.studentIds,
      threadIds: cachedSession.threadIds,
      studentNames: cachedStudentNames,
    });
    cachedScope = scope;
    renderScopePreview(scope);
  } catch (err) {
    log.warn(`scope preview failed: ${(err as Error).message}`);
    el.className = 'scope-preview scope-preview--error';
    el.textContent = "Couldn't peek at your account (that's OK — the export will still work).";
  }
}

function renderScopePreview(scope: ScopePreview): void {
  const el = $<HTMLDivElement>('scope-preview');
  if (!el) return;
  el.className = 'scope-preview';
  el.innerHTML = renderScopePreviewFullHtml(scope);
}

function openCustomizePanel(): void {
  const panel = $<HTMLDivElement>('customize-panel');
  if (panel) panel.hidden = false;
  const toggle = $<HTMLButtonElement>('customize-toggle');
  if (toggle) toggle.hidden = true;
  panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * "Download everything to a folder" — the primary action for first-timers.
 * Uses all default settings (all kinds included, no date range, CSV format).
 * Just prompts for a folder and starts.
 */
async function quickStartEverything(): Promise<void> {
  if (!cachedSession) return;
  // Defaults are already set in the DOM (all checkboxes on, format=CSV,
  // date-range empty = all-time). Just prompt for folder + go.
  await pickSaveFolder();
  if (saveTarget) await startRun();
}

/**
 * "Welcome back — just get what's new" banner shown when the browser has
 * local history for this guardian. Clicking the primary sets the date range
 * to `from = last-export date`, ticks skip-already-exported, and prompts for
 * a folder to save into.
 */
function renderWelcomeBack(summary: {
  hasHistory: boolean;
  lastExportedAt: number | null;
  seenCounts: { photos: number; notes: number; messages: number };
}): void {
  const el = $<HTMLElement>('welcome-back');
  if (!el) return;
  if (!summary.hasHistory || !summary.lastExportedAt) {
    el.classList.add('panel--hidden');
    return;
  }
  const lastYmd = new Date(summary.lastExportedAt).toISOString().slice(0, 10);
  const lastDisplay = formatShortDate(summary.lastExportedAt);
  el.classList.remove('panel--hidden');
  el.innerHTML = renderWelcomeBackHtml(summary, {
    primaryButtonId: 'welcome-refresh',
    primaryLabel: `Get anything new since ${lastDisplay}`,
    hint: 'Full re-export options below ↓',
  });
  $<HTMLButtonElement>('welcome-refresh')?.addEventListener('click', () => {
    void quickRefreshSinceLast(lastYmd);
  });
}

/**
 * One-click "just download what's new" flow: pre-fill the pre-run panel to
 * incremental defaults (date range from = last-export ymd, skip-already-
 * exported ON) and prompt for a folder. Reuses the standard startRun path
 * so all the checkpoint / resume / logging machinery still works.
 */
async function quickRefreshSinceLast(lastYmd: string): Promise<void> {
  const from = $<HTMLInputElement>('date-from');
  const to = $<HTMLInputElement>('date-to');
  if (from) from.value = lastYmd;
  if (to) to.value = new Date().toISOString().slice(0, 10);
  document.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => c.classList.remove('chip--active'));
  const skip = $<HTMLInputElement>('skip-already-exported');
  if (skip) skip.checked = true;
  // Force a folder pick — an incremental into a ZIP means you have another
  // ZIP; a folder into which the extension adds new items is what parents
  // actually want.
  await pickSaveFolder();
  if (saveTarget) await startRun();
}

/**
 * Populate the post-success panel with (a) a friendly summary, (b) a list of
 * what's actually in the archive keyed to what the user chose, (c) suggested
 * next steps, and (d) a "come back for a refresh" nudge tied to today's date.
 * Replaces the previous single-line "Archived N notes …" message.
 */
function renderDone(
  result: { counts: { notes: number; messages: number; photos: number }; guardianId: string },
  target: SaveTarget | null,
  include: Record<IncludeKind, boolean>,
  format: OutputFormat,
): void {
  const summary = $<HTMLParagraphElement>('done-summary');
  const nStudents = cachedSession?.studentIds.length ?? 1;
  if (summary) {
    const studentPhrase = nStudents === 1 ? 'your child' : `your ${nStudents} children`;
    summary.textContent = `You now have a copy of ${studentPhrase}'s Brightwheel on your computer.`;
  }

  const contents = $<HTMLDivElement>('done-contents');
  if (contents) {
    const rows: string[] = ['<div class="done-contents__title">What\'s inside</div>'];
    if (include.photos && result.counts.photos > 0) {
      rows.push(
        `<div class="done-contents__row"><code>photos/</code> — <b>${result.counts.photos.toLocaleString()}</b> JPG${result.counts.photos === 1 ? '' : 's'} with Brightwheel event dates baked into EXIF (Apple Photos / Google Photos will sort them right)</div>`,
      );
    }
    if (include.notes && result.counts.notes > 0) {
      const ext = format === 'csv' ? 'csv' : format === 'xlsx' ? 'xlsx' : 'json';
      rows.push(
        `<div class="done-contents__row"><code>notes.${ext}</code> — <b>${result.counts.notes.toLocaleString()}</b> teacher note${result.counts.notes === 1 ? '' : 's'}${format === 'csv' ? ' (opens in Excel, Numbers, Google Sheets)' : ''}</div>`,
      );
    }
    if (include.messages && result.counts.messages > 0) {
      const ext = format === 'csv' ? 'csv' : format === 'xlsx' ? 'xlsx' : 'json';
      rows.push(
        `<div class="done-contents__row"><code>messages.${ext}</code> — <b>${result.counts.messages.toLocaleString()}</b> message${result.counts.messages === 1 ? '' : 's'}</div>`,
      );
    }
    if (include.viewer) {
      rows.push(
        '<div class="done-contents__row"><code>viewer/index.html</code> — offline browser: <b>double-click to open</b> the archive as a searchable timeline + photo gallery, works forever without needing anything installed</div>',
      );
    }
    rows.push(
      '<div class="done-contents__row"><code>manifest.json</code> — machine-readable summary (guardian id, dates, counts)</div>',
    );
    contents.innerHTML = rows.join('');
  }

  const nextList = $<HTMLUListElement>('done-next-list');
  if (nextList) {
    const items: string[] = [];
    if (target?.kind === 'folder' && include.viewer) {
      items.push(
        `Open <code>viewer/index.html</code> in the folder you saved to — it's the fastest way to browse your archive.`,
      );
    } else if (target?.kind === 'zip') {
      items.push(
        `Unzip your archive, then double-click <code>viewer/index.html</code> to browse it as a timeline + gallery.`,
      );
    }
    if (include.photos && result.counts.photos > 0) {
      items.push(
        `Drag the <code>photos/</code> folder into Apple Photos or Google Photos — the Brightwheel event date is baked into every JPG so they'll sort correctly.`,
      );
    }
    items.push(
      `Keep the whole folder (or ZIP) somewhere safe — this is <b>your</b> copy of a few years of your kid's life. Consider iCloud Drive, Google Drive, or an external backup.`,
    );
    nextList.innerHTML = items.map((s) => `<li>${s}</li>`).join('');
  }

  const dateEl = $<HTMLSpanElement>('done-refresh-date');
  if (dateEl) dateEl.textContent = formatShortDate(Date.now());
}

function renderStudents(session: Session | null, names: Record<string, string> = {}): void {
  const panel = $<HTMLDivElement>('student-panel');
  if (!panel) return;
  panel.innerHTML = renderStudentListHtml(session?.studentIds ?? [], names);
}

// ---- UI helpers -----------------------------------------------------------

function currentIncludeSet(): Record<IncludeKind, boolean> {
  return {
    photos: ($<HTMLInputElement>('include-photos')?.checked ?? true),
    notes: ($<HTMLInputElement>('include-notes')?.checked ?? true),
    messages: ($<HTMLInputElement>('include-messages')?.checked ?? true),
    viewer: ($<HTMLInputElement>('include-viewer')?.checked ?? true),
    dailyReports: ($<HTMLInputElement>('include-daily-reports')?.checked ?? false),
  };
}

function currentFormat(): OutputFormat {
  const el = document.querySelector<HTMLInputElement>('input[name="format"]:checked');
  return (el?.value as OutputFormat) ?? 'csv';
}

function currentDateRange(): { from?: string | null; to?: string | null } {
  const f = $<HTMLInputElement>('date-from')?.value;
  const t = $<HTMLInputElement>('date-to')?.value;
  return {
    from: f && f.length > 0 ? f : null,
    to: t && t.length > 0 ? t : null,
  };
}

function updateStartButton(): void {
  const btn = $<HTMLButtonElement>('start');
  if (!btn) return;
  btn.disabled = !(saveTarget && cachedSession);
}

function setSaveHint(text: string): void {
  const hint = $<HTMLSpanElement>('save-hint');
  if (hint) hint.textContent = text;
}

/**
 * Continue an unfinished export. On a fresh page load the user has NOT yet
 * picked a save target for this session (FileSystemFileHandle / DirectoryHandle
 * cannot be preserved across reloads without an IndexedDB persistence pass we
 * don't do yet). So Resume prompts for a save target first, then starts the
 * run with `resume: true` so the checkpoint's `seenObjectIds` skip work
 * already done.
 *
 * ZipSink / SingleFileSink can't resume cleanly: the pre-crash archive on
 * disk is missing its central directory (unreadable), and a resumed ZipSink
 * writes a *fresh* archive containing only the not-yet-processed items —
 * the pre-crash items are lost. The UI enforces this by disabling the ZIP
 * button while a checkpoint is present (see `applyResumeUiConstraint`).
 */
async function resumeExport(): Promise<void> {
  if (!cachedSession) {
    log.warn('resume: no cached session; user needs to reload Brightwheel and retry');
    return;
  }
  if (!saveTarget) {
    // Force a folder pick — cleanest resume semantics + it's the only save
    // target the UI allows while a checkpoint is present.
    await pickSaveFolder();
    if (!saveTarget) return; // user cancelled
  }
  if (saveTarget.kind === 'zip') {
    // Belt-and-suspenders: the UI should have disabled the ZIP button, but
    // in case something else set saveTarget to a zip handle, refuse Resume
    // rather than silently produce a partial archive.
    log.warn('resume: refusing to resume into a ZIP target — pick a folder instead');
    return;
  }
  await startRun({ resume: true });
}

/**
 * Disable / re-enable the "Save as ZIP" button and its neighbour hint based
 * on whether a checkpoint is currently offered for Resume. The ZIP path can't
 * resume cleanly — see the note on `resumeExport` — so while the resume
 * banner is up we lock the user into the folder path.
 */
function applyResumeUiConstraint(hasResume: boolean): void {
  const zipBtn = $<HTMLButtonElement>('choose-save-zip');
  const zipHint = $<HTMLSpanElement>('zip-resume-note');
  if (zipBtn) zipBtn.disabled = hasResume;
  if (zipHint) zipHint.hidden = !hasResume;
  if (hasResume && saveTarget?.kind === 'zip') {
    // A ZIP handle was picked before the checkpoint appeared — clear it so
    // Start doesn't proceed with an unsupported target.
    saveTarget = null;
    setSaveHint('Resume requires a folder — pick that instead, or Discard to start fresh.');
    updateStartButton();
  }
}

async function pickSaveZip(): Promise<void> {
  const wSFS = window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
  };
  if (!wSFS.showSaveFilePicker) {
    showError({
      name: 'BwEnvironmentError',
      message:
        "Your browser doesn't support the File System Access API. Update Chrome to 116+ and reload this page.",
    });
    return;
  }
  try {
    const now = new Date().toISOString().slice(0, 10);
    const format = currentFormat();
    const include = currentIncludeSet();
    const debugOn = $<HTMLInputElement>('debug-mode')?.checked ?? false;
    // If the export shakes out to one logical file, the SingleFileSink path
    // suggests a .csv/.json/.xlsx name in the picker. Debug mode forces ZIP.
    const singleFile = decideSingleFile(include, format, debugOn);
    const opts = singleFile
      ? singleFilePickerOpts(now, format, include)
      : {
          suggestedName: `brightwheel-takeout-${now}.zip`,
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        };
    const handle = await wSFS.showSaveFilePicker(opts);
    saveTarget = { kind: 'zip', handle };
    setSaveHint(`Saving to ${handle.name}`);
    updateStartButton();
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return;
    log.error(`pickSaveZip failed: ${(err as Error).message}`);
  }
}

/** Populate the folder-tip's suggested name from the current session and show it. */
function renderFolderTip(): void {
  const tip = $<HTMLDivElement>('folder-tip');
  const name = $<HTMLElement>('folder-tip-name');
  if (!tip || !name || !cachedSession) return;
  name.textContent = suggestFolderName({
    studentIds: cachedSession.studentIds,
    studentNames: cachedStudentNames,
  });
  tip.hidden = false;
}

async function pickSaveFolder(): Promise<void> {
  const wSDS = window as unknown as {
    showDirectoryPicker?: (opts?: unknown) => Promise<DirectoryHandleLike & { name?: string }>;
  };
  if (!wSDS.showDirectoryPicker) {
    showError({
      name: 'BwEnvironmentError',
      message:
        "Your browser doesn't support picking a folder. Update Chrome to 116+ and reload this page, or pick 'Save as ZIP file' instead.",
    });
    return;
  }
  try {
    const handle = await wSDS.showDirectoryPicker({ mode: 'readwrite' });
    // Post-pick readiness check: warn if the folder has a bunch of
    // unrelated stuff (they may have accidentally picked ~/Downloads).
    try {
      const entries = await readTopLevelEntries(handle as unknown as {
        entries?: () => AsyncIterableIterator<[string, { kind: 'file' | 'directory' }]>;
      });
      const summary = folderReadinessSummary(entries);
      if (!summary.clean) {
        const ok = window.confirm(
          `The folder "${handle.name ?? 'you picked'}" already has ${summary.nonBwFileCount} other files in it.\n\n` +
          `Takeout for Brightwheel will add photos/, notes.csv, viewer/, etc. alongside them — nothing existing will be deleted, but the archive will mix with your other stuff.\n\n` +
          `Continue anyway, or Cancel and pick an empty folder?`,
        );
        if (!ok) {
          log.info('folder-pick: user cancelled at non-empty-folder confirm');
          return;
        }
        log.warn(`folder-pick: user proceeded into folder with ${summary.nonBwFileCount} stray files`);
      }
    } catch (readErr) {
      // Readiness check is best-effort — don't block the pick on a probe failure.
      log.warn(`folder-readiness probe failed: ${(readErr as Error).message}`);
    }
    saveTarget = { kind: 'folder', handle };
    setSaveHint(
      `Saving into folder "${handle.name ?? 'selected folder'}" — we'll write files straight there, nothing gets zipped.`,
    );
    updateStartButton();
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return;
    log.error(`pickSaveFolder failed: ${(err as Error).message}`);
  }
}

/**
 * Decide whether the export collapses to a single logical file. Only
 * applies to ZIP-target mode; folder targets always write file-per-entry.
 */
function decideSingleFile(
  include: Record<IncludeKind, boolean>,
  format: OutputFormat,
  debugOn: boolean,
): boolean {
  if (debugOn) return false;
  if (include.photos || include.viewer) return false;
  if (format === 'xlsx') {
    // Any Excel selection with no photos → single xlsx.
    return include.notes || include.messages;
  }
  const kinds = [include.notes, include.messages].filter(Boolean).length;
  if (kinds !== 1) return false;
  return format === 'csv' || format === 'json';
}

function singleFilePickerOpts(
  now: string,
  format: OutputFormat,
  include: Record<IncludeKind, boolean>,
): unknown {
  if (format === 'xlsx') {
    return {
      suggestedName: `brightwheel-takeout-${now}.xlsx`,
      types: [
        {
          description: 'Excel workbook',
          accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
        },
      ],
    };
  }
  const which = include.notes ? 'notes' : 'messages';
  const ext = format === 'csv' ? 'csv' : 'json';
  return {
    suggestedName: `brightwheel-${which}-${now}.${ext}`,
    types: [
      format === 'csv'
        ? { description: 'CSV', accept: { 'text/csv': ['.csv'] } }
        : { description: 'JSON', accept: { 'application/json': ['.json'] } },
    ],
  };
}

let currentAbort: AbortController | null = null;

async function startRun(opts: { resume?: boolean } = {}): Promise<void> {
  if (!saveTarget || !cachedSession) return;
  // M7: refuse a second Start while a run is in flight. Without this, a
  // double-click races two runs onto the same IDB checkpoint key and
  // clobbers state. `currentAbort` is our in-flight sentinel.
  if (currentAbort) {
    log.warn('start-btn: refusing — a run is already in progress');
    return;
  }
  // D: big-export confirmation. Skip on resume (user already committed to
  // this scope on the original run).
  if (!opts.resume && cachedScope && shouldConfirmBigExport(cachedScope)) {
    const reasons = bigExportReasons(cachedScope);
    const ok = window.confirm(
      "Heads up — this is a big export:\n\n  • " +
        reasons.join('\n  • ') +
        "\n\nContinue? (You can Stop mid-run and Resume later.)",
    );
    if (!ok) {
      log.info('start-btn: user cancelled at big-export confirm');
      return;
    }
  }
  const startBtn = $<HTMLButtonElement>('start');
  if (startBtn) startBtn.disabled = true;
  const pre = $<HTMLElement>('pre-run');
  const prog = $<HTMLElement>('progress');
  const done = $<HTMLElement>('done');
  if (pre) pre.classList.add('panel--hidden');
  if (prog) prog.classList.remove('panel--hidden');
  if (done) done.classList.add('panel--hidden');

  const port = chrome.runtime.connect({ name: 'bw-takeout:keepalive' });
  log.mirrorToConsole = true;
  const resumeFrom = opts.resume ? pendingResume ?? undefined : undefined;

  const include = currentIncludeSet();
  const format = currentFormat();
  const dateRange = currentDateRange();
  const debugOn = $<HTMLInputElement>('debug-mode')?.checked ?? false;
  const skipAlreadyOn = $<HTMLInputElement>('skip-already-exported')?.checked ?? false;

  if (debugOn) {
    // Bump the ring buffer so we don't drop early debug lines on a long run.
    log.setCapacity(DEBUG_LOG_CAPACITY);
  }

  try {
    let sink: Sink;
    if (saveTarget.kind === 'folder') {
      const folderSink = new FolderSink(saveTarget.handle);
      try {
        await folderSink.checkExistingGuardian(cachedSession.guardianId);
      } catch (err) {
        if (err instanceof FolderSinkGuardianMismatchError) {
          const ok = window.confirm(
            `This folder already contains an export for a different Brightwheel account (${err.existingGuardianId.slice(0, 8)}…). ` +
            `Mixing exports would corrupt the manifest and merge photos from both accounts. ` +
            `\n\nOverwrite anyway? (Not recommended — pick a different folder unless you know what you're doing.)`,
          );
          if (!ok) {
            // Bail cleanly — bring the pre-run panel back so the user can re-pick.
            const pre = $<HTMLElement>('pre-run');
            const prog = $<HTMLElement>('progress');
            if (prog) prog.classList.add('panel--hidden');
            if (pre) pre.classList.remove('panel--hidden');
            log.info('folder-sink: user declined to overwrite mismatched-guardian folder');
            return;
          }
          log.warn(`folder-sink: user confirmed overwrite of ${err.existingGuardianId}'s folder with ${err.newGuardianId}`);
        } else {
          throw err;
        }
      }
      sink = folderSink;
    } else if (decideSingleFile(include, format, debugOn)) {
      const writable = await saveTarget.handle.createWritable();
      sink = new SingleFileSink(writable);
    } else {
      const writable = await saveTarget.handle.createWritable();
      sink = new ZipSink(writable);
    }

    let skipAlready: Record<'photos' | 'notes' | 'messages', Set<string>> | undefined;
    let permaFailedPhotos: Set<string> | undefined;
    {
      const history = await loadHistory();
      if (skipAlreadyOn) {
        skipAlready = seenAsSets(history, cachedSession.guardianId);
      }
      // Always apply the perma-failed skip set unless the user asked to
      // retry them this run — otherwise a failed photo would burn the
      // retry budget again on every run.
      permaFailedPhotos = retryPermaFailedPhotos
        ? new Set<string>()
        : permaFailedPhotoSet(history, cachedSession.guardianId);
    }

    const debug = debugOn ? new DebugCapture(true) : undefined;

    currentAbort = new AbortController();
    const result = await run({
      session: cachedSession,
      sink,
      logger: log,
      progress: {
        post: (u: ProgressUpdate) => renderProgress(u),
      },
      sync: new NullSync(),
      extensionVersion: chrome.runtime.getManifest().version,
      resumeFrom,
      refreshCsrf: refreshCsrfFromSw,
      include,
      format,
      dateRange,
      signal: currentAbort.signal,
      ...(skipAlready ? { skipAlreadyExported: skipAlready } : {}),
      ...(debug ? { debug } : {}),
      ...(permaFailedPhotos ? { permaFailedPhotos } : {}),
    });

    // Persist to local history for the "Since my last export" preset next
    // time + the Skip-already-exported checkbox.
    try {
      await recordRun(
        {
          runId: result.runId,
          guardianId: result.guardianId,
          exportedAt: Date.now(),
          dateRangeFrom: dateRange.from ?? null,
          dateRangeTo: dateRange.to ?? null,
          counts: result.counts,
          includedKinds: result.includedKinds,
        },
        result.processedIds,
      );
      // H6: if the user chose Retry-failed for this run, wipe the prior
      // set first — anything that failed AGAIN is captured below.
      if (retryPermaFailedPhotos) {
        await clearPermaFailedPhotos(result.guardianId);
      }
      if (result.permaFailedPhotoIds.length > 0) {
        await recordPermaFailedPhotos(result.guardianId, result.permaFailedPhotoIds);
      }
    } catch (histErr) {
      log.warn(`recordRun failed: ${(histErr as Error).message}`);
    }
    retryPermaFailedPhotos = false;

    if (prog) prog.classList.add('panel--hidden');
    if (done) done.classList.remove('panel--hidden');
    renderDone(result, saveTarget, include, format);
    pendingResume = null;
  } catch (err) {
    if ((err as Error).name === 'BwCancelledError') {
      // User pressed Stop — show the resume banner so they can pick up later.
      const prog2 = $<HTMLElement>('progress');
      const pre2 = $<HTMLElement>('pre-run');
      if (prog2) prog2.classList.add('panel--hidden');
      if (pre2) pre2.classList.remove('panel--hidden');
      try {
        const cp = await loadCheckpoint();
        if (cp) {
          pendingResume = cp;
          renderResume(cp);
        }
      } catch { /* ignore */ }
    } else {
      log.error(`run failed: ${(err as Error).message}`);
      showError(err);
    }
  } finally {
    currentAbort = null;
    port.disconnect();
    // Re-enable Start via the normal update path (accounts for the caller
    // clearing saveTarget in an intervening error state).
    updateStartButton();
  }
}

function stopRun(): void {
  if (currentAbort && !currentAbort.signal.aborted) {
    log.info('stop-btn: user requested cancel');
    currentAbort.abort();
  }
}

function renderResume(cp: Checkpoint | null): void {
  const box = $<HTMLDivElement>('resume-panel');
  applyResumeUiConstraint(cp !== null);
  // A live checkpoint means Resume/Discard is the primary action — hide the
  // "Download everything" quick-start so users don't have two competing
  // primaries. It re-appears when they Discard.
  const quick = $<HTMLDivElement>('quick-start');
  if (quick) quick.hidden = cp !== null;
  if (!box) return;
  if (!cp) {
    box.classList.add('panel--hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('panel--hidden');
  box.innerHTML = renderResumeBannerHtml(cp);
  $<HTMLButtonElement>('resume-btn')?.addEventListener('click', () => void resumeExport());
  $<HTMLButtonElement>('discard-btn')?.addEventListener('click', async () => {
    await clearCheckpoint();
    pendingResume = null;
    renderResume(null);
  });
}

/**
 * "N photos have permanently failed" banner (H6). Shown when LocalHistory
 * records any perma-failed photos for the current guardian. Retry marks
 * the next run to try them again; Ignore forever clears the state so the
 * banner goes away (photos stay skipped by future runs).
 */
function renderPermaFailed(count: number): void {
  const box = $<HTMLDivElement>('perma-failed-panel');
  if (!box) return;
  if (count === 0) {
    box.classList.add('panel--hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('panel--hidden');
  const label = count === 1 ? 'photo has' : 'photos have';
  const retryNote = retryPermaFailedPhotos
    ? '<div class="resume-meta">Retry is armed for the next run — click Start.</div>'
    : '';
  box.innerHTML = `
    <div class="resume-inner">
      <div>
        <div class="resume-title">${count} ${label} permanently failed to download</div>
        <div class="resume-meta">They're skipped by default so re-runs don't waste retries on them.</div>
        ${retryNote}
      </div>
      <div class="resume-actions">
        <button id="retry-failed-btn" class="btn btn--outline">Retry once</button>
        <button id="ignore-failed-btn" class="btn btn--muted">Ignore forever</button>
      </div>
    </div>
  `;
  $<HTMLButtonElement>('retry-failed-btn')?.addEventListener('click', () => {
    retryPermaFailedPhotos = true;
    renderPermaFailed(count);
  });
  $<HTMLButtonElement>('ignore-failed-btn')?.addEventListener('click', async () => {
    if (!cachedSession) return;
    await clearPermaFailedPhotos(cachedSession.guardianId);
    renderPermaFailed(0);
  });
}

/**
 * "Some discovery calls failed" banner (M4). Displayed when enrichSession
 * caught a 5xx / network error on /users/me, /students, or /message_threads
 * and returned an empty list. Without this, parents saw an empty
 * messages.json (or a smaller-than-expected student roster) with no
 * explanation.
 */
function renderDiscoveryWarning(
  warning: { steps: Array<{ step: 'roster' | 'threads' | 'users-me'; detail: string }> } | null,
): void {
  const box = $<HTMLDivElement>('discovery-warning-panel');
  if (!box) return;
  if (!warning || warning.steps.length === 0) {
    box.classList.add('panel--hidden');
    box.innerHTML = '';
    return;
  }
  const stepLabels: Record<string, string> = {
    'users-me': 'your account',
    roster: 'your student roster',
    threads: 'your message threads',
  };
  const items = warning.steps
    .map((s) => `<li>${escapeHtml(stepLabels[s.step] ?? s.step)}: ${escapeHtml(s.detail)}</li>`)
    .join('');
  box.classList.remove('panel--hidden');
  box.innerHTML = `
    <div class="resume-inner">
      <div>
        <div class="resume-title">Some Brightwheel data couldn't be loaded</div>
        <div class="resume-meta">Your export may be incomplete. This is a Brightwheel-side issue, not yours — try again in a bit.</div>
        <ul class="resume-meta" style="margin-top:0.25rem">${items}</ul>
      </div>
    </div>
  `;
}

function renderProgress(u: ProgressUpdate): void {
  const fill = $<HTMLDivElement>('progress-fill');
  const step = $<HTMLSpanElement>('progress-step');
  const counter = $<HTMLSpanElement>('progress-counter');
  const currentFile = $<HTMLDivElement>('current-file');
  const logEl = $<HTMLPreElement>('log-tail');
  if (step) step.textContent = u.message ?? u.step;
  if (counter && typeof u.current === 'number') {
    counter.textContent = u.total ? `${u.current} / ${u.total}` : `${u.current}`;
  }
  if (currentFile) currentFile.textContent = u.currentFile ?? '';
  if (fill && typeof u.current === 'number' && typeof u.total === 'number' && u.total > 0) {
    const pct = Math.min(100, Math.max(0, (u.current / u.total) * 100));
    fill.style.width = `${pct}%`;
  }
  if (u.step === 'done' && fill) fill.style.width = '100%';
  if (logEl) logEl.textContent = log.toText();
}

// ---- Date range presets ---------------------------------------------------

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIsoDate(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function applyPreset(preset: string, sinceLastMs: number | null): void {
  const from = $<HTMLInputElement>('date-from');
  const to = $<HTMLInputElement>('date-to');
  if (!from || !to) return;
  switch (preset) {
    case 'all':
      from.value = '';
      to.value = '';
      break;
    case '30d':
      from.value = daysAgoIsoDate(30);
      to.value = todayIsoDate();
      break;
    case '90d':
      from.value = daysAgoIsoDate(90);
      to.value = todayIsoDate();
      break;
    case 'year':
      from.value = `${new Date().getUTCFullYear()}-01-01`;
      to.value = todayIsoDate();
      break;
    case 'since-last':
      if (sinceLastMs) {
        from.value = new Date(sinceLastMs).toISOString().slice(0, 10);
        to.value = todayIsoDate();
      }
      break;
  }
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip--active'));
  const active = document.querySelector(`.chip[data-preset="${preset}"]`);
  active?.classList.add('chip--active');
}

// ---- Detect-only mode -----------------------------------------------------

function isDetectMode(): boolean {
  const p = new URLSearchParams(window.location.search);
  return p.get('mode') === 'detect';
}

async function renderDetect(): Promise<void> {
  const detect = $<HTMLElement>('detect-panel');
  const pre = $<HTMLElement>('pre-run');
  if (pre) pre.classList.add('panel--hidden');
  if (detect) detect.classList.remove('panel--hidden');
  const output = $<HTMLElement>('detect-output');
  const status = await askStatus();
  const payload = {
    hasCookie: status.hasCookie,
    guardianId: status.session?.guardianId ?? null,
    studentIds: status.session?.studentIds ?? [],
    students: status.session?.studentNames ?? {},
    threadIds: status.session?.threadIds ?? [],
    extensionVersion: (() => {
      try {
        return chrome.runtime.getManifest().version;
      } catch {
        return '?';
      }
    })(),
    userAgent: navigator.userAgent,
    detectedAt: new Date().toISOString(),
  };
  const text = JSON.stringify(payload, null, 2);
  if (output) output.textContent = text;
  $('detect-copy')?.addEventListener('click', () => {
    void navigator.clipboard.writeText(text);
  });
}

// ---- Copy diagnostic log --------------------------------------------------

function reportBugToDeveloper(): void {
  const version = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return 'unknown';
    }
  })();
  const tail = log
    .lines()
    .slice(-200)
    .map((l) => `${new Date(l.ts).toISOString()} ${l.level.padEnd(5)} ${l.msg}`)
    .join('\n');
  const url = buildBugReportUrl({
    errorMessage: lastError?.message ?? '(no error captured)',
    extensionVersion: version,
    userAgent: navigator.userAgent,
    logTail: tail,
  });
  // chrome.tabs.create is safest — window.open sometimes gets blocked as a
  // popup from event handlers deep inside a UI framework.
  try {
    chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function copyDiagnosticLog(): void {
  const version = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return 'unknown';
    }
  })();
  const tail = log.lines().slice(-200).map((l) => `${new Date(l.ts).toISOString()} ${l.level.padEnd(5)} ${l.msg}`).join('\n');
  const payload = [
    `# Takeout for Brightwheel diagnostic log`,
    `extension_version: ${version}`,
    `user_agent: ${navigator.userAgent}`,
    `error: ${lastError?.message ?? '(none)'}`,
    ``,
    tail,
  ].join('\n');
  void navigator.clipboard.writeText(payload);
  const ack = $<HTMLSpanElement>('error-copy-ack');
  if (ack) {
    ack.hidden = false;
    setTimeout(() => (ack.hidden = true), 2000);
  }
}

// ---- Boot -----------------------------------------------------------------

async function boot(): Promise<void> {
  if (isDetectMode()) {
    await renderDetect();
    return;
  }
  const status = await askStatus();
  if (!status.hasCookie || !status.session?.csrfToken || !status.session.guardianId) {
    renderStudents(null);
    return;
  }
  const s = status.session;
  cachedSession = {
    guardianId: s.guardianId!,
    clientUuid: s.clientUuid ?? '',
    userUuid: s.userUuid ?? '',
    csrfToken: s.csrfToken!,
    studentIds: (s.studentIds ?? []).slice(),
    threadIds: s.threadIds ?? [],
    clientVersion: s.clientVersion,
    userAgent: s.userAgent,
  };
  cachedStudentNames = s.studentNames ?? {};
  renderStudents(cachedSession, cachedStudentNames);
  renderFolderTip();
  updateStartButton();
  renderDiscoveryWarning(s.discoveryWarning ?? null);

  // Fire off the scope preview so the user sees "~2,860 photos, ~1.2 GB, ~18
  // min" before deciding to hit Start. Non-blocking — the export still works
  // if the peek fails.
  void refreshScopePreview();

  // Wire history-aware UI: "since last export" chip + skip-already-exported.
  try {
    const history = await loadHistory();
    const summary = summarize(history, cachedSession.guardianId);
    const chip = $<HTMLButtonElement>('chip-since-last');
    const skipRow = $<HTMLLabelElement>('skip-already-row');
    const skipLabel = $<HTMLSpanElement>('skip-already-label');
    if (summary.hasHistory) {
      if (chip) chip.classList.remove('chip--hidden');
      if (skipRow) skipRow.classList.remove('check-row--hidden');
      const total = summary.seenCounts.photos + summary.seenCounts.notes + summary.seenCounts.messages;
      if (skipLabel && total > 0) {
        skipLabel.textContent = `Skip items I already exported to this browser (${total.toLocaleString()} previously)`;
      }
      const skipInput = $<HTMLInputElement>('skip-already-exported');
      if (skipInput) skipInput.checked = true;
      // NEW: lead with a "welcome back — just get what's new" banner.
      renderWelcomeBack(summary);
    }
    renderPermaFailed(summary.permaFailedCount);
    // Chip click handlers.
    const sinceLastMs = summary.lastExportedAt;
    document.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        const preset = (c as HTMLElement).dataset.preset ?? 'all';
        applyPreset(preset, sinceLastMs);
      });
    });
  } catch (err) {
    log.warn(`history init failed: ${(err as Error).message}`);
  }

  // Live-update the save-hint copy when the include-set / format changes so
  // the ZIP-vs-CSV suggestion in the picker matches what the user last set.
  const rerenderHint = () => {
    if (!saveTarget) return;
    if (saveTarget.kind === 'zip') {
      setSaveHint(`Saving to ${saveTarget.handle.name}`);
    }
  };
  // E: show/hide the Format section based on the include-set.
  const syncFormatVisibility = () => {
    const section = $<HTMLElement>('format-section');
    if (!section) return;
    section.hidden = !shouldShowFormatSection(currentIncludeSet());
  };
  const onIncludeChange = () => {
    rerenderHint();
    syncFormatVisibility();
  };
  ['include-photos', 'include-notes', 'include-messages', 'include-viewer', 'include-daily-reports'].forEach(
    (id) => $(id)?.addEventListener('change', onIncludeChange),
  );
  $('debug-mode')?.addEventListener('change', rerenderHint);
  document.querySelectorAll('input[name="format"]').forEach((el) =>
    el.addEventListener('change', rerenderHint),
  );
  syncFormatVisibility(); // set initial state

  try {
    const cp = await loadCheckpoint();
    if (cp && Date.now() - cp.updatedAt < CHECKPOINT_MAX_AGE_MS && cp.guardianId === cachedSession.guardianId) {
      pendingResume = cp;
      applyCheckpointSettingsToDom(cp);
      renderResume(cp);
    } else if (cp) {
      await clearCheckpoint();
    }
  } catch (err) {
    log.warn(`loadCheckpoint failed: ${(err as Error).message}`);
  }

  // Popup → tab handoff. The popup decides the intent (quick-refresh /
  // quick-start / resume / customize) and hands off via ?action=<x>. Here
  // we translate that intent into the standard folder-pick + startRun flow
  // the pre-run panel would drive if the user had clicked buttons manually.
  // Deferred with a microtask so the pre-run panel has fully rendered when
  // the auto-flow starts (folder picker needs a real page context).
  const action = parseAction(window.location.search);
  if (action) {
    // Fire-and-forget; each handler is self-contained and shows its own
    // errors via the existing showError / progress panels.
    void dispatchAction(action);
  }
}

/**
 * Auto-flows triggered by the popup handoff. Each maps to the same code
 * path a manual click on the tab would use — the popup just supplies the
 * intent so the user doesn't have to re-choose.
 */
async function dispatchAction(action: PopupAction): Promise<void> {
  switch (action) {
    case 'quick-refresh': {
      // Same code path as clicking the welcome-back banner's primary CTA.
      // Requires history — if there is none, fall through to quick-start
      // rather than silently strand the user on a mystery blank tab.
      if (!cachedSession) return;
      const history = await loadHistory();
      const summary = summarize(history, cachedSession.guardianId);
      if (summary.hasHistory && summary.lastExportedAt) {
        const lastYmd = new Date(summary.lastExportedAt).toISOString().slice(0, 10);
        await quickRefreshSinceLast(lastYmd);
      } else {
        log.info('action=quick-refresh but no history yet — falling back to quick-start');
        await quickStartEverything();
      }
      return;
    }
    case 'quick-start':
      await quickStartEverything();
      return;
    case 'resume':
      // pendingResume is populated during boot's checkpoint check. If no
      // checkpoint is present we quietly no-op — the user landed here from
      // a stale popup state and the pre-run panel is the right destination.
      if (pendingResume) await resumeExport();
      return;
    case 'customize':
      // Nothing to auto-do — the full pre-run panel IS the customize UI.
      // Scroll it into view for hygiene.
      $<HTMLElement>('pre-run')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
  }
}

/**
 * Restore the pre-run DOM controls (What to include / Date range / Format /
 * Debug / Skip already exported) from a checkpoint's persisted settings so
 * Resume replays with the same scope the original run picked. Without this,
 * a fresh page-load has empty date inputs and Resume would silently expand
 * "Last 30 days" to "all time".
 */
function applyCheckpointSettingsToDom(cp: Checkpoint): void {
  const s = cp.settings;
  if (!s) return;
  if (s.include) {
    const cb = (id: string, v?: boolean) => {
      const el = $<HTMLInputElement>(id);
      if (el && typeof v === 'boolean') el.checked = v;
    };
    cb('include-photos', s.include.photos);
    cb('include-notes', s.include.notes);
    cb('include-messages', s.include.messages);
    cb('include-viewer', s.include.viewer);
    cb('include-daily-reports', s.include.dailyReports);
  }
  if (s.format) {
    const el = document.querySelector<HTMLInputElement>(`input[name="format"][value="${s.format}"]`);
    if (el) el.checked = true;
  }
  if (s.dateRange) {
    const from = $<HTMLInputElement>('date-from');
    const to = $<HTMLInputElement>('date-to');
    if (from && s.dateRange.from) from.value = s.dateRange.from;
    if (to && s.dateRange.to) to.value = s.dateRange.to;
  }
  if (typeof s.debug === 'boolean') {
    const el = $<HTMLInputElement>('debug-mode');
    if (el) el.checked = s.debug;
  }
  if (typeof s.skipAlreadyExported === 'boolean') {
    const el = $<HTMLInputElement>('skip-already-exported');
    if (el) el.checked = s.skipAlreadyExported;
  }
}

// Live popup→tab handoff: when the popup focuses an existing takeout tab
// (rather than opening a new one), it sends a `dispatch-action` message
// with the new intent. We honour it only when no run is in flight — a
// mid-export dispatch would race two runs on the same checkpoint.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'bw-takeout:dispatch-action') return false;
  const action = parseAction(`?action=${msg.action}`);
  if (!action) {
    sendResponse({ ok: false, reason: 'invalid-action' });
    return false;
  }
  if (currentAbort) {
    log.info(`dispatch-action=${action} ignored — a run is already in progress`);
    sendResponse({ ok: false, reason: 'busy' });
    return false;
  }
  log.info(`dispatch-action=${action} from popup handoff`);
  void dispatchAction(action);
  sendResponse({ ok: true });
  return false;
});

$('choose-save-zip')?.addEventListener('click', () => void pickSaveZip());
$('choose-save-folder')?.addEventListener('click', () => void pickSaveFolder());
$('start')?.addEventListener('click', () => void startRun());
$('stop-btn')?.addEventListener('click', () => stopRun());
$('restart')?.addEventListener('click', () => window.location.reload());
$('error-copy-log')?.addEventListener('click', () => copyDiagnosticLog());
$('error-report-bug')?.addEventListener('click', () => reportBugToDeveloper());
$('debug-suggest-enable')?.addEventListener('click', () => enableDebugForRetry());
$('customize-toggle')?.addEventListener('click', () => openCustomizePanel());
$('quick-start-btn')?.addEventListener('click', () => void quickStartEverything());

void boot();
