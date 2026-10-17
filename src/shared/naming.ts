// Lecture naming rules shared by the renderer (titles) and main process (lecture dates).
// All values use LOCAL calendar parts: a lecture recorded late in the evening must not
// carry tomorrow's UTC date in its name.
const pad = (value: number) => String(value).padStart(2, '0');

/** `dd.mm.yy`, e.g. 14 October 2026 → `14.10.26`. */
export function formatLectureDate(date: Date): string {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${pad(date.getFullYear() % 100)}`;
}

/** `yyyy-mm-dd` from local calendar parts (the format stored in `lectures.date`). */
export function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const normalized = (title: string) => title.trim().toLowerCase();

/**
 * `${base} ${dd.mm.yy}`; when that title is already used (trimmed, case-insensitive)
 * the first free ` (2)`, ` (3)`, … suffix is appended.
 */
export function autoLectureTitle(base: string, date: Date, existingTitles: string[]): string {
  const stem = `${base.trim()} ${formatLectureDate(date)}`.trim();
  const taken = new Set(existingTitles.map(normalized));
  if (!taken.has(normalized(stem))) return stem;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})`;
    if (!taken.has(normalized(candidate))) return candidate;
  }
}
