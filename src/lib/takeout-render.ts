// Shared render helpers for the popup ("action layer") and takeout tab
// ("workspace"). Everything here is pure — no DOM queries, no message
// passing — so we can unit-test in jsdom and reuse the exact same HTML in
// both surfaces.
//
// Why HTML strings and not Element instances?  The takeout tab and popup
// both build their panels by assigning `innerHTML`. Returning strings keeps
// the helpers cheap to compose and easy to compare in tests, at the cost of
// forcing every caller to remember to escape untrusted input. That contract
// is enforced here: every helper calls `escapeHtml` on any user- or
// server-supplied string before interpolation.

import type { ScopePreview } from '@/scraper/preview.js';
import { formatBytes, formatDuration } from '@/scraper/preview.js';
import type { Checkpoint } from '@/lib/checkpoint.js';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

// ---- Scope preview --------------------------------------------------------

/**
 * Compact scope preview for the popup: one headline line with photo count +
 * duration + size. No per-student breakdown here — that's the tab's job.
 */
export function renderScopePreviewCompactHtml(scope: ScopePreview): string {
  const bytes = formatBytes(scope.estimatedBytes);
  const dur = formatDuration(scope.estimatedMs);
  const photos = `${scope.totalPhotos.toLocaleString()} ${pluralize(scope.totalPhotos, 'photo')}`;
  const notes = `${scope.totalNotes.toLocaleString()} ${pluralize(scope.totalNotes, 'note')}`;
  const msgs = `${scope.totalMessages.toLocaleString()} ${pluralize(scope.totalMessages, 'message')}`;
  return `
    <div class="scope-preview__headline">~${photos} · ${bytes} · ${dur}</div>
    <div class="scope-preview__meta">${notes} · ${msgs} · at polite pacing</div>
  `;
}

/**
 * Full scope preview for the takeout tab's pre-run panel: headline + per-
 * student breakdown + thread messages. Matches the previous inline renderer
 * in `takeout.ts` byte-for-byte in shape so the tab keeps looking the same.
 */
export function renderScopePreviewFullHtml(scope: ScopePreview): string {
  const bytes = formatBytes(scope.estimatedBytes);
  const dur = formatDuration(scope.estimatedMs);
  const perStudent = scope.perStudent
    .map((s) => {
      const name = s.studentName
        ? escapeHtml(s.studentName)
        : `Student ${escapeHtml(s.studentId.slice(0, 8))}…`;
      return `<span>${name}: <b>${s.photos.toLocaleString()}</b> ${pluralize(s.photos, 'photo')}, <b>${s.notes.toLocaleString()}</b> ${pluralize(s.notes, 'note')}</span>`;
    })
    .join('');
  const msgCount = scope.totalMessages;
  const msgLine =
    msgCount > 0
      ? `<span><b>${msgCount.toLocaleString()}</b> ${pluralize(msgCount, 'message')}</span>`
      : '';
  return `
    <div class="scope-preview__headline">
      About to export ~${scope.totalPhotos.toLocaleString()} ${pluralize(scope.totalPhotos, 'photo')}, ${scope.totalNotes.toLocaleString()} ${pluralize(scope.totalNotes, 'note')}, ${scope.totalMessages.toLocaleString()} ${pluralize(scope.totalMessages, 'message')}
    </div>
    <div class="scope-preview__meta">Rough size: <b>${bytes}</b> · Rough time: <b>${dur}</b> at polite pacing</div>
    <div class="scope-preview__list">${perStudent}${msgLine}</div>
  `;
}

// ---- Welcome-back banner --------------------------------------------------

export interface HistorySummary {
  hasHistory: boolean;
  lastExportedAt: number | null;
  seenCounts: { photos: number; notes: number; messages: number };
}

export interface WelcomeBackOpts {
  /** DOM id to give the primary CTA button. Callers wire the click handler. */
  primaryButtonId: string;
  /** Full label for the primary CTA — callers own date interpolation. */
  primaryLabel: string;
  /** Optional hint under the CTA (e.g. "Full re-export options below ↓"). */
  hint?: string;
}

/** Locale-aware short date used in the welcome-back title and button label. */
export function formatShortDate(ts: number, now: Date = new Date()): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function renderWelcomeBackHtml(
  summary: HistorySummary,
  opts: WelcomeBackOpts,
): string {
  if (!summary.hasHistory || !summary.lastExportedAt) return '';
  const lastDisplay = formatShortDate(summary.lastExportedAt);
  const c = summary.seenCounts;
  const total = c.photos + c.notes + c.messages;
  const hintHtml = opts.hint ? `<div class="welcome-hint">${escapeHtml(opts.hint)}</div>` : '';
  return `
    <div class="welcome-inner">
      <div class="welcome-copy">
        <div class="welcome-title">Welcome back — your last export was ${escapeHtml(lastDisplay)}</div>
        <div class="welcome-meta">
          You've exported <b>${c.photos.toLocaleString()}</b> ${pluralize(c.photos, 'photo')},
          <b>${c.notes.toLocaleString()}</b> ${pluralize(c.notes, 'note')}, and
          <b>${c.messages.toLocaleString()}</b> ${pluralize(c.messages, 'message')}
          from this browser (${total.toLocaleString()} items).
        </div>
      </div>
      <div class="welcome-actions">
        <button id="${escapeHtml(opts.primaryButtonId)}" class="btn btn--gold">${escapeHtml(opts.primaryLabel)}</button>
        ${hintHtml}
      </div>
    </div>
  `;
}

// ---- Resume banner --------------------------------------------------------

export function ageLabelFromNow(updatedAt: number, now: number = Date.now()): string {
  const ageHours = Math.max(0, Math.floor((now - updatedAt) / (60 * 60 * 1000)));
  return ageHours < 1
    ? 'less than an hour ago'
    : `${ageHours} ${pluralize(ageHours, 'hour')} ago`;
}

export function checkpointItemCount(cp: Checkpoint): number {
  return (
    cp.seenObjectIds.photos.length +
    cp.seenObjectIds.notes.length +
    cp.seenObjectIds.messages.length
  );
}

export function renderResumeBannerHtml(cp: Checkpoint, now: number = Date.now()): string {
  const n = checkpointItemCount(cp);
  const ageLabel = ageLabelFromNow(cp.updatedAt, now);
  return `
    <div class="resume-inner">
      <div>
        <div class="resume-title">Unfinished export from ${escapeHtml(ageLabel)}</div>
        <div class="resume-meta">${n} ${pluralize(n, 'item')} already processed — pick up where you left off, or start fresh.</div>
      </div>
      <div class="resume-actions">
        <button id="resume-btn" class="btn btn--outline">Resume</button>
        <button id="discard-btn" class="btn btn--muted">Discard</button>
      </div>
    </div>
  `;
}

// ---- Student list / chips -------------------------------------------------

/**
 * Full-row student list used by the takeout tab's pre-run panel — each row
 * shows the display name AND the raw student id so a user hunting a specific
 * child in a two-guardian household can tell them apart.
 */
export function renderStudentListHtml(
  studentIds: string[],
  names: Record<string, string> = {},
): string {
  if (studentIds.length === 0) {
    return '<div class="student-row student-row--placeholder">No students detected. Open a Brightwheel student feed page and reload this tab.</div>';
  }
  return studentIds
    .map((sid) => {
      const display = names[sid] ?? `Student ${sid.slice(0, 8)}…`;
      return `
    <div class="student-row" data-student="${escapeHtml(sid)}">
      <div>
        <div class="student-name">${escapeHtml(display)}</div>
        <div class="student-meta">${escapeHtml(sid)}</div>
      </div>
    </div>`;
    })
    .join('');
}

/**
 * Compact chip list used by the popup. No ids — the popup is glanceable and
 * the raw guardian/student UUIDs are useless clutter there.
 */
export function renderStudentChipsHtml(
  studentIds: string[],
  names: Record<string, string> = {},
): string {
  if (studentIds.length === 0) return '';
  return studentIds
    .map((sid) => {
      const display = names[sid] ?? `Student ${sid.slice(0, 8)}…`;
      return `<span class="student-chip">${escapeHtml(display)}</span>`;
    })
    .join('');
}
