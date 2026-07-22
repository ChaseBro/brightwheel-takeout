// Shared TypeScript types for the scraper modules.
//
// These describe the *shape* of Brightwheel API responses we care about, plus
// the internal event / progress / message types the extension pipes around.
// Fields marked optional are ones we've seen absent in at least one row of
// the real fixtures under ~/src/notes/Library/Brightwheel/.

export interface BwActor {
  object_id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  user_type?: string;
  profile_photo?: BwMedia | null;
}

export interface BwStudent {
  object_id: string;
  first_name?: string | null;
  last_name?: string | null;
  profile_photo?: BwMedia | null;
  enrollment_status?: string;
}

export interface BwMedia {
  object_id?: string;
  image_url?: string | null;
  thumbnail_url?: string | null;
  thumbnail_image_url?: string | null;
}

export interface BwActivity {
  object_id: string;
  action_type: string; // 'ac_note' | 'ac_photo' | 'ac_video' | ...
  event_date: string; // UTC ISO timestamp
  created_at?: string;
  updated_at?: string;
  actor?: BwActor;
  target?: BwStudent;
  media?: BwMedia | null;
  note?: string | null;
  source?: string;
  [k: string]: unknown;
}

export interface BwActivitiesResponse {
  count?: number;
  offset?: number;
  page?: number;
  page_size?: number;
  activities: BwActivity[];
}

export interface BwMessage {
  object_id: string;
  message_content_id?: string;
  type?: string;
  broadcast?: boolean;
  body?: string | null;
  read?: boolean;
  sender?: BwActor;
  attachments?: unknown[];
  created_at: string;
  deleted_at?: string | null;
  [k: string]: unknown;
}

export interface BwMessagesResponse {
  count?: number;
  page_size?: number;
  has_more?: boolean;
  results: Array<{ message?: BwMessage } | BwMessage>;
}

export interface BwGuardian {
  object_id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  students?: BwStudent[];
}

// -- Extension-internal types ------------------------------------------------

export interface Session {
  guardianId: string;
  clientUuid: string;
  userUuid: string;
  csrfToken: string;
  studentIds: string[];
  threadIds?: string[]; // optional; per-guardian message threads
  clientVersion?: string;
  userAgent?: string;
}

export interface PhotoEntry {
  objectId: string;
  studentId: string;
  eventDate: string; // UTC ISO from Brightwheel
  url: string;
  filename: string; // <date>_<object_id>.jpg
  note?: string | null;
}

export interface ExportEvent {
  kind: 'photo' | 'note' | 'message';
  studentId?: string;
  brightwheelObjectId: string;
  eventDate?: string;
  contentHash?: string;
}

export type ProgressStep =
  | 'discover'
  | 'notes'
  | 'messages'
  | 'photos'
  | 'viewer'
  | 'finalize'
  | 'done'
  | 'error'
  | 'stopped';

export interface ProgressUpdate {
  step: ProgressStep;
  current?: number;
  total?: number;
  currentFile?: string;
  message?: string;
  errorMessage?: string;
  finishedAt?: number;
}

export interface ProgressChannel {
  post(update: ProgressUpdate): void;
}

export interface Manifest {
  extensionVersion: string;
  guardianId: string;
  studentIds: string[];
  runId: string;
  fetchedAt: string;
  counts: {
    notes: number;
    messages: number;
    photos: number;
    /** Rows across ALL additional/daily-report action_types combined. */
    dailyReports?: number;
  };
  dateRange?: { start?: string; end?: string };
  /**
   * Optional richer-context sections filled in by the metadata orchestrator.
   * Present iff the extension successfully collected at least the derived
   * data (which requires notes or photos to have been fetched). Additive to
   * older archives — a viewer that predates this schema just ignores it.
   */
  school?: Record<string, unknown>;
  student_profiles?: Record<string, unknown>;
  staff?: Record<string, unknown>;
  daily_reports?: {
    /** action_type → row count. */
    counts_by_kind: Record<string, number>;
    /** Kinds that returned zero rows across every student. */
    empty_kinds: string[];
  };
}
