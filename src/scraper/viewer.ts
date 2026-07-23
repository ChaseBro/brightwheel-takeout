// Standalone HTML viewer emitted into the archive as `viewer/index.html`
// alongside `viewer/data.js`. Self-contained: no CDN references, no external
// assets, no fetch() at load time — data.js just assigns to window.__DATA__
// so the archive works both from a real HTTP origin AND from a bare
// double-click on index.html (file:// context).
//
// Two files, both emitted by run.ts's viewer step:
//   viewer/index.html — the shell + timeline/gallery UI
//   viewer/data.js    — window.__DATA__ = { notes, messages, photos, manifest }
//
// Bundling the data as JS (not JSON) is what makes file:// work. Every
// browser blocks fetch('./data.json') from a file:// origin as cross-origin;
// none block <script src="./data.js">.

import type { BwActivity, BwMessage } from './types.js';

export interface ViewerData {
  notes: BwActivity[];
  messages: BwMessage[];
  photos: Array<{
    file: string;
    object_id: string;
    event_date: string;
    note: string | null;
    actor_first_name?: string | null;
    actor_last_name?: string | null;
  }>;
  manifest: {
    guardianId: string;
    studentIds: string[];
    fetchedAt: string;
    counts: { notes: number; messages: number; photos: number; dailyReports?: number };
    extensionVersion?: string;
    /**
     * Enriched context populated by the metadata orchestrator. Optional so
     * older archives (pre-metadata) still render — the viewer degrades to
     * the plain "Takeout for Brightwheel" header when these are absent.
     */
    schools?: Record<string, { schoolId: string; name?: string; timeZone?: string; city?: string; state?: string }>;
    student_profiles?: Record<string, {
      studentId: string;
      displayName: string;
      firstName?: string;
      lastName?: string;
      primaryRoom?: { roomId: string; name?: string };
      primarySchoolId?: string;
    }>;
    /**
     * Loose typing — the manifest section can carry additional per-staff
     * fields (email, profilePhoto, schoolIds, first/lastSeenAt). The viewer
     * only reads `objectId`, `displayName`, `role`, `userType` today, but
     * typing this loosely keeps run.ts's `toManifestSection` output
     * assignable without a cast.
     */
    staff?: Record<string, unknown>;
  };
}

/**
 * Emit the `viewer/data.js` sidecar. Assigns to `window.__DATA__` so the
 * viewer's inline script picks it up. Data is JSON-stringified (safe against
 * any special chars in note bodies / message text).
 */
export function renderViewerDataJs(data: ViewerData): string {
  // Escape </script> in stringified data — a message body containing
  // that literal would otherwise break out of the script block.
  const json = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
  return `window.__DATA__ = ${json};\n`;
}

/**
 * Return the full HTML text of the viewer. Deterministic — same output every
 * call (data lives in the sidecar data.js so the shell is content-independent).
 */
export function renderViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Takeout for Brightwheel — Archive</title>
<style>
  :root {
    --primary: #4A6FA5;
    --secondary: #8D6E1C;
    --sage: #8B9D77;
    --sage-deep: #5F6E4F;
    --sage-light: #C5D4BA;
    --cream: #FAF8F4;
    --cream-deep: #F0E9DD;
    --surface: #FEFDFB;
    --ink: #3D3832;
    --ink-strong: #2A1F15;
    --border: rgba(0,0,0,0.08);
  }
  *, *::before, *::after { box-sizing: border-box; }
  * { margin: 0; padding: 0; }
  html, body { min-height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
                 Ubuntu, "Helvetica Neue", sans-serif;
    background: var(--cream);
    color: var(--ink);
    line-height: 1.55;
  }
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 1.25rem 1.5rem 1rem;
    position: sticky; top: 0; z-index: 10;
    backdrop-filter: blur(6px);
  }
  header h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-weight: 600;
    color: var(--ink-strong);
    font-size: 1.4rem;
    margin-bottom: 0.25rem;
  }
  header .meta { color: var(--sage-deep); font-size: 0.9rem; }
  .controls {
    display: flex; gap: 0.85rem; flex-wrap: wrap; align-items: center;
    margin-top: 0.85rem;
  }
  .controls label { font-size: 0.85rem; color: var(--ink-strong); display: flex; align-items: center; gap: 0.35rem; }
  .controls input[type="date"], .controls input[type="search"], .controls select {
    font: inherit;
    padding: 0.4rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
  }
  .controls input[type="search"] { min-width: 200px; }
  .view-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .view-toggle button {
    background: var(--surface); border: none; padding: 0.4rem 0.9rem;
    cursor: pointer; font: inherit; color: var(--ink);
    border-right: 1px solid var(--border);
  }
  .view-toggle button:last-child { border-right: none; }
  .view-toggle button.active { background: var(--sage-deep); color: var(--surface); }
  main {
    max-width: 900px;
    margin: 2rem auto;
    padding: 0 1.5rem 5rem;
  }
  main.gallery { max-width: 1200px; }
  .empty { padding: 3rem 1rem; text-align: center; color: var(--sage-deep); }
  .day-group { margin-bottom: 2.5rem; }
  .day-group h2 {
    font-family: Georgia, serif;
    font-weight: 600;
    color: var(--sage-deep);
    font-size: 1.05rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1rem;
  }
  .entry {
    display: flex;
    gap: 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem 1.25rem;
    margin-bottom: 0.75rem;
  }
  .entry .pill {
    flex-shrink: 0;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    height: fit-content;
    color: var(--surface);
  }
  .pill.photo { background: var(--primary); }
  .pill.note  { background: var(--sage-deep); }
  .pill.message   { background: var(--secondary); }
  .entry .body { flex: 1; min-width: 0; }
  .entry .who { font-size: 0.85rem; color: var(--sage-deep); margin-bottom: 0.25rem; }
  .entry .text { color: var(--ink); word-wrap: break-word; white-space: pre-wrap; }
  .entry .when { font-size: 0.78rem; color: var(--sage-deep); margin-top: 0.5rem; }
  .entry img { max-width: 100%; border-radius: 8px; margin-top: 0.6rem; display: block; cursor: zoom-in; }
  a { color: var(--primary); }

  /* Gallery view */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.5rem;
  }
  .grid-cell {
    aspect-ratio: 1; overflow: hidden; border-radius: 8px;
    background: var(--cream-deep); position: relative;
    cursor: zoom-in;
  }
  .grid-cell img {
    width: 100%; height: 100%; object-fit: cover;
    display: block;
    transition: transform 0.2s ease-out;
  }
  .grid-cell:hover img { transform: scale(1.03); }
  .grid-cell .caption {
    position: absolute; bottom: 0; left: 0; right: 0;
    padding: 0.35rem 0.5rem 0.35rem;
    background: linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.6) 100%);
    color: white; font-size: 0.72rem; letter-spacing: 0.02em;
    opacity: 0; transition: opacity 0.15s;
  }
  .grid-cell:hover .caption { opacity: 1; }

  /* Lightbox */
  .lightbox {
    position: fixed; inset: 0;
    background: rgba(20, 20, 20, 0.92);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
    padding: 2rem;
    cursor: zoom-out;
  }
  .lightbox img {
    max-width: 100%; max-height: 100%;
    border-radius: 6px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }
  .lightbox .lb-meta {
    position: absolute; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
    color: white; font-size: 0.9rem; text-align: center;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    max-width: 80%;
  }
  .lightbox .lb-nav {
    position: absolute; top: 50%; transform: translateY(-50%);
    background: rgba(255,255,255,0.15); border: none; color: white;
    font-size: 1.8rem; padding: 0.75rem 1.1rem;
    cursor: pointer; border-radius: 8px;
  }
  .lightbox .lb-nav.prev { left: 1.5rem; }
  .lightbox .lb-nav.next { right: 1.5rem; }
  .lightbox .lb-close {
    position: absolute; top: 1.5rem; right: 1.5rem;
    background: rgba(255,255,255,0.15); border: none; color: white;
    padding: 0.5rem 0.8rem; cursor: pointer; border-radius: 8px;
    font-size: 0.9rem;
  }
  .lightbox.hidden { display: none; }

  footer {
    max-width: 900px; margin: 3rem auto 0; padding: 1.5rem;
    color: var(--sage-deep); font-size: 0.85rem; text-align: center;
    border-top: 1px solid var(--border);
  }
  .viewer-disclaimer { opacity: 0.75; }
</style>
</head>
<body>
<header>
  <h1 id="header-title">Takeout for Brightwheel</h1>
  <div class="meta" id="meta">Loading archive…</div>
  <div class="meta students" id="header-students"></div>
  <div class="controls">
    <div class="view-toggle" role="group" aria-label="View">
      <button type="button" id="view-timeline" class="active">Timeline</button>
      <button type="button" id="view-gallery">Photo gallery</button>
    </div>
    <label>Type
      <select id="filter-type">
        <option value="all">All</option>
        <option value="photo">Photos</option>
        <option value="note">Notes</option>
        <option value="message">Messages</option>
      </select>
    </label>
    <label>From <input type="date" id="filter-from"></label>
    <label>To <input type="date" id="filter-to"></label>
    <label>Search <input type="search" id="filter-q" placeholder="body / author / filename"></label>
  </div>
</header>
<main id="root"><p class="empty">Loading…</p></main>
<footer>
  <span id="footer-meta"></span>
  <span class="viewer-disclaimer"> · Not affiliated with Brightwheel, Inc.</span>
</footer>

<div class="lightbox hidden" id="lightbox">
  <button class="lb-close" type="button">Close (Esc)</button>
  <button class="lb-nav prev" type="button" aria-label="Previous">‹</button>
  <img id="lb-img" src="" alt="">
  <div class="lb-meta" id="lb-meta"></div>
  <button class="lb-nav next" type="button" aria-label="Next">›</button>
</div>

<script src="./data.js"></script>
<script>
(function () {
  var DATA = (typeof window !== 'undefined' && window.__DATA__) || null;
  if (!DATA) {
    document.getElementById('meta').textContent =
      "Couldn't find data.js — make sure viewer/data.js sits next to this index.html.";
    document.getElementById('root').innerHTML =
      '<p class="empty">No data loaded. Re-export and keep the whole viewer folder together.</p>';
    return;
  }
  var entries = [];
  (DATA.notes || []).forEach(function (n) {
    entries.push({
      kind: 'note',
      when: n.event_date || n.created_at || '',
      who: ((n.actor && ((n.actor.first_name || '') + ' ' + (n.actor.last_name || ''))) || '').trim() || 'Teacher',
      text: n.note || '',
    });
  });
  (DATA.messages || []).forEach(function (m) {
    var who = ((m.sender && ((m.sender.first_name || '') + ' ' + (m.sender.last_name || '')))
      || m.from || '').trim() || 'Sender';
    entries.push({
      kind: 'message',
      when: m.created_at || m.date || '',
      who: who,
      text: m.body || '',
    });
  });
  (DATA.photos || []).forEach(function (p) {
    entries.push({
      kind: 'photo',
      when: p.event_date || '',
      who: ((p.actor_first_name || '') + ' ' + (p.actor_last_name || '')).trim(),
      text: p.note || '',
      src: '../photos/' + p.file,
      filename: p.file,
    });
  });
  entries.sort(function (a, b) { return (b.when || '').localeCompare(a.when || ''); });

  var counts = {
    notes: (DATA.notes || []).length,
    messages: (DATA.messages || []).length,
    photos: (DATA.photos || []).length,
  };
  document.getElementById('meta').textContent =
    entries.length + ' items — ' +
    counts.photos + ' photos, ' + counts.notes + ' notes, ' + counts.messages + ' messages';

  // Enriched header: append the school name to the H1 when known, and list
  // the students with their classroom below. Additive — an archive without
  // these fields still shows the plain "Takeout for Brightwheel" title.
  var manifest = DATA.manifest || {};
  var schools = manifest.schools || {};
  var profiles = manifest.student_profiles || {};
  var schoolNames = [];
  Object.keys(schools).forEach(function (id) {
    var s = schools[id];
    if (s && s.name) schoolNames.push(s.name);
  });
  var titleEl = document.getElementById('header-title');
  if (titleEl && schoolNames.length > 0) {
    titleEl.textContent = 'Takeout for Brightwheel — ' + schoolNames.join(' & ');
  }
  var studentSummary = [];
  Object.keys(profiles).forEach(function (sid) {
    var p = profiles[sid];
    if (!p) return;
    var line = p.displayName || sid;
    var extras = [];
    if (p.primaryRoom && p.primaryRoom.name) extras.push(p.primaryRoom.name);
    if (p.primarySchoolId && schools[p.primarySchoolId] && schools[p.primarySchoolId].name) {
      extras.push(schools[p.primarySchoolId].name);
    }
    if (extras.length > 0) line += ' (' + extras.join(' · ') + ')';
    studentSummary.push(line);
  });
  var studentsEl = document.getElementById('header-students');
  if (studentsEl && studentSummary.length > 0) {
    studentsEl.textContent = studentSummary.join('  ·  ');
  }
  var fetchedAt = DATA.manifest && DATA.manifest.fetchedAt
    ? new Date(DATA.manifest.fetchedAt).toLocaleString()
    : 'unknown';
  document.getElementById('footer-meta').textContent =
    'Exported ' + fetchedAt +
    (DATA.manifest && DATA.manifest.extensionVersion
      ? ' · Takeout for Brightwheel v' + DATA.manifest.extensionVersion
      : '');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined,
        { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return iso; }
  }
  function dayKey(iso) { return iso ? iso.slice(0, 10) : 'undated'; }
  function dayLabel(k) {
    if (k === 'undated') return 'Undated';
    var d = new Date(k + 'T12:00:00');
    return d.toLocaleDateString(undefined,
      { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }

  var view = 'timeline';
  document.getElementById('view-timeline').addEventListener('click', function () {
    view = 'timeline';
    document.getElementById('view-timeline').classList.add('active');
    document.getElementById('view-gallery').classList.remove('active');
    document.getElementById('root').classList.remove('gallery');
    render();
  });
  document.getElementById('view-gallery').addEventListener('click', function () {
    view = 'gallery';
    document.getElementById('view-gallery').classList.add('active');
    document.getElementById('view-timeline').classList.remove('active');
    document.getElementById('root').classList.add('gallery');
    render();
  });

  function filtered() {
    var kind = document.getElementById('filter-type').value;
    var from = document.getElementById('filter-from').value;
    var to = document.getElementById('filter-to').value;
    var q = (document.getElementById('filter-q').value || '').toLowerCase().trim();
    return entries.filter(function (e) {
      if (kind !== 'all' && e.kind !== kind) return false;
      var day = dayKey(e.when);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (q) {
        var hay = ((e.text || '') + ' ' + (e.who || '') + ' ' + (e.filename || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function render() {
    var root = document.getElementById('root');
    var items = filtered();
    if (items.length === 0) {
      // Distinguish "genuinely empty archive" from "current filter hid
      // everything" so a parent whose export truly is empty doesn't think
      // the viewer's broken.
      var msg = entries.length === 0
        ? "This archive is empty — no photos, notes, or messages were exported."
        : 'No entries match the current filter. Try clearing the search or date range.';
      root.innerHTML = '<p class="empty">' + escapeHtml(msg) + '</p>';
      return;
    }
    if (view === 'gallery') {
      var photos = items.filter(function (e) { return e.kind === 'photo'; });
      if (photos.length === 0) {
        var galleryMsg = entries.filter(function (e) { return e.kind === 'photo'; }).length === 0
          ? 'This archive contains no photos.'
          : 'No photos match the current filter. Photo gallery view shows only photos.';
        root.innerHTML = '<p class="empty">' + escapeHtml(galleryMsg) + '</p>';
        return;
      }
      root.innerHTML = '<div class="grid">' + photos.map(function (p, i) {
        return '<div class="grid-cell" data-i="' + i + '">' +
          '<img loading="lazy" src="' + encodeURI(p.src) + '" alt="' + escapeHtml(p.text || '') + '">' +
          '<div class="caption">' + escapeHtml(dayKey(p.when)) + '</div>' +
          '</div>';
      }).join('') + '</div>';
      Array.prototype.forEach.call(root.querySelectorAll('.grid-cell'), function (cell) {
        cell.addEventListener('click', function () {
          openLightbox(photos, parseInt(cell.getAttribute('data-i'), 10));
        });
      });
      return;
    }
    // timeline
    var groups = {};
    items.forEach(function (e) {
      var k = dayKey(e.when);
      (groups[k] = groups[k] || []).push(e);
    });
    var keys = Object.keys(groups).sort().reverse();
    var photoIndex = items.filter(function (e) { return e.kind === 'photo'; });
    var photoIdMap = {};
    photoIndex.forEach(function (p, i) { photoIdMap[p.src] = i; });
    root.innerHTML = keys.map(function (k) {
      var day = dayLabel(k);
      var rows = groups[k].map(function (e) {
        var pill = '<span class="pill ' + e.kind + '">' + e.kind + '</span>';
        var body = [
          e.who ? '<div class="who">' + escapeHtml(e.who) + '</div>' : '',
          e.text ? '<div class="text">' + escapeHtml(e.text) + '</div>' : '',
          e.src ? '<img loading="lazy" data-src="' + encodeURI(e.src) + '" src="' + encodeURI(e.src) + '" alt="' + escapeHtml(e.text || 'Photo') + '">' : '',
          '<div class="when">' + escapeHtml(fmtWhen(e.when)) + '</div>',
        ].join('');
        return '<div class="entry">' + pill + '<div class="body">' + body + '</div></div>';
      }).join('');
      return '<section class="day-group"><h2>' + escapeHtml(day) + '</h2>' + rows + '</section>';
    }).join('');
    Array.prototype.forEach.call(root.querySelectorAll('.entry img'), function (img) {
      img.addEventListener('click', function () {
        var src = img.getAttribute('data-src');
        var i = photoIdMap[src];
        if (i != null) openLightbox(photoIndex, i);
      });
    });
  }

  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lb-img');
  var lbMeta = document.getElementById('lb-meta');
  var lbPhotos = [], lbIndex = 0;
  function openLightbox(photos, i) {
    lbPhotos = photos; lbIndex = i;
    lb.classList.remove('hidden');
    updateLightbox();
  }
  function updateLightbox() {
    var p = lbPhotos[lbIndex];
    if (!p) return;
    lbImg.src = p.src;
    var meta = fmtWhen(p.when);
    if (p.text) meta += ' — ' + p.text;
    lbMeta.textContent = (lbIndex + 1) + ' / ' + lbPhotos.length + '   ·   ' + meta;
  }
  function closeLightbox() { lb.classList.add('hidden'); }
  function prev() { lbIndex = (lbIndex - 1 + lbPhotos.length) % lbPhotos.length; updateLightbox(); }
  function next() { lbIndex = (lbIndex + 1) % lbPhotos.length; updateLightbox(); }
  lb.addEventListener('click', function (ev) {
    if (ev.target === lb || ev.target === lbImg) closeLightbox();
  });
  document.querySelector('.lb-close').addEventListener('click', closeLightbox);
  document.querySelector('.lb-nav.prev').addEventListener('click', function (ev) { ev.stopPropagation(); prev(); });
  document.querySelector('.lb-nav.next').addEventListener('click', function (ev) { ev.stopPropagation(); next(); });
  document.addEventListener('keydown', function (ev) {
    if (lb.classList.contains('hidden')) return;
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === 'ArrowLeft') prev();
    else if (ev.key === 'ArrowRight') next();
  });

  // Immediate render on the select + date inputs (rare, discrete events).
  ['filter-type', 'filter-from', 'filter-to'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', render);
    document.getElementById(id).addEventListener('change', render);
  });
  // Debounce the free-text search — an archive with a few thousand items
  // rebuilds a hefty innerHTML string per render, and per-keystroke
  // rendering felt laggy in the wild. 150 ms is imperceptible while typing
  // and cuts the render count by ~10x on a fast typist.
  var searchTimer = null;
  document.getElementById('filter-q').addEventListener('input', function () {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchTimer = null;
      render();
    }, 150);
  });
  document.getElementById('filter-q').addEventListener('change', render);
  render();
})();
</script>
</body>
</html>
`;
}
