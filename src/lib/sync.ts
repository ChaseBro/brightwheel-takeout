// Cross-device dedupe hook. Only NullSync is wired at launch; RemoteSync is
// scaffolded so a later release can turn on cross-device incremental exports
// without touching the run orchestrator.

import type { ExportEvent } from '@/scraper/types.js';

export type ExportKind = 'photo' | 'note' | 'message';

export interface Sync {
  fetchKnown(kind: ExportKind): Promise<Set<string>>;
  recordExported(events: ExportEvent[]): Promise<void>;
}

export class NullSync implements Sync {
  async fetchKnown(_kind: ExportKind): Promise<Set<string>> {
    return new Set();
  }
  async recordExported(_events: ExportEvent[]): Promise<void> {
    // no-op
  }
}

export class RemoteSync implements Sync {
  constructor(_baseUrl: string, _sessionToken: string) {
    // config stashed for the v2 implementation
  }
  async fetchKnown(_kind: ExportKind): Promise<Set<string>> {
    throw new Error('RemoteSync.fetchKnown: not yet implemented — backend is a v2 follow-up');
  }
  async recordExported(_events: ExportEvent[]): Promise<void> {
    throw new Error('RemoteSync.recordExported: not yet implemented — backend is a v2 follow-up');
  }
}
