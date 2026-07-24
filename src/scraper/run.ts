// Orchestrator: pulls notes → messages → photos, streams into a Sink.
//
// The signature keeps every external interaction behind an interface so
// tests can drive a full run with mocked fetch, a MemorySink, and NullSync.
//
// Compared to the initial pass, run() now supports:
//   - include-set (F-B): skip whole kinds when the parent unchecked them
//   - output format (F-A): CSV / XLSX / JSON via ./formatters
//   - date range (F-D): server-side on /activities, client-side on messages
//   - skip-already-exported (F-F): filter object_ids from a per-guardian set
//   - Debug mode (F-G): capture every request into debug/
//   - Sink abstraction (F-C / F-J): ZipSink / SingleFileSink / FolderSink

import type {
  Session,
  PhotoEntry,
  ProgressChannel,
  Manifest,
  ExportEvent,
  BwActivity,
  BwMessage,
} from './types.js';
import type { Sync } from '@/lib/sync.js';
import type { RingLogger } from '@/lib/log.js';
import { NullSync } from '@/lib/sync.js';
import { BwClient, BwAuthError } from './bw-client.js';
import { iterateActivities } from './activities.js';
import { fetchThreadMessages } from './messages.js';
import { downloadPhotoStream, makeRefetchUrl, planPhotoEntry } from './photos.js';
import { stampExifDate, localTimeZone } from './exif.js';
import { renderViewerHtml, renderViewerDataJs } from './viewer.js';
import { CheckpointWriter, clearCheckpoint, emptySeen, type Checkpoint } from '@/lib/checkpoint.js';
import { PACING } from './pacing.js';
import { log as defaultLog } from '@/lib/log.js';
import type { Sink } from './sinks.js';
import type { DebugCaptureInterface } from './debug-capture.js';
import type {
  FormatterManifest,
  MessageRow,
  NoteRow,
  OutputFormat,
  PhotoRow,
} from './formatters/types.js';
import {
  writeDailyReportsCsv,
  writeMessagesCsv,
  writeNotesCsv,
  writePhotoManifestCsv,
} from './formatters/csv.js';
import {
  writeMessagesJson,
  writeNotesJson,
  writePhotoManifestJson,
} from './formatters/json.js';
import { writeWorkbook } from './formatters/xlsx.js';
import {
  DAILY_REPORT_LABELS,
  fetchAdditionalActivities,
  flattenDailyReports,
  type DailyReportKind,
} from './additional-activities.js';
import { collectMetadata, toManifestSection, type Metadata } from './metadata.js';

export type IncludeKind = 'photos' | 'notes' | 'messages' | 'viewer' | 'dailyReports';

export interface RunOptions {
  session: Session;
  /** Where the output lands. Callers pick ZipSink / SingleFileSink / FolderSink. */
  sink: Sink;
  progress: ProgressChannel;
  sync?: Sync;
  logger?: RingLogger;
  extensionVersion?: string;
  clock?: () => number;
  timeZone?: string;
  /** Used only in tests to avoid the async delay. */
  fetchImpl?: typeof fetch;
  /**
   * Which kinds to include in the export. Default = all four. When a kind is
   * unchecked we skip its API calls entirely (F-B).
   */
  include?: Partial<Record<IncludeKind, boolean>>;
  /** Output format for notes / messages / photo manifest (F-A). Default 'csv'. */
  format?: OutputFormat;
  /** Optional date range (F-D). Empty strings = unbounded. */
  dateRange?: { from?: string | null; to?: string | null };
  /**
   * Object_ids to skip. Applied on the hot path in addition to resumeFrom
   * (F-F). Callers pass sets they built from local-history seenAsSets().
   */
  skipAlreadyExported?: {
    photos?: Set<string>;
    notes?: Set<string>;
    messages?: Set<string>;
  };
  /** Debug mode capture (F-G). When set, request bodies land under debug/. */
  debug?: DebugCaptureInterface;
  /**
   * Photos that permanently failed in a prior run (see H6). Skipped on the
   * hot path so we don't burn the retry budget re-trying photos BW no
   * longer resolves for us. The takeout page's "Retry failed" affordance
   * clears the underlying LocalHistory set, so passing an empty Set here
   * is equivalent to "retry them all".
   */
  permaFailedPhotos?: Set<string>;
  /**
   * Resume checkpoint from a previous run. Items whose object_id is in
   * `seenObjectIds` are skipped (not downloaded, not re-added).
   * runId is preserved so the checkpoint row stays coherent across restarts.
   */
  resumeFrom?: Checkpoint;
  /**
   * Called by the BwClient when the server 403s the current CSRF token; the
   * caller (takeout page) should ask the SW to re-poll the content script
   * for a fresh token. Returning undefined lets the 403 propagate.
   */
  refreshCsrf?: () => Promise<string | undefined>;
  /**
   * Cooperative cancel. The takeout page's Stop button aborts this signal;
   * the run checks between items and after each page/download and throws a
   * BwCancelledError to unwind cleanly (the checkpoint is flushed in the
   * `finally`, so Resume picks up where Stop left off).
   */
  signal?: AbortSignal;
}

export class BwCancelledError extends Error {
  readonly name = 'BwCancelledError';
  constructor() {
    super('Export stopped');
  }
}

export interface RunResult extends Manifest {
  /** Object IDs successfully processed this run, per kind. */
  processedIds: {
    photos: string[];
    notes: string[];
    messages: string[];
  };
  /** Photos that permanently failed to download this run (H6). */
  permaFailedPhotoIds: string[];
  includedKinds: IncludeKind[];
  format: OutputFormat;
}

/**
 * Shared state for the per-kind pipelines. Populated once at run() entry
 * and mutated by processNotes / processMessages / processPhotoIndex /
 * downloadPhotos. Everything downstream (formatter emit, manifest, viewer)
 * reads from the same object.
 */
interface RunCtx {
  // Inputs (never mutated after construction)
  runId: string;
  startedAt: number;
  session: Session;
  client: BwClient;
  sync: Sync;
  logger: RingLogger;
  progress: ProgressChannel;
  cp: CheckpointWriter;
  sink: Sink;
  checkCancel: () => void;
  timeZone: string;
  dateRange?: { from?: string | null; to?: string | null };
  activitiesDateOpts: { startDate?: string; endDate?: string };
  resumeSkip: { photos: Set<string>; notes: Set<string>; messages: Set<string> };
  skipAlreadyExported?: {
    photos?: Set<string>;
    notes?: Set<string>;
    messages?: Set<string>;
  };
  perma: Set<string>;

  // Outputs (mutated by pipelines, read by emit block)
  counts: { notes: number; messages: number; photos: number; dailyReports?: number };
  processedIds: { notes: string[]; messages: string[]; photos: string[] };
  notesAgg: BwActivity[];
  notesRows: NoteRow[];
  messagesAgg: BwMessage[];
  messagesRows: MessageRow[];
  /**
   * Raw photo activities as they came off the wire — kept alongside
   * photoEntries so downstream metadata derivation (rooms, staff) can
   * pull .room and .actor even when the user turned off notes.
   */
  photoActivitiesRaw: BwActivity[];
  photoEntries: PhotoEntry[];
  photoRows: PhotoRow[];
  photoMeta: Array<{
    file: string;
    object_id: string;
    event_date: string;
    note: string | null;
    actor_first_name?: string | null;
    actor_last_name?: string | null;
  }>;
}

async function processNotes(ctx: RunCtx): Promise<void> {
  ctx.progress.post({ step: 'notes', message: 'Fetching teacher notes…' });
  ctx.logger.info(`run ${ctx.runId}: fetching notes for ${ctx.session.studentIds.length} student(s)`);
  const known = await ctx.sync.fetchKnown('note');
  for (const sid of ctx.session.studentIds) {
    ctx.logger.info(`run ${ctx.runId}: notes → GET /activities?action_type=ac_note student=${sid.slice(0, 8)}…`);
    let seenForStudent = 0;
    const eventsToRecord: ExportEvent[] = [];
    // L3: stream page-by-page so raw activities aren't held twice in memory.
    for await (const a of iterateActivities(ctx.client, sid, {
      actionType: 'ac_note',
      ...ctx.activitiesDateOpts,
    })) {
      seenForStudent++;
      ctx.checkCancel();
      // Notes are always re-emitted on Resume: they're buffered into
      // notesRows and only written to disk at the end of the run, so
      // resumeSkip'ing them would drop them from a resumed CSV even
      // though re-fetching + re-emitting is cheap.
      if (known.has(a.object_id)) continue;
      if (ctx.skipAlreadyExported?.notes?.has(a.object_id)) continue;
      ctx.notesAgg.push(a);
      ctx.notesRows.push(activityToNoteRow(a, sid));
      ctx.counts.notes++;
      ctx.processedIds.notes.push(a.object_id);
      await ctx.cp.mark('notes', a.object_id);
      eventsToRecord.push({
        kind: 'note',
        studentId: sid,
        brightwheelObjectId: a.object_id,
        eventDate: a.event_date,
      });
      ctx.progress.post({
        step: 'notes',
        current: ctx.counts.notes,
        message: `notes ${ctx.counts.notes} for student ${sid.slice(0, 8)}…`,
      });
    }
    ctx.logger.info(`run ${ctx.runId}: notes for ${sid.slice(0, 8)}… → ${seenForStudent} seen, ${eventsToRecord.length} kept`);
    if (eventsToRecord.length > 0) await ctx.sync.recordExported(eventsToRecord);
  }
}

async function processMessages(ctx: RunCtx): Promise<void> {
  ctx.progress.post({ step: 'messages', message: 'Fetching messages…' });
  const threads = ctx.session.threadIds ?? [];
  ctx.logger.info(`run ${ctx.runId}: fetching messages across ${threads.length} thread(s)`);
  const known = await ctx.sync.fetchKnown('message');
  for (const tid of threads) {
    ctx.logger.info(`run ${ctx.runId}: messages → GET /message_threads/${tid.slice(0, 8)}…/messages`);
    const { messages, reportedCount } = await fetchThreadMessages(
      ctx.client,
      ctx.session.guardianId,
      tid,
      { logger: ctx.logger },
    );
    ctx.logger.info(`run ${ctx.runId}: messages thread ${tid.slice(0, 8)}… → ${messages.length} of ${reportedCount ?? '?'} returned`);
    const events: ExportEvent[] = [];
    for (const m of messages) {
      ctx.checkCancel();
      // Messages are always re-emitted on Resume for the same reason as
      // notes (see processNotes) — they're buffered and only written at
      // end-of-run in one shot.
      if (known.has(m.object_id)) continue;
      if (ctx.skipAlreadyExported?.messages?.has(m.object_id)) continue;
      // BW's /messages endpoint doesn't support server-side date filtering,
      // so filter client-side on `created_at` (F-D).
      if (ctx.dateRange?.from && !afterOrEqual(m.created_at, ctx.dateRange.from)) continue;
      if (ctx.dateRange?.to && !beforeOrEqual(m.created_at, ctx.dateRange.to)) continue;
      ctx.counts.messages++;
      ctx.processedIds.messages.push(m.object_id);
      ctx.messagesAgg.push(m);
      ctx.messagesRows.push(messageToRow(m));
      await ctx.cp.mark('messages', m.object_id);
      events.push({
        kind: 'message',
        brightwheelObjectId: m.object_id,
        eventDate: m.created_at,
      });
    }
    if (events.length > 0) await ctx.sync.recordExported(events);
    ctx.progress.post({
      step: 'messages',
      current: ctx.counts.messages,
      total: reportedCount,
      message: `messages ${ctx.counts.messages}/${reportedCount ?? '?'} in thread ${tid.slice(0, 8)}…`,
    });
  }
}

async function processPhotoIndex(ctx: RunCtx): Promise<void> {
  ctx.progress.post({ step: 'photos', message: 'Fetching photo index…' });
  ctx.logger.info(`run ${ctx.runId}: fetching photo index for ${ctx.session.studentIds.length} student(s)`);
  const known = await ctx.sync.fetchKnown('photo');
  for (const sid of ctx.session.studentIds) {
    ctx.logger.info(`run ${ctx.runId}: photos → GET /activities?action_type=ac_photo student=${sid.slice(0, 8)}…`);
    for await (const a of iterateActivities(ctx.client, sid, {
      actionType: 'ac_photo',
      ...ctx.activitiesDateOpts,
    })) {
      ctx.checkCancel();
      if (known.has(a.object_id) || ctx.resumeSkip.photos.has(a.object_id)) continue;
      if (ctx.skipAlreadyExported?.photos?.has(a.object_id)) continue;
      // Perma-failed photos got their retry chance already; skip them.
      if (ctx.perma.has(a.object_id)) continue;
      const entry = planPhotoEntry(a);
      if (!entry) continue;
      entry.studentId = sid;
      ctx.photoEntries.push(entry);
      ctx.photoActivitiesRaw.push(a);
      ctx.photoMeta.push({
        file: entry.filename,
        object_id: entry.objectId,
        event_date: entry.eventDate,
        note: entry.note ?? null,
        actor_first_name: a.actor?.first_name ?? null,
        actor_last_name: a.actor?.last_name ?? null,
      });
      ctx.photoRows.push({
        filename: `photos/${entry.filename}`,
        date: dateOnly(entry.eventDate),
        time: formatTime(entry.eventDate),
        studentId: sid,
        studentName: '',
        author: actorName(a.actor),
        attachedNote: entry.note ?? '',
      });
    }
  }
  ctx.logger.info(`run ${ctx.runId}: photo index complete — ${ctx.photoEntries.length} photo(s) to download`);
}

async function downloadPhotos(ctx: RunCtx): Promise<void> {
  const refetchUrl = makeRefetchUrl(ctx.client, ctx.session.studentIds);
  const total = ctx.photoEntries.length;
  ctx.progress.post({
    step: 'photos',
    current: 0,
    total,
    message: `downloading ${total} photos…`,
  });
  const events: ExportEvent[] = [];
  for await (const result of downloadPhotoStream(ctx.client, ctx.photoEntries, {
    refetchUrl,
    continueOnError: true,
  })) {
    ctx.checkCancel();
    // A genuine 401 anywhere in the photo stream flips the client's sticky
    // sessionExpired flag. Abort the whole run rather than quietly marking the
    // remaining photos as "permanently failed" — that path not only ships a
    // truncated archive as if it were complete, it *persists* those IDs so
    // every future run skips them too. This mirrors the session-expiry
    // propagation already done for metadata/daily-report probes (ab24153);
    // the photo download is the longest-running phase and the one most likely
    // to outlive a session, so it needs the same guard. Individual photo
    // failures (403 signed-URL expiry, 404, network) are still tolerated below.
    if (ctx.client.sessionExpired) {
      throw new BwAuthError(401, 'session expired during photo download');
    }
    if (result.error) {
      ctx.logger.warn(`photo ${result.entry.objectId} failed: ${result.error.message}`);
      await ctx.cp.markFailed(result.entry.objectId);
      continue;
    }
    const stamped = stampExifDate(result.bytes!, result.entry.eventDate, ctx.timeZone);
    await ctx.sink.push({
      name: `photos/${result.entry.filename}`,
      lastModified: safeDate(result.entry.eventDate) ?? new Date(ctx.startedAt),
      bytes: stamped,
    });
    ctx.counts.photos++;
    ctx.processedIds.photos.push(result.entry.objectId);
    await ctx.cp.mark('photos', result.entry.objectId);
    events.push({
      kind: 'photo',
      studentId: result.entry.studentId,
      brightwheelObjectId: result.entry.objectId,
      eventDate: result.entry.eventDate,
    });
    if (ctx.counts.photos % 5 === 0 || ctx.counts.photos === total) {
      ctx.progress.post({
        step: 'photos',
        current: ctx.counts.photos,
        total,
        currentFile: result.entry.filename,
        message: `photo ${ctx.counts.photos}/${total}`,
      });
    }
    if (ctx.counts.photos === 1 || ctx.counts.photos % 25 === 0 || ctx.counts.photos === total) {
      ctx.logger.info(`run ${ctx.runId}: photo ${ctx.counts.photos}/${total} — ${result.entry.filename}`);
    }
  }
  if (events.length > 0) await ctx.sync.recordExported(events);
}

function newRunId(now: number): string {
  return `run_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultInclude(include?: Partial<Record<IncludeKind, boolean>>): Record<IncludeKind, boolean> {
  return {
    photos: include?.photos ?? true,
    notes: include?.notes ?? true,
    messages: include?.messages ?? true,
    viewer: include?.viewer ?? true,
    // Daily reports are opt-in by default — the volume is unpredictable and
    // most parents already get what they want from photos+notes+messages.
    // Toggled by the takeout page's "Include daily reports" checkbox.
    dailyReports: include?.dailyReports ?? false,
  };
}

function dateOnly(iso: string): string {
  return (iso || '').slice(0, 10);
}
function formatTime(iso: string): string {
  return (iso || '').slice(11, 16);
}

function actorName(a: { first_name?: string | null; last_name?: string | null } | undefined | null): string {
  if (!a) return '';
  return [a.first_name ?? '', a.last_name ?? ''].filter(Boolean).join(' ').trim();
}

/** True when `iso` is >= from (or from is falsy). Both interpreted as UTC. */
function afterOrEqual(iso: string | undefined, from: string | null | undefined): boolean {
  if (!from) return true;
  if (!iso) return false;
  return iso.slice(0, from.length) >= from.slice(0, 10) || iso >= from;
}
function beforeOrEqual(iso: string | undefined, to: string | null | undefined): boolean {
  if (!to) return true;
  if (!iso) return false;
  // Compare on date-only granularity: "2026-07-15" matches "<=2026-07-15".
  return (iso.slice(0, 10) <= to.slice(0, 10));
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const {
    session,
    sink,
    progress,
    sync = new NullSync(),
    logger = defaultLog,
    extensionVersion = '0.0.0',
    clock = Date.now,
    timeZone = localTimeZone(),
    fetchImpl,
    resumeFrom,
    refreshCsrf,
    debug,
    format = 'csv',
    dateRange,
    skipAlreadyExported,
    permaFailedPhotos,
  } = opts;
  const include = defaultInclude(opts.include);

  const client = new BwClient(
    {
      clientUuid: session.clientUuid,
      userUuid: session.userUuid,
      csrfToken: session.csrfToken,
      studentId: session.studentIds[0],
      clientVersion: session.clientVersion,
      userAgent: session.userAgent,
    },
    {
      logger,
      fetchImpl,
      refreshCsrf,
      ...(debug?.enabled
        ? {
            debugCapture: (e) => debug.record(e),
            debugNextSeq: () => (debug as unknown as { nextSeq(): number }).nextSeq(),
          }
        : {}),
    },
  );

  const runId = resumeFrom?.runId ?? newRunId(clock());
  const startedAt = resumeFrom?.startedAt ?? clock();
  // Per-kind resume-skip sets (L2). Cross-kind collision was theoretical
  // before, but keeping them separate future-proofs the resume path if a
  // future BW API version starts sharing an id namespace between kinds.
  const resumeSkip = {
    photos: new Set<string>(resumeFrom?.seenObjectIds?.photos ?? []),
    notes: new Set<string>(resumeFrom?.seenObjectIds?.notes ?? []),
    messages: new Set<string>(resumeFrom?.seenObjectIds?.messages ?? []),
  };
  // Perma-failed skip set is the UNION of:
  //   - what the caller passed in (LocalHistory across sessions)
  //   - what the current checkpoint records (Resume within a session)
  // Either can be empty.
  const perma = new Set<string>(permaFailedPhotos ?? []);
  for (const id of resumeFrom?.permaFailedIds ?? []) perma.add(id);
  const signal = opts.signal;
  const checkCancel = (): void => {
    if (signal?.aborted) throw new BwCancelledError();
  };
  if (resumeFrom) {
    const total = resumeSkip.photos.size + resumeSkip.notes.size + resumeSkip.messages.size;
    logger.info(`run ${runId}: resuming with ${total} previously-processed item(s)`);
  } else {
    logger.info(
      `run ${runId}: guardian=${session.guardianId} students=${session.studentIds.join(',')} format=${format} include=${Object.entries(include).filter(([, v]) => v).map(([k]) => k).join(',')} sink=${sink.kind}${dateRange?.from || dateRange?.to ? ` range=${dateRange?.from ?? '*'}..${dateRange?.to ?? '*'}` : ''}`,
    );
  }

  const cp = new CheckpointWriter(
    {
      runId,
      guardianId: session.guardianId,
      studentIds: session.studentIds.slice(),
      seenObjectIds: resumeFrom?.seenObjectIds ?? emptySeen(),
      permaFailedIds: Array.from(perma),
      startedAt,
      updatedAt: clock(),
      // Persist the run's scope so Resume replays with the same date range,
      // include-set, and format — the DOM inputs on a fresh page load are
      // empty and wouldn't otherwise round-trip.
      settings: {
        include,
        format,
        dateRange: dateRange ?? null,
        debug: opts.debug !== undefined,
        skipAlreadyExported: !!skipAlreadyExported,
      },
    },
    PACING.checkpointEvery,
  );
  // Settings ride along with the checkpoint but we don't flush yet — the
  // first cp.mark() batches a write. A crash before any items are processed
  // has nothing to resume anyway.

  const counts: { notes: number; messages: number; photos: number; dailyReports?: number } = {
    notes: 0,
    messages: 0,
    photos: 0,
  };
  const processedIds = {
    notes: [] as string[],
    messages: [] as string[],
    photos: [] as string[],
  };
  let completedOk = false;

  const activitiesDateOpts = {
    ...(dateRange?.from ? { startDate: toStartOfDayIso(dateRange.from) } : {}),
    ...(dateRange?.to ? { endDate: toEndOfDayIso(dateRange.to) } : {}),
  };

  // Helpers used by every kind — thin so run() reads top-to-bottom.
  const notesAgg: BwActivity[] = [];
  const notesRows: NoteRow[] = [];
  const messagesAgg: BwMessage[] = [];
  const messagesRows: MessageRow[] = [];
  const photoActivitiesRaw: BwActivity[] = [];
  const photoEntries: PhotoEntry[] = [];
  const photoRows: PhotoRow[] = [];
  const photoMeta: Array<{
    file: string;
    object_id: string;
    event_date: string;
    note: string | null;
    actor_first_name?: string | null;
    actor_last_name?: string | null;
  }> = [];

  const ctx: RunCtx = {
    runId, startedAt, session, client, sync, logger, progress, cp, sink,
    checkCancel, timeZone, dateRange, activitiesDateOpts, resumeSkip,
    skipAlreadyExported, perma,
    counts, processedIds,
    notesAgg, notesRows, messagesAgg, messagesRows,
    photoActivitiesRaw, photoEntries, photoRows, photoMeta,
  };

  // Populated after notes+photos+messages arrive so metadata derivation has
  // material to work from. See collectMetadata for why we do this instead
  // of hitting the endpoints upfront.
  let metadata: Metadata | undefined;
  let dailyReportsByKind: Partial<Record<DailyReportKind, BwActivity[]>> = {};
  let dailyReportsCountsByKind: Record<string, number> = {};
  let dailyReportsEmptyKinds: string[] = [];

  try {
    if (include.notes) await processNotes(ctx);
    else logger.info(`run ${runId}: skipping notes (unchecked)`);

    if (include.messages) await processMessages(ctx);
    else logger.info(`run ${runId}: skipping messages (unchecked)`);

    if (include.photos) {
      await processPhotoIndex(ctx);
      await downloadPhotos(ctx);
    } else {
      logger.info(`run ${runId}: skipping photos (unchecked)`);
    }

    // ---- Additional activity kinds (opt-in) ---------------------------
    if (include.dailyReports) {
      progress.post({ step: 'photos', message: 'Fetching daily reports…' });
      logger.info(`run ${runId}: fetching additional activity kinds (daily reports)`);
      try {
        const result = await fetchAdditionalActivities(client, session.studentIds, {
          logger,
          ...(dateRange?.from ? { startDate: toStartOfDayIso(dateRange.from) } : {}),
          ...(dateRange?.to ? { endDate: toEndOfDayIso(dateRange.to) } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        dailyReportsByKind = result.byKind;
        for (const [kind, list] of Object.entries(result.byKind)) {
          dailyReportsCountsByKind[kind] = list.length;
        }
        for (const { kind } of result.emptyProbes) {
          if (!dailyReportsEmptyKinds.includes(kind)) dailyReportsEmptyKinds.push(kind);
        }
        counts.dailyReports = result.totalCount;
        logger.info(`run ${runId}: daily reports total=${result.totalCount} empty_kinds=${dailyReportsEmptyKinds.join(',')}`);
      } catch (err) {
        if ((err as Error).name === 'BwAuthError') throw err;
        // Any other failure: log and continue — daily reports are opt-in
        // extra data, they must never block the export.
        logger.warn(`run ${runId}: daily-reports fetch failed: ${(err as Error).message}`);
      }
    }

    // ---- Metadata (school / student profile / staff) ------------------
    // Best-effort — we skip probes when there's literally nothing derivable
    // (all-empty include set on a resume-only fetch), otherwise probe.
    try {
      progress.post({ step: 'viewer', message: 'Collecting metadata…' });
      metadata = await collectMetadata(
        client,
        {
          guardianId: session.guardianId,
          studentIds: session.studentIds,
          ...(session as unknown as { studentNames?: Record<string, string> }).studentNames
            ? { studentNames: (session as unknown as { studentNames: Record<string, string> }).studentNames }
            : {},
        },
        { notes: notesAgg, photos: photoActivitiesRaw, messages: messagesAgg },
        { logger },
      );
      logger.info(
        `run ${runId}: metadata — schools=${Object.keys(metadata.schools).length} student_profiles=${Object.keys(metadata.studentProfiles).length} staff=${Object.keys(metadata.staff.members).length}`,
      );
    } catch (err) {
      if ((err as Error).name === 'BwAuthError') throw err;
      logger.warn(`run ${runId}: metadata collection failed: ${(err as Error).message}`);
    }

    // ---- Emit daily-reports files -------------------------------------
    if (include.dailyReports && counts.dailyReports && counts.dailyReports > 0) {
      const studentNameLookup = (sid: string): string =>
        (metadata?.studentProfiles?.[sid]?.displayName ?? '') ||
        (session as unknown as { studentNames?: Record<string, string> }).studentNames?.[sid] ||
        '';
      const filledByKind: Record<DailyReportKind, BwActivity[]> = {
        ac_health_check: dailyReportsByKind.ac_health_check ?? [],
        ac_food: dailyReportsByKind.ac_food ?? [],
        ac_nap: dailyReportsByKind.ac_nap ?? [],
        ac_bathroom: dailyReportsByKind.ac_bathroom ?? [],
        ac_potty: dailyReportsByKind.ac_potty ?? [],
        ac_incident: dailyReportsByKind.ac_incident ?? [],
        ac_medication: dailyReportsByKind.ac_medication ?? [],
        ac_video: dailyReportsByKind.ac_video ?? [],
      };
      const rows = flattenDailyReports(filledByKind, studentNameLookup);
      // One combined file (matches the format the user picked). Kept as a
      // single file rather than one-per-kind so parents don't end up with
      // 7 empty CSVs when their school only populates a few kinds.
      if (format === 'json') {
        await sink.push({
          name: 'daily-reports.json',
          lastModified: new Date(startedAt),
          bytes: new TextEncoder().encode(
            JSON.stringify(
              {
                source: 'brightwheel',
                kind: 'daily-reports',
                counts_by_kind: dailyReportsCountsByKind,
                empty_kinds: dailyReportsEmptyKinds,
                labels: DAILY_REPORT_LABELS,
                rows,
              },
              null,
              2,
            ),
          ),
        });
      } else {
        // Default to CSV even in xlsx mode — xlsx bundles the primary kinds
        // (notes/messages/photos) into a single workbook, but daily reports
        // are opt-in extras and mixing them into the same workbook made the
        // sheet-selection story confusing. Sidecar CSV is simpler.
        await sink.push({
          name: 'daily-reports.csv',
          lastModified: new Date(startedAt),
          bytes: writeDailyReportsCsv(rows),
        });
      }
    }

    // ---- Emit formatted output ----------------------------------------
    const formatterManifest: FormatterManifest = {
      guardianId: session.guardianId,
      studentIds: session.studentIds,
      exportedAt: new Date(startedAt).toISOString(),
      extensionVersion,
      counts,
      dateRange: dateRange ?? undefined,
      includedKinds: (Object.keys(include) as IncludeKind[]).filter((k) => include[k]),
    };

    if (format === 'xlsx') {
      // Single workbook with only the sheets the caller selected.
      const bytes = await writeWorkbook({
        ...(include.notes ? { notes: notesRows } : {}),
        ...(include.messages ? { messages: messagesRows } : {}),
        ...(include.photos ? { photos: photoRows } : {}),
        manifest: formatterManifest,
        logger,
      });
      const filename = pickSingleFileName(sink, formatterManifest, 'xlsx', include);
      await sink.push({
        name: filename,
        lastModified: new Date(startedAt),
        bytes,
      });
    } else if (format === 'csv') {
      if (include.notes) {
        await sink.push({
          name: 'notes.csv',
          lastModified: new Date(startedAt),
          bytes: writeNotesCsv(notesRows),
        });
      }
      if (include.messages) {
        await sink.push({
          name: 'messages.csv',
          lastModified: new Date(startedAt),
          bytes: writeMessagesCsv(messagesRows),
        });
      }
      if (include.photos) {
        await sink.push({
          name: 'photos.csv',
          lastModified: new Date(startedAt),
          bytes: writePhotoManifestCsv(photoRows),
        });
      }
    } else {
      // JSON — historical envelope shape, keeps the standalone viewer working.
      if (include.notes) {
        await sink.push({
          name: 'notes.json',
          lastModified: new Date(startedAt),
          bytes: writeNotesJson({
            source: 'brightwheel',
            kind: 'notes',
            guardian_id: session.guardianId,
            student_ids: session.studentIds,
            fetched_at: new Date(startedAt).toISOString(),
            count: notesAgg.length,
            notes: notesAgg,
          }),
        });
      }
      if (include.messages) {
        await sink.push({
          name: 'messages.json',
          lastModified: new Date(startedAt),
          bytes: writeMessagesJson({
            source: 'brightwheel',
            kind: 'messages',
            guardian_id: session.guardianId,
            thread_ids: session.threadIds ?? [],
            fetched_at: new Date(startedAt).toISOString(),
            count: messagesAgg.length,
            messages: messagesAgg,
          }),
        });
      }
      if (include.photos) {
        await sink.push({
          name: 'photos/manifest.json',
          lastModified: new Date(startedAt),
          bytes: writePhotoManifestJson({ count: photoMeta.length, photos: photoMeta }),
        });
      }
    }

    // ---- Viewer + manifest --------------------------------------------
    if (include.viewer) {
      progress.post({ step: 'viewer', message: 'Emitting viewer + manifest…' });
      await sink.push({
        name: 'viewer/index.html',
        lastModified: new Date(startedAt),
        bytes: renderViewerHtml(),
      });
      // Sidecar `viewer/data.js` — assigns to window.__DATA__ so the viewer
      // works from any format (CSV/XLSX/JSON) and from file:// double-click.
      const manifestSection = metadata ? toManifestSection(metadata) : undefined;
      const viewerDataJs = renderViewerDataJs({
        notes: notesAgg,
        messages: messagesAgg,
        photos: photoMeta,
        manifest: {
          guardianId: session.guardianId,
          studentIds: session.studentIds,
          fetchedAt: new Date(startedAt).toISOString(),
          counts,
          extensionVersion,
          ...(manifestSection ? {
            schools: manifestSection.schools,
            student_profiles: manifestSection.student_profiles,
            staff: manifestSection.staff,
          } : {}),
        },
      });
      await sink.push({
        name: 'viewer/data.js',
        lastModified: new Date(startedAt),
        bytes: new TextEncoder().encode(viewerDataJs),
      });
    }
    const manifestSectionForFile = metadata ? toManifestSection(metadata) : undefined;
    const manifest: Manifest = {
      extensionVersion,
      guardianId: session.guardianId,
      studentIds: session.studentIds,
      runId,
      fetchedAt: new Date(startedAt).toISOString(),
      counts,
      ...(dateRange?.from || dateRange?.to
        ? { dateRange: { start: dateRange?.from ?? undefined, end: dateRange?.to ?? undefined } }
        : {}),
      ...(manifestSectionForFile
        ? {
            school: manifestSectionForFile.schools,
            student_profiles: manifestSectionForFile.student_profiles,
            staff: manifestSectionForFile.staff,
          }
        : {}),
      ...(include.dailyReports
        ? {
            daily_reports: {
              counts_by_kind: dailyReportsCountsByKind,
              empty_kinds: dailyReportsEmptyKinds,
            },
          }
        : {}),
    };
    // Manifest + log go alongside the primary format when we're in ZipSink /
    // FolderSink. In SingleFileSink mode there's just the one file — no
    // room for a manifest — so we skip it.
    if (sink.kind !== 'single-file') {
      await sink.push({
        name: 'manifest.json',
        lastModified: new Date(startedAt),
        bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      });
      // Debug mode captures + higher-fidelity log dump (F-G).
      if (debug?.enabled) {
        await debug.writeInto((name, bytes) =>
          sink.push({ name, bytes, lastModified: new Date(startedAt) }),
        );
        await sink.push({
          name: 'debug/takeout.log',
          lastModified: new Date(clock()),
          bytes: new TextEncoder().encode(logger.toText()),
        });
      } else {
        await sink.push({
          name: 'takeout.log',
          lastModified: new Date(clock()),
          bytes: new TextEncoder().encode(logger.toText()),
        });
      }
    }

    // ---- Finalize ------------------------------------------------------
    progress.post({ step: 'finalize', message: 'Finalizing archive…' });
    await sink.close();
    completedOk = true;
    await clearCheckpoint().catch((err) => {
      logger.warn(`clearCheckpoint after success failed: ${(err as Error).message}`);
    });
    progress.post({ step: 'done', finishedAt: clock(), message: 'Archive complete.' });
    logger.info(`run ${runId} done in ${clock() - startedAt}ms`);
    return {
      ...manifest,
      processedIds,
      permaFailedPhotoIds: cp.snapshot().permaFailedIds ?? [],
      includedKinds: formatterManifest.includedKinds as IncludeKind[],
      format,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const cancelled = err instanceof BwCancelledError;
    if (cancelled) {
      logger.info(`run ${runId} stopped by user — progress saved for Resume`);
    } else {
      logger.error(`run ${runId} failed: ${message}`);
    }
    await sink.fail(err).catch(() => {});
    progress.post({
      step: cancelled ? 'stopped' : 'error',
      message: cancelled ? 'Stopped — progress saved. Click Resume to continue.' : undefined,
      errorMessage: cancelled ? undefined : message,
    });
    throw err;
  } finally {
    if (!completedOk) {
      try {
        await cp.flush();
      } catch (err) {
        logger.warn(`checkpoint flush in finally failed: ${(err as Error).message}`);
      }
    }
  }
}

// ---- Small helpers --------------------------------------------------------

function activityToNoteRow(a: BwActivity, studentId: string): NoteRow {
  // L6: real photos may be .png / .heic / .webp; use planPhotoEntry to
  // derive the same filename downstream photo writers will use, so the
  // Notes CSV's `mediaFiles` column doesn't lie about the extension.
  let mediaFile: string | null = null;
  if (a.media) {
    const entry = planPhotoEntry(a);
    if (entry) {
      mediaFile = `photos/${entry.filename}`;
    } else {
      // Only reached if a.media is present but has no usable URL — fall
      // back to a .jpg placeholder for compatibility with the pre-L6
      // filename shape.
      const date = a.event_date?.slice(0, 10) ?? 'undated';
      mediaFile = `photos/${date}_${a.object_id}.jpg`;
    }
  }
  const media = mediaFile ? [mediaFile] : [];
  return {
    date: dateOnly(a.event_date),
    time: formatTime(a.event_date),
    studentId,
    studentName: '',
    author: actorName(a.actor),
    body: a.note ?? '',
    mediaCount: media.length,
    mediaFiles: media,
  };
}

function messageToRow(m: BwMessage): MessageRow {
  return {
    date: dateOnly(m.created_at),
    time: formatTime(m.created_at),
    sender: actorName(m.sender),
    body: m.body ?? '',
    mediaFiles: [],
  };
}

function pickSingleFileName(
  sink: Sink,
  m: FormatterManifest,
  ext: 'xlsx' | 'csv' | 'json',
  _include: Record<IncludeKind, boolean>,
): string {
  if (sink.kind !== 'single-file') {
    // Inside a ZIP or Folder, use a generic name.
    return ext === 'xlsx'
      ? `brightwheel-takeout-${m.exportedAt.slice(0, 10)}.xlsx`
      : `brightwheel-takeout.${ext}`;
  }
  const date = m.exportedAt.slice(0, 10);
  return `brightwheel-takeout-${date}.${ext}`;
}

function toStartOfDayIso(dateStr: string): string {
  // dateStr is "YYYY-MM-DD" (or a leading substring of an ISO timestamp).
  const day = dateStr.slice(0, 10);
  return `${day}T00:00:00.000Z`;
}
function toEndOfDayIso(dateStr: string): string {
  const day = dateStr.slice(0, 10);
  return `${day}T23:59:59.999Z`;
}

function safeDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
