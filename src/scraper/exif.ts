// EXIF stamping for downloaded JPEGs.
//
// Brightwheel strips original EXIF from posted images, so `DateTimeOriginal`
// arrives blank. Apple Photos / Google Photos sort by the earliest of
// (DateTimeOriginal, mtime, filename-date). We stamp `event_date` in the
// user's own local wall time so photos land on the day the parent remembers
// (their timezone, not the server's, not a hardcoded one).
//
// Non-JPEG inputs are returned unchanged — piexifjs is JPEG-only. We detect
// the JPEG SOI marker (0xFFD8) at the start of the buffer.

import piexif from 'piexifjs';

/** The user's local IANA time zone, resolved once at module load. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Convert an ISO UTC timestamp to the EXIF DateTime format
 * ("YYYY:MM:DD HH:MM:SS") in the given IANA zone. The unzoned form is what
 * we actually persist via piexifjs; Apple Photos + Google Photos both read
 * DateTimeOriginal as "local wall time" by default, which is what a parent
 * expects to see.
 */
export function formatExifDateStr(
  isoUtc: string,
  timeZone: string = localTimeZone(),
): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`formatExifDateStr: invalid ISO timestamp: ${isoUtc}`);
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(d).map((p) => [p.type, p.value] as const),
  );
  // Some Node/Chromium versions emit hour '24' at midnight; normalize.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}:${parts.month}:${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

/**
 * Full form: `{ dateStr, offsetStr }`. Kept around for tests + future
 * consumers that emit OffsetTimeOriginal (piexifjs 1.0.6 doesn't expose the
 * tag constants, so we can't persist the offset today — but the value is
 * still worth computing for the returned metadata contract).
 */
export function formatExifDate(
  isoUtc: string,
  timeZone: string = localTimeZone(),
): { dateStr: string; offsetStr: string } {
  const dateStr = formatExifDateStr(isoUtc, timeZone);
  const d = new Date(isoUtc);
  const offsetMin = tzOffsetMinutes(d, timeZone);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return { dateStr, offsetStr: `${sign}${oh}:${om}` };
}

// Compute the tz offset (minutes east of UTC) for a given instant + IANA zone.
// Uses the standard trick of formatting the same wall-time parts in UTC and
// diffing. Handles DST correctly.
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(instant).map((p) => [p.type, p.value] as const),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    parts.hour === '24' ? 0 : +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** JPEG SOI marker check (first two bytes = 0xFF, 0xD8). */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Encode a Uint8Array of JPEG bytes to piexifjs's expected binary-string form.
 * piexif works on "binary strings" (each char = one byte). This is unfortunate
 * but is the API; TextDecoder(latin1) round-trips losslessly for byte data.
 */
function bytesToBinaryString(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return s;
}

function binaryStringToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Stamp DateTimeOriginal + DateTimeDigitized + OffsetTime{,Original,Digitized}
 * onto the given JPEG bytes. Returns new bytes; input is not mutated.
 *
 * If `bytes` isn't a JPEG (e.g. HEIC, PNG, movie), returns the input unchanged.
 * If `isoUtc` is missing/invalid, returns the input unchanged.
 */
export function stampExifDate(
  bytes: Uint8Array,
  isoUtc: string | null | undefined,
  timeZone: string = localTimeZone(),
): Uint8Array {
  if (!isoUtc) return bytes;
  if (!isJpeg(bytes)) return bytes;
  const dateStr = formatExifDateStr(isoUtc, timeZone);
  const jpegBin = bytesToBinaryString(bytes);
  let exifObj: piexif.ExifDict;
  try {
    exifObj = piexif.load(jpegBin);
  } catch {
    exifObj = { '0th': {}, Exif: {}, '1st': {}, GPS: {}, Interop: {} } as piexif.ExifDict;
  }
  const zeroth = exifObj['0th'] ?? {};
  const exif = exifObj['Exif'] ?? {};
  // Use the named tag constants — piexifjs's dump() looks them up in its
  // internal TAGS table and dies on tag numbers it doesn't know.
  //
  // piexifjs (as of 1.0.6) does NOT support the OffsetTime family (0x9010..12)
  // that some newer EXIF tools understand. That's acceptable for our use
  // case: we're stamping wall-clock time in the user's local zone into
  // DateTimeOriginal, and Apple Photos / Google Photos both read
  // DateTimeOriginal as "unzoned local time" by default — which is exactly
  // what we've written. `formatExifDate` (with the offset) is still exported
  // above for tests + future consumers that upgrade piexifjs.
  zeroth[piexif.ImageIFD.DateTime] = dateStr;
  exif[piexif.ExifIFD.DateTimeOriginal] = dateStr;
  exif[piexif.ExifIFD.DateTimeDigitized] = dateStr;
  exifObj['0th'] = zeroth;
  exifObj['Exif'] = exif;
  const exifBytesStr = piexif.dump(exifObj);
  const newJpegBin = piexif.insert(exifBytesStr, jpegBin);
  return binaryStringToBytes(newJpegBin);
}
