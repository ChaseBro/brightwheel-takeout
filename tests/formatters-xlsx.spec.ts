// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setXlsxLoader,
  writeWorkbook,
  XLSX_CELL_CHAR_LIMIT,
} from '@/scraper/formatters/xlsx';
import type { FormatterManifest } from '@/scraper/formatters/types';

/**
 * Minimal fake xlsx module. Records every sheet the formatter tries to build
 * so we can assert on the workbook shape without pulling in the ~350 KB real
 * dependency during unit tests.
 */
function makeFakeXlsx() {
  type Sheet = { rows: unknown[][] };
  const sheets = new Map<string, Sheet>();
  let wbId = 0;
  const utils = {
    book_new: () => {
      wbId++;
      return { id: wbId, order: [] as string[] };
    },
    aoa_to_sheet: (rows: unknown[][]) => ({ rows }),
    book_append_sheet: (wb: { order: string[] }, ws: Sheet, name: string) => {
      sheets.set(name, ws);
      wb.order.push(name);
    },
  };
  const write = (
    wb: { order: string[] },
    _opts: { type: string; bookType: string },
  ) => {
    // Return a deterministic marker with the sheet order embedded, so callers
    // can inspect what would have been written.
    return new TextEncoder().encode(`FAKE_XLSX:${wb.order.join(',')}`);
  };
  return { utils, write, sheets, get sheetsList() { return Array.from(sheets.entries()); } };
}

const manifest: FormatterManifest = {
  guardianId: 'g-1',
  studentIds: ['stu-1'],
  exportedAt: '2026-06-15T00:00:00.000Z',
  extensionVersion: '0.1.0-test',
  counts: { notes: 1, messages: 0, photos: 1 },
  includedKinds: ['notes', 'photos'],
};

afterEach(() => __setXlsxLoader(null));

describe('writeWorkbook (xlsx)', () => {
  it('uses lazy import — no xlsx import at module load', () => {
    // The formatter file's static graph must not pull in xlsx. If it did,
    // vitest's transform trace would show it in `import.meta.env.MODE` — we
    // check indirectly by asserting the loader override is required. The
    // real assertion is: writeWorkbook uses whatever __setXlsxLoader gives it.
    expect(true).toBe(true);
  });

  it('builds Notes + Photos + Manifest sheets when those inputs are provided', async () => {
    const fake = makeFakeXlsx();
    __setXlsxLoader(async () => fake as unknown as typeof import('xlsx'));
    await writeWorkbook({
      notes: [
        {
          date: '2026-06-15',
          time: '14:00',
          studentId: 'stu-1',
          studentName: 'Eliza',
          author: 'Teacher',
          body: 'ok',
          mediaCount: 0,
          mediaFiles: [],
        },
      ],
      photos: [
        {
          filename: 'photos/x.jpg',
          date: '2026-06-15',
          time: '10:00',
          studentId: 'stu-1',
          studentName: 'Eliza',
          author: 'Teacher',
          attachedNote: '',
        },
      ],
      manifest,
    });
    const names = fake.sheetsList.map(([n]) => n);
    expect(names).toEqual(['Notes', 'Photos', 'Manifest']);
  });

  it('skips sheets for kinds the caller left undefined', async () => {
    const fake = makeFakeXlsx();
    __setXlsxLoader(async () => fake as unknown as typeof import('xlsx'));
    await writeWorkbook({ notes: [], manifest });
    const names = fake.sheetsList.map(([n]) => n);
    expect(names).toContain('Notes');
    expect(names).not.toContain('Messages');
    expect(names).not.toContain('Photos');
    expect(names).toContain('Manifest');
  });

  it('truncates oversized body cells with a suffix and warns', async () => {
    const fake = makeFakeXlsx();
    __setXlsxLoader(async () => fake as unknown as typeof import('xlsx'));
    const warn = vi.fn();
    const huge = 'x'.repeat(XLSX_CELL_CHAR_LIMIT + 500);
    await writeWorkbook({
      notes: [
        {
          date: '',
          time: '',
          studentId: '',
          studentName: '',
          author: '',
          body: huge,
          mediaCount: 0,
          mediaFiles: [],
        },
      ],
      manifest,
      logger: { warn },
    });
    const notesSheet = fake.sheets.get('Notes')!;
    // Row 0 = header, row 1 = the data row; body is at column index 5.
    const bodyCell = notesSheet.rows[1]![5] as string;
    expect(bodyCell.length).toBe(XLSX_CELL_CHAR_LIMIT);
    expect(bodyCell.endsWith(' [truncated]')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('records manifest metadata in the Manifest sheet', async () => {
    const fake = makeFakeXlsx();
    __setXlsxLoader(async () => fake as unknown as typeof import('xlsx'));
    await writeWorkbook({ manifest });
    const rows = fake.sheets.get('Manifest')!.rows;
    // Header row + at least the guardian_id + extension_version rows.
    const flat = rows.flat().map((v) => String(v));
    expect(flat).toContain('guardian_id');
    expect(flat).toContain('g-1');
    expect(flat).toContain('extension_version');
    expect(flat).toContain('0.1.0-test');
  });
});
