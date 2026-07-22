// Tiny DOM helpers shared between the popup and the takeout page.
//
// Both callers previously defined their own single-letter `$` id-lookup and
// their own promisified sendMessage. Sharing avoids drift (e.g. one caller
// forgetting to check `chrome.runtime.lastError`) and shaves a few lines.

/** Typed getElementById — narrows to the requested element type. */
export function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
