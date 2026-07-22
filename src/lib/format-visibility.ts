// Predicate: is the Format radio meaningful given the current include-set?
//
// Photos are always emitted as .jpg files regardless of the CSV/XLSX/JSON
// choice — that choice only shapes the notes / messages / photo-manifest
// output. Hiding the section when neither notes nor messages are checked
// removes a control that has no effect.

export interface IncludeSet {
  photos: boolean;
  notes: boolean;
  messages: boolean;
  viewer: boolean;
}

export function shouldShowFormatSection(include: IncludeSet): boolean {
  return include.notes || include.messages;
}
