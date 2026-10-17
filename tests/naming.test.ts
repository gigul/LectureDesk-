import { describe, it, expect } from 'vitest';
import { autoLectureTitle, formatLectureDate, localIsoDate } from '../src/shared/naming';

describe('automatic lecture names', () => {
  it('formats local dates as dd.mm.yy with zero padding', () => {
    expect(formatLectureDate(new Date(2026, 9, 14))).toBe('14.10.26');
    expect(formatLectureDate(new Date(2026, 0, 5))).toBe('05.01.26');
    expect(formatLectureDate(new Date(2030, 11, 31, 23, 59))).toBe('31.12.30');
    expect(formatLectureDate(new Date(2105, 2, 9))).toBe('09.03.05');
  });
  it('uses the local calendar day, not the UTC one, late in the evening', () => {
    const lateEvening = new Date(2026, 9, 14, 23, 45);
    expect(formatLectureDate(lateEvening)).toBe('14.10.26');
    expect(localIsoDate(lateEvening)).toBe('2026-10-14');
    expect(localIsoDate(new Date(2026, 0, 5, 0, 10))).toBe('2026-01-05');
  });
  it('names a lecture after its subject and date', () => {
    expect(autoLectureTitle('География', new Date(2026, 9, 14), [])).toBe('География 14.10.26');
    expect(autoLectureTitle('  Лекция ', new Date(2026, 9, 14), ['Другая 14.10.26'])).toBe('Лекция 14.10.26');
  });
  it('appends the first free number to duplicates', () => {
    const date = new Date(2026, 9, 14);
    expect(autoLectureTitle('География', date, ['География 14.10.26'])).toBe('География 14.10.26 (2)');
    expect(autoLectureTitle('География', date, ['География 14.10.26', 'География 14.10.26 (2)'])).toBe(
      'География 14.10.26 (3)',
    );
    // A gap is reused: (2) is free again although (3) exists.
    expect(autoLectureTitle('География', date, ['География 14.10.26', 'География 14.10.26 (3)'])).toBe(
      'География 14.10.26 (2)',
    );
  });
  it('compares existing titles trimmed and case-insensitively', () => {
    const date = new Date(2026, 9, 14);
    expect(autoLectureTitle('География', date, ['  география 14.10.26  '])).toBe('География 14.10.26 (2)');
    expect(autoLectureTitle('Lecture', date, ['LECTURE 14.10.26', 'lecture 14.10.26 (2)'])).toBe(
      'Lecture 14.10.26 (3)',
    );
    expect(autoLectureTitle('Wykład', date, ['WYKŁAD 14.10.26'])).toBe('Wykład 14.10.26 (2)');
  });
});
