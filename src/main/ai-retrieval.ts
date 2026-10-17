import type { ChatContext, ChatMessage, Material } from '../shared/types';
import type { Store } from './store';
import { digest, orderedTranscript, textSections, timeLabel } from './ai-logic';

export interface Passage {
  id: string;
  text: string;
  source: ChatMessage['sources'][number];
}
function parse<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === 'string' ? JSON.parse(value) : ((value as T) ?? fallback);
  } catch {
    return fallback;
  }
}
const STOP_WORDS = new Set(
  'the and what where when how which does this that with from about have are was were for who это что как где когда какой какие есть для или она они мне чем чего где ця це що як де коли який яка які про для та або czy jak co gdzie kiedy który która jakie jest są dla oraz'.split(
    ' ',
  ),
);
const CONCEPTS = [
  ['deadline', 'срок', 'строк', 'дедлайн', 'termin'],
  ['assignment', 'homework', 'задан', 'завдан', 'zadani', 'домаш'],
  ['definition', 'define', 'термин', 'понят', 'визнач', 'defini', 'poję'],
  ['exam', 'экзам', 'іспит', 'egzamin'],
];
export function retrievalTerms(query: string) {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 24);
  for (const group of CONCEPTS)
    if (terms.some((term) => group.some((concept) => term.startsWith(concept)))) terms.push(...group);
  return [...new Set(terms)].slice(0, 48);
}

/**
 * Durable unicode-aware lexical index. Scope filtering occurs in SQL before passages reach the provider.
 * Source keys are `lecture:<id>` and `material:<id>`; Store.forgetRetrieval deletes them when a lecture
 * is permanently deleted, so keep table/key names in sync with it.
 */
export class LocalRetrieval {
  constructor(private store: Store) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS ai_index_sources (sourceKey TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_passages (id TEXT PRIMARY KEY, sourceKey TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_passages_source ON ai_passages(sourceKey);
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_passage_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');`);
  }
  private index(key: string, fingerprint: string, passages: Passage[]) {
    if (
      this.store.db.prepare('SELECT fingerprint FROM ai_index_sources WHERE sourceKey=?').get(key)
        ?.fingerprint === fingerprint
    )
      return;
    this.store.db.exec('BEGIN');
    try {
      this.store.db
        .prepare('DELETE FROM ai_passage_fts WHERE id IN (SELECT id FROM ai_passages WHERE sourceKey=?)')
        .run(key);
      this.store.db.prepare('DELETE FROM ai_passages WHERE sourceKey=?').run(key);
      const insert = this.store.db.prepare(
        'INSERT INTO ai_passages(id,sourceKey,text,source) VALUES(?,?,?,?)',
      );
      const fts = this.store.db.prepare('INSERT INTO ai_passage_fts(id,text) VALUES(?,?)');
      for (const p of passages) {
        insert.run(p.id, key, p.text, JSON.stringify(p.source));
        fts.run(p.id, p.text);
      }
      this.store.db
        .prepare('INSERT OR REPLACE INTO ai_index_sources(sourceKey,fingerprint) VALUES(?,?)')
        .run(key, fingerprint);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  sync(context: ChatContext) {
    const snapshot = this.store.snapshot();
    const lectureIds = snapshot.lectures
      .filter(
        (l) =>
          !l.deletedAt &&
          (context.scope === 'library' ||
            (context.scope === 'subject' && l.subjectId === context.subjectId) ||
            ((context.scope === 'lecture' || context.scope === 'lectures') &&
              context.lectureIds.includes(l.id))),
      )
      .map((l) => l.id);
    const keys: string[] = [];
    for (const lectureId of lectureIds) {
      const detail = this.store.lectureGet(lectureId);
      const version =
        detail.versions.find((v) => v.id === detail.lecture.activeVersionId) ??
        detail.versions.find((v) => v.kind === 'original');
      const key = `lecture:${lectureId}`,
        title = detail.lecture.title;
      const content = version?.content ?? orderedTranscript(detail.segments, detail.items);
      const chunks = textSections(content, 2600);
      const passages = chunks.map((text, index) => {
        const stamp = text.match(/\[(?:(\d+):)?(\d+):(\d+)\]/);
        const start = stamp
          ? Number(stamp[1] ?? 0) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3])
          : undefined;
        return {
          id: `${key}:${index}`,
          text,
          source: { title, lectureId, ...(start === undefined ? {} : { start }) },
        };
      });
      this.index(key, digest([title, version?.id, content]), passages);
      keys.push(key);
    }
    const raw = this.store.db.prepare("SELECT * FROM materials WHERE status='ready'").all();
    for (const row of raw) {
      const material = { ...row, pages: parse(row.pages, []) } as unknown as Material;
      const explicit = context.materialIds.includes(material.id);
      const associated = material.lectureId && lectureIds.includes(material.lectureId);
      const subjectFile =
        context.scope === 'subject' && !material.lectureId && material.subjectId === context.subjectId;
      const libraryFile =
        context.scope === 'library' && (!material.lectureId || lectureIds.includes(material.lectureId));
      if (!explicit && !associated && !subjectFile && !libraryFile) continue;
      // A trashed lecture's attachments are not accessible through implicit library/subject context.
      const key = `material:${material.id}`;
      const passages: Passage[] = [];
      for (const page of material.pages)
        for (const [index, text] of textSections(page.text, 2600).entries())
          passages.push({
            id: `${key}:${page.page}:${index}`,
            text,
            source: { title: material.name, materialId: material.id, page: page.page },
          });
      this.index(key, digest([material.name, material.pages]), passages);
      keys.push(key);
    }
    return keys;
  }
  retrieve(keys: string[], query: string, limit = 18): Passage[] {
    if (!keys.length) return [];
    const terms = retrievalTerms(query);
    const scope = keys.map(() => '?').join(',');
    const decode = (row: any): Passage => ({
      id: row.id,
      text: row.text,
      source: parse(row.source, { title: '' }),
    });
    if (terms.length) {
      const match = terms
        .flatMap((t) =>
          t.length > 6 ? [`"${t}"*`, `"${t.slice(0, Math.max(5, t.length - 2))}"*`] : [`"${t}"*`],
        )
        .join(' OR ');
      const rows = this.store.db
        .prepare(
          `SELECT p.* FROM ai_passage_fts f JOIN ai_passages p ON p.id=f.id WHERE ai_passage_fts MATCH ? AND p.sourceKey IN (${scope}) ORDER BY bm25(ai_passage_fts) LIMIT ?`,
        )
        .all(match, ...keys, limit);
      if (rows.length) return rows.map(decode);
    }
    return this.store.db
      .prepare(`SELECT * FROM ai_passages WHERE sourceKey IN (${scope}) ORDER BY sourceKey,id LIMIT ?`)
      .all(...keys, limit)
      .map(decode);
  }
  all(keys: string[]): Passage[] {
    if (!keys.length) return [];
    return this.store.db
      .prepare(
        `SELECT * FROM ai_passages WHERE sourceKey IN (${keys.map(() => '?').join(',')}) ORDER BY sourceKey,rowid`,
      )
      .all(...keys)
      .map((row: any) => ({ id: row.id, text: row.text, source: parse(row.source, { title: '' }) }));
  }
}
export function passageLabel(passage: Passage) {
  return `${passage.source.title}${passage.source.page === undefined ? '' : `, page ${passage.source.page}`}${passage.source.start === undefined ? '' : `, ${timeLabel(passage.source.start)}`}`;
}
export function passageInput(passages: Passage[]) {
  return passages.map((p, i) => `[S${i + 1}] ${passageLabel(p)}\n${p.text}`).join('\n\n');
}
export const requestsSummary = (text: string) =>
  /summari[sz]|summary|overview|synthesi[sz]|detailed notes|конспект|резюм|обобщ|підсум|підб.*підсум|streszcz|podsum/iu.test(
    text,
  );
