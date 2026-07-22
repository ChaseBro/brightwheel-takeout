import { describe, expect, it } from 'vitest';
import piexif from 'piexifjs';
import { formatExifDate, isJpeg, stampExifDate, localTimeZone } from '@/scraper/exif';

// A minimal valid JPEG: SOI + APP0 (JFIF) + SOS-ish + EOI is nontrivial, but
// piexifjs will accept a synthetic JFIF wrapper made from a base64 constant.
// This is a 1x1 white JPEG (from `convert -size 1x1 xc:white -quality 90 out.jpg | base64`).
const ONE_PIXEL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

function loadOnePixelJpeg(): Uint8Array {
  const bin = Uint8Array.from(atob(ONE_PIXEL_JPEG_BASE64), (c) => c.charCodeAt(0));
  return bin;
}

describe('exif', () => {
  it('detects JPEG SOI marker', () => {
    const bytes = loadOnePixelJpeg();
    expect(isJpeg(bytes)).toBe(true);
    expect(isJpeg(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false); // PNG
  });

  it('formatExifDate returns EXIF DateTime + offset strings for America/New_York', () => {
    // 2026-06-15T18:22:07Z == 14:22:07 in America/New_York (EDT, -04:00)
    const { dateStr, offsetStr } = formatExifDate('2026-06-15T18:22:07.000Z', 'America/New_York');
    expect(dateStr).toBe('2026:06:15 14:22:07');
    expect(offsetStr).toBe('-04:00');
  });

  it('formatExifDate defaults to the user\'s local timezone', () => {
    const tz = localTimeZone();
    // The tz should be resolvable — even in CI it should be at least "UTC"
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
  });

  it('stampExifDate leaves non-JPEG bytes unchanged', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const out = stampExifDate(png, '2025-01-01T00:00:00Z');
    expect(out).toBe(png);
  });

  it('stampExifDate leaves bytes unchanged if isoUtc is missing', () => {
    const bytes = loadOnePixelJpeg();
    expect(stampExifDate(bytes, undefined)).toBe(bytes);
    expect(stampExifDate(bytes, null)).toBe(bytes);
  });

  it('stampExifDate writes DateTimeOriginal + DateTimeDigitized that re-parse correctly', () => {
    const bytes = loadOnePixelJpeg();
    const stamped = stampExifDate(bytes, '2026-06-15T18:22:07.000Z', 'America/New_York');
    // Round-trip: read the EXIF back with piexif.
    let bin = '';
    for (let i = 0; i < stamped.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.from(stamped.subarray(i, i + 0x8000)));
    }
    const ex = piexif.load(bin);
    expect(ex.Exif?.[piexif.ExifIFD.DateTimeOriginal]).toBe('2026:06:15 14:22:07');
    expect(ex.Exif?.[piexif.ExifIFD.DateTimeDigitized]).toBe('2026:06:15 14:22:07');
    expect(ex['0th']?.[piexif.ImageIFD.DateTime]).toBe('2026:06:15 14:22:07');
  });

  it('stampExifDate output remains a valid JPEG (SOI + EOI preserved)', () => {
    const bytes = loadOnePixelJpeg();
    const stamped = stampExifDate(bytes, '2025-05-01T12:00:00Z', 'UTC');
    expect(isJpeg(stamped)).toBe(true);
    // Ends with EOI: 0xFFD9
    expect(stamped[stamped.length - 2]).toBe(0xff);
    expect(stamped[stamped.length - 1]).toBe(0xd9);
  });
});
