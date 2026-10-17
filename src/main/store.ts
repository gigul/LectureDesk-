import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, lstatSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type Settings,
  type Subject,
  type Lecture,
  type Segment,
  type TranscriptItem,
  type Version,
  type Material,
  type Task,
  type Gap,
  type CustomAction,
  type Conversation,
  type ChatContext,
  type ChatMode,
  type ChatMessage,
  type Usage,
  type LectureDetail,
} from '../shared/types.js';
import { localIsoDate } from '../shared/naming.js';

const now = () => new Date().toISOString();
/** Top-level folders of the library root that hold lecture files (never the database or credentials). */
const LIBRARY_CONTENT = ['audio', 'lectures', 'materials', 'restored'];
const jsonFields = new Set(['tags', 'parameters', 'pages', 'payload', 'context', 'sources', 'data']);
function decode<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined;
  const result = { ...row };
  for (const key of jsonFields)
    if (typeof result[key] === 'string') result[key] = JSON.parse(result[key] as string);
  if ('pinned' in result) result.pinned = Boolean(result.pinned);
  delete result.dedupeKey;
  return result as T;
}
function encode(key: string, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (jsonFields.has(key)) return JSON.stringify(value);
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new Error(`Invalid value for ${key}`);
}

/** Database always lives in the application data directory, never in a user's sync folder. */
export class Store {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly baseRoot: string;
  constructor(baseRoot: string) {
    this.baseRoot = path.resolve(baseRoot);
    mkdirSync(this.baseRoot, { recursive: true });
    this.databasePath = path.join(this.baseRoot, 'library.sqlite');
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
    );
    try {
      this.migrate();
    } catch (error) {
      this.db.close(); // Release the file so the user can move or replace the library.
      throw error;
    }
    // Operations persisted before a crash remain queued; recordings require explicit recovery.
    this.db.exec(
      "UPDATE tasks SET status='queued',nextRun=0 WHERE status='running'; UPDATE lectures SET status='interrupted' WHERE status IN ('recording','paused','importing'); UPDATE materials SET status='error',error='Import was interrupted. Retry to continue from the preserved original.' WHERE status='processing';",
    );
  }
  get root(): string {
    return this.settings().storageFolder || this.baseRoot;
  }
  private schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version);
  }
  /**
   * Sequential schema steps keyed by the version they produce. Each step runs in its own
   * BEGIN IMMEDIATE transaction together with its `PRAGMA user_version` bump, so a crash
   * leaves the library at the previous complete version. Append new steps at the end.
   */
  private readonly migrations: { to: number; run: (defaults: string) => void }[] = [
    { to: 1, run: (defaults) => this.createSchemaV1(defaults) },
    { to: 2, run: () => this.allowPermanentDeletionOfTrashedOriginals() },
    { to: 3, run: () => this.addTranscriptItems() },
  ];
  private migrate(): void {
    const latest = this.migrations[this.migrations.length - 1].to; // currently 3
    if (this.schemaVersion() > latest)
      throw new Error('This library was created by a newer version of LectureDesk.');
    const defaults = JSON.stringify({ ...DEFAULT_SETTINGS, storageFolder: this.baseRoot });
    for (const step of this.migrations) {
      if (step.to <= this.schemaVersion()) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        step.run(defaults);
        this.db.exec(`PRAGMA user_version=${step.to}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    // Repair the missing singleton left by early builds without resetting any library records.
    this.db.prepare('INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)').run(defaults);
  }
  /** 0 → 1: initial schema. */
  private createSchemaV1(defaults: string): void {
    this.db.exec(`
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE subjects (id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,glossary TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE lectures (id TEXT PRIMARY KEY,subjectId TEXT REFERENCES subjects(id) ON DELETE SET NULL,title TEXT NOT NULL,topic TEXT NOT NULL,date TEXT NOT NULL,tags TEXT NOT NULL,status TEXT NOT NULL,duration REAL NOT NULL,createdAt TEXT NOT NULL,deletedAt TEXT,activeVersionId TEXT);
      CREATE TABLE segments (id TEXT PRIMARY KEY,lectureId TEXT NOT NULL REFERENCES lectures(id),sequence INTEGER NOT NULL,start REAL NOT NULL,end REAL NOT NULL,path TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,error TEXT,UNIQUE(lectureId,sequence));
      CREATE TABLE versions (id TEXT PRIMARY KEY,lectureId TEXT NOT NULL REFERENCES lectures(id),kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,model TEXT NOT NULL,parameters TEXT NOT NULL,sourceVersionId TEXT REFERENCES versions(id),createdAt TEXT NOT NULL);
      CREATE UNIQUE INDEX one_original ON versions(lectureId) WHERE kind='original';
      CREATE TRIGGER original_update BEFORE UPDATE ON versions WHEN OLD.kind='original' BEGIN SELECT RAISE(ABORT,'Original transcripts are immutable'); END;
      CREATE TRIGGER original_delete BEFORE DELETE ON versions WHEN OLD.kind='original' BEGIN SELECT RAISE(ABORT,'Original transcripts are immutable'); END;
      CREATE TABLE materials (id TEXT PRIMARY KEY,lectureId TEXT REFERENCES lectures(id),subjectId TEXT REFERENCES subjects(id) ON DELETE SET NULL,name TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,pages TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY,lectureId TEXT REFERENCES lectures(id),kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,nextRun REAL NOT NULL,error TEXT,createdAt TEXT NOT NULL,dedupeKey TEXT UNIQUE);
      CREATE TABLE gaps (id TEXT PRIMARY KEY,lectureId TEXT NOT NULL REFERENCES lectures(id),at REAL NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE actions (id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT NOT NULL,instructions TEXT NOT NULL,language TEXT NOT NULL,model TEXT NOT NULL,format TEXT NOT NULL,pinned INTEGER NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,context TEXT NOT NULL,mode TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE usage (id TEXT PRIMARY KEY,lectureId TEXT REFERENCES lectures(id),operation TEXT NOT NULL,model TEXT NOT NULL,data TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE INDEX segments_order ON segments(lectureId,sequence); CREATE INDEX tasks_queue ON tasks(status,nextRun); CREATE INDEX materials_lecture ON materials(lectureId); CREATE INDEX versions_lecture ON versions(lectureId,createdAt);`);
    this.db.prepare('INSERT INTO settings(id,data) VALUES(1,?)').run(defaults);
  }
  /**
   * 1 → 2: originals stay immutable, but permanently deleting a lecture that is already in
   * Trash may remove its original. Updates remain forbidden unconditionally.
   */
  private allowPermanentDeletionOfTrashedOriginals(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS original_delete;
      CREATE TRIGGER original_delete BEFORE DELETE ON versions
        WHEN OLD.kind='original' AND NOT EXISTS (SELECT 1 FROM lectures WHERE id=OLD.lectureId AND deletedAt IS NOT NULL)
        BEGIN SELECT RAISE(ABORT,'Original transcripts are immutable'); END;`);
  }
  /**
   * 2 → 3: finalized speech turns / silence-split chunks live in `transcript_items` (new recordings
   * keep segments as audio only). Settings: the 'auto' lecture language is replaced by an explicit
   * language that the user confirms once; the old default live model moves to the new default.
   */
  private addTranscriptItems(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_items (id TEXT PRIMARY KEY,lectureId TEXT NOT NULL REFERENCES lectures(id),start REAL NOT NULL,end REAL NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,model TEXT NOT NULL,language TEXT,error TEXT,sourceKey TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(lectureId,sourceKey));
      CREATE INDEX IF NOT EXISTS transcript_items_order ON transcript_items(lectureId,start);`);
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get() as { data: string } | undefined;
    if (!row) return; // The singleton is repaired with current defaults after migration.
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const languages = ['ru', 'uk', 'en', 'pl'];
    const ui = languages.includes(String(data.uiLanguage)) ? String(data.uiLanguage) : DEFAULT_SETTINGS.uiLanguage;
    if (!('lectureLanguageConfirmed' in data)) {
      const explicit = languages.includes(String(data.lectureLanguage));
      data.lectureLanguageConfirmed = explicit && data.setupComplete === true;
      if (!explicit) data.lectureLanguage = ui;
    }
    // Only the untouched previous default is switched; any other explicit choice is preserved.
    if (data.liveModel === 'gpt-live-transcribe') data.liveModel = DEFAULT_SETTINGS.liveModel;
    this.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(data));
  }
  private rows<T>(table: string, where = '', values: (string | number | null)[] = [], order = ''): T[] {
    return this.db
      .prepare(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}${order ? ` ORDER BY ${order}` : ''}`)
      .all(...values)
      .map((row) => decode<T>(row) as T);
  }
  private insert(table: string, object: object): void {
    const entries = Object.entries(object);
    this.db
      .prepare(
        `INSERT INTO ${table} (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`,
      )
      .run(...entries.map(([key, value]) => encode(key, value)));
  }
  private update(table: string, id: string, patch: Record<string, unknown>, allowed: string[]): void {
    const entries = Object.entries(patch).filter(
      ([key, value]) => allowed.includes(key) && value !== undefined,
    );
    if (!entries.length) return;
    this.db
      .prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
      .run(...entries.map(([key, value]) => encode(key, value)), id);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get() as { data: string };
    const settings: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(row.data) };
    // 'auto' is no longer an effective lecture language; never let a stray value reach a request.
    if (!['ru', 'uk', 'en', 'pl'].includes(settings.lectureLanguage)) {
      settings.lectureLanguage = settings.uiLanguage;
      settings.lectureLanguageConfirmed = false;
    }
    return settings;
  }
  saveSettings(patch: Partial<Settings>): Settings {
    // Explicitly pick known settings so credential-like or arbitrary IPC fields cannot enter backups.
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS))
      if (key in patch) clean[key] = patch[key as keyof Settings];
    const result = { ...this.settings(), ...clean } as Settings;
    if (result.storageFolder) {
      result.storageFolder = path.resolve(result.storageFolder);
      mkdirSync(result.storageFolder, { recursive: true });
    }
    this.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(result));
    return result;
  }
  snapshot() {
    const lectures = this.rows<Lecture>('lectures', '', [], 'date DESC,createdAt DESC');
    return {
      subjects: this.rows<Subject>('subjects', '', [], 'name COLLATE NOCASE'),
      lectures,
      tasks: this.tasks(),
      recoverable: lectures.filter((lecture) => lecture.status === 'interrupted' && !lecture.deletedAt),
      settings: this.settings(),
      actions: this.rows<CustomAction>('actions', '', [], 'pinned DESC,name COLLATE NOCASE'),
    };
  }
  subjectSave(input: { id?: string; name: string; color?: string; glossary?: string }): Subject {
    const existing = input.id ? this.rows<Subject>('subjects', 'id=?', [input.id])[0] : undefined;
    if (input.id && !existing) throw new Error('Subject does not exist');
    const subject: Subject = {
      id: existing?.id || randomUUID(),
      name: input.name.trim() || 'Untitled subject',
      color: input.color ?? existing?.color ?? '#7f76db',
      glossary: input.glossary ?? existing?.glossary ?? '',
      createdAt: existing?.createdAt || now(),
    };
    if (existing) this.update('subjects', subject.id, { ...subject }, ['name', 'color', 'glossary']);
    else this.insert('subjects', subject);
    return subject;
  }
  subjectDelete(id: string): void {
    this.db.prepare('DELETE FROM subjects WHERE id=?').run(id);
  }
  lectureCreate(input: { subjectId?: string | null; title?: string } = {}): Lecture {
    const lecture: Lecture = {
      id: randomUUID(),
      subjectId: input.subjectId || null,
      title: input.title?.trim() || 'Untitled lecture',
      topic: '',
      date: localIsoDate(new Date()),
      tags: [],
      status: 'ready',
      duration: 0,
      createdAt: now(),
      deletedAt: null,
      activeVersionId: null,
    };
    this.insert('lectures', lecture);
    return lecture;
  }
  lectureGet(id: string): LectureDetail {
    const lecture = this.rows<Lecture>('lectures', 'id=?', [id])[0];
    if (!lecture) throw new Error('Lecture does not exist');
    return {
      lecture,
      segments: this.rows<Segment>('segments', 'lectureId=?', [id], 'sequence'),
      items: this.rows<TranscriptItem>('transcript_items', 'lectureId=?', [id], 'start,sourceKey'),
      versions: this.rows<Version>('versions', 'lectureId=?', [id], 'createdAt,id'),
      materials: this.rows<Material>('materials', 'lectureId=?', [id], 'createdAt'),
      gaps: this.rows<Gap>('gaps', 'lectureId=?', [id], 'at'),
      usage: this.rows<Usage>('usage', 'lectureId=?', [id], 'createdAt'),
    };
  }
  lectureSave(input: { id: string } & Partial<Lecture>): Lecture {
    this.lectureGet(input.id);
    if (input.activeVersionId) this.versionActivate(input.id, input.activeVersionId);
    this.update('lectures', input.id, input, [
      'subjectId',
      'title',
      'topic',
      'date',
      'tags',
      'status',
      'duration',
      'deletedAt',
    ]);
    return this.lectureGet(input.id).lecture;
  }
  lectureTrash(id: string): void {
    this.lectureSave({ id, deletedAt: now() });
  }
  lectureRestore(id: string): void {
    this.lectureSave({ id, deletedAt: null });
  }
  /** Permanently deletes one lecture that is already in Trash, including its original and files. */
  lecturePurge(id: string): void {
    const plan = this.scrubbed(() => this.transaction(() => this.purgeRows(id)));
    this.removeLibraryFiles(plan);
  }
  /** Permanently deletes every lecture in Trash. Nothing is deleted if any of them is busy. */
  trashEmpty(): { count: number } {
    const plans = this.scrubbed(() =>
      this.transaction(() => {
        const trashed = this.rows<Lecture>('lectures', 'deletedAt IS NOT NULL');
        for (const lecture of trashed) this.assertPurgeable(lecture);
        return trashed.map((lecture) => this.purgeRows(lecture.id));
      }),
    );
    this.removeLibraryFiles({
      directories: plans.flatMap((plan) => plan.directories),
      files: plans.flatMap((plan) => plan.files),
    });
    return { count: plans.length };
  }
  /** Overwrites freed database pages and flushes the WAL so deleted text does not linger on disk. */
  private scrubbed<T>(operation: () => T): T {
    const previous = Number(
      (this.db.prepare('PRAGMA secure_delete').get() as Record<string, unknown>).secure_delete,
    );
    this.db.exec('PRAGMA secure_delete=ON');
    try {
      return operation();
    } finally {
      this.db.exec(`PRAGMA secure_delete=${previous ? 'ON' : 'OFF'}`);
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* A busy checkpoint is retried automatically by SQLite later. */
      }
    }
  }
  private assertPurgeable(lecture: Lecture): void {
    if (!lecture.deletedAt) throw new Error('Only lectures in Trash can be deleted permanently');
    if (['recording', 'paused', 'importing'].includes(lecture.status))
      throw new Error('Wait for recording or import to finish before deleting this lecture permanently');
    if (this.rows<Material>('materials', "lectureId=? AND status='processing'", [lecture.id]).length)
      throw new Error('Wait for file processing to finish before deleting this lecture permanently');
  }
  /** Deletes the lecture's rows (caller owns the transaction) and returns the files to remove afterwards. */
  private purgeRows(id: string): { directories: string[]; files: string[] } {
    const lecture = this.rows<Lecture>('lectures', 'id=?', [id])[0];
    if (!lecture) throw new Error('Lecture does not exist');
    this.assertPurgeable(lecture);
    const segments = this.rows<Segment>('segments', 'lectureId=?', [id]);
    const materials = this.rows<Material>('materials', 'lectureId=?', [id]);
    // versions.sourceVersionId links versions of this lecture to each other in arbitrary order;
    // foreign keys are enforced (PRAGMA foreign_keys=ON), so check them at COMMIT once all are gone.
    this.db.exec('PRAGMA defer_foreign_keys=ON');
    const run = (sql: string) => this.db.prepare(sql).run(id);
    run('DELETE FROM tasks WHERE lectureId=?');
    run('DELETE FROM usage WHERE lectureId=?');
    run('DELETE FROM gaps WHERE lectureId=?');
    run('DELETE FROM transcript_items WHERE lectureId=?');
    run('DELETE FROM segments WHERE lectureId=?');
    run('UPDATE lectures SET activeVersionId=NULL WHERE id=?');
    // The original_delete trigger permits this only because the lecture row is still marked deleted.
    run('DELETE FROM versions WHERE lectureId=?');
    run('DELETE FROM materials WHERE lectureId=?');
    this.forgetRetrieval([`lecture:${id}`, ...materials.map((material) => `material:${material.id}`)]);
    run('DELETE FROM lectures WHERE id=?');
    return {
      directories: [path.join('audio', id), path.join('lectures', id)],
      files: [...segments, ...materials].map((item) => item.path).filter(Boolean),
    };
  }
  /** Removes chat retrieval passages (tables owned by LocalRetrieval in ai-retrieval.ts), if indexed. */
  private forgetRetrieval(sourceKeys: string[]): void {
    const tables = new Set(
      (
        this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('ai_passage_fts','ai_passages','ai_index_sources')",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    for (const key of sourceKeys) {
      if (tables.has('ai_passage_fts') && tables.has('ai_passages'))
        this.db
          .prepare('DELETE FROM ai_passage_fts WHERE id IN (SELECT id FROM ai_passages WHERE sourceKey=?)')
          .run(key);
      if (tables.has('ai_passages')) this.db.prepare('DELETE FROM ai_passages WHERE sourceKey=?').run(key);
      if (tables.has('ai_index_sources'))
        this.db.prepare('DELETE FROM ai_index_sources WHERE sourceKey=?').run(key);
    }
  }
  /**
   * Best-effort removal of purged library files. Only paths inside a content folder of `root`
   * are touched; links are never followed and files still referenced by other rows are kept.
   */
  private removeLibraryFiles(plan: { directories: string[]; files: string[] }): void {
    const root = path.resolve(this.root);
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return;
    }
    const outside = (rel: string) =>
      !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    const contained = (target: string): string | null => {
      const resolved = path.resolve(root, target);
      const rel = path.relative(root, resolved);
      if (outside(rel)) return null;
      const parts = rel.split(path.sep);
      if (parts.length < 2 || !LIBRARY_CONTENT.includes(parts[0])) return null;
      try {
        // Every existing parent must physically live inside the library (no junction/symlink escape).
        const parent = realpathSync(path.dirname(resolved));
        if (parent !== realRoot && outside(path.relative(realRoot, parent))) return null;
        if (lstatSync(resolved).isSymbolicLink()) return null;
      } catch {
        return null; // Missing: nothing to delete.
      }
      return resolved;
    };
    // Paths still referenced by remaining rows (e.g. a file shared after an import) are never removed.
    const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const referenced = new Set(
      (
        this.db
          .prepare("SELECT path FROM segments WHERE path<>'' UNION SELECT path FROM materials WHERE path<>''")
          .all() as { path: string }[]
      ).map((row) => key(path.resolve(root, row.path))),
    );
    const stillUsed = (target: string, directory: boolean) => {
      if (referenced.has(key(target))) return true;
      if (!directory) return false;
      const prefix = key(target + path.sep);
      for (const file of referenced) if (file.startsWith(prefix)) return true;
      return false;
    };
    for (const directory of plan.directories) {
      const target = contained(directory);
      if (!target || stillUsed(target, true)) continue;
      try {
        if (lstatSync(target).isDirectory())
          rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      } catch (error) {
        console.warn('LectureDesk: could not remove purged folder', target, error);
      }
    }
    for (const file of plan.files) {
      const target = contained(file);
      if (!target || stillUsed(target, false)) continue;
      try {
        if (lstatSync(target).isDirectory()) continue;
        unlinkSync(target);
      } catch (error) {
        console.warn('LectureDesk: could not remove purged file', target, error);
        continue;
      }
      // Drop folders left empty (e.g. materials/<id>, restored/<backup>/files/…) up to the content folder.
      for (
        let folder = path.dirname(target);
        path.relative(root, folder).split(path.sep).length >= 2 && !outside(path.relative(root, folder));
        folder = path.dirname(folder)
      ) {
        try {
          rmdirSync(folder);
        } catch {
          break;
        }
      }
    }
  }
  versionSave(input: {
    lectureId: string;
    kind: Version['kind'];
    title: string;
    content: string;
    model?: string;
    parameters?: Record<string, unknown>;
    sourceVersionId?: string | null;
  }): Version {
    return this.transaction(() => {
      this.lectureGet(input.lectureId);
      if (input.kind === 'original') {
        const existing = this.rows<Version>('versions', "lectureId=? AND kind='original'", [
          input.lectureId,
        ])[0];
        if (existing) {
          if (existing.content === input.content) return existing;
          throw new Error('An original transcript already exists. Save changes as a new version.');
        }
      }
      if (
        input.sourceVersionId &&
        !this.rows<Version>('versions', 'id=? AND lectureId=?', [input.sourceVersionId, input.lectureId])[0]
      )
        throw new Error('Source version belongs to another lecture');
      const version: Version = {
        id: randomUUID(),
        lectureId: input.lectureId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        model: input.model || '',
        parameters: input.parameters || {},
        sourceVersionId: input.sourceVersionId || null,
        createdAt: now(),
      };
      this.insert('versions', version);
      this.update('lectures', input.lectureId, { activeVersionId: version.id }, ['activeVersionId']);
      return version;
    });
  }
  versionActivate(lectureId: string, versionId: string): void {
    if (!this.rows<Version>('versions', 'id=? AND lectureId=?', [versionId, lectureId])[0])
      throw new Error('Version does not belong to this lecture');
    this.update('lectures', lectureId, { activeVersionId: versionId }, ['activeVersionId']);
  }
  segmentSave(segment: Segment): Segment {
    this.insert('segments', segment);
    return segment;
  }
  segmentUpdate(id: string, patch: Partial<Segment>): void {
    this.update('segments', id, patch, ['text', 'status', 'error']);
  }
  /** Idempotent by (lectureId, sourceKey): a repeated save returns the row stored first. */
  itemSave(input: Omit<TranscriptItem, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): TranscriptItem {
    const item: TranscriptItem = {
      id: input.id ?? randomUUID(),
      lectureId: input.lectureId,
      start: input.start,
      end: Math.max(input.start, input.end),
      text: input.text,
      status: input.status,
      source: input.source,
      model: input.model,
      language: input.language ?? null,
      error: input.error ?? null,
      sourceKey: input.sourceKey,
      createdAt: input.createdAt ?? now(),
    };
    const entries = Object.entries(item);
    this.db
      .prepare(
        `INSERT INTO transcript_items (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')}) ON CONFLICT(lectureId,sourceKey) DO NOTHING`,
      )
      .run(...entries.map(([key, value]) => encode(key, value)));
    return this.rows<TranscriptItem>('transcript_items', 'lectureId=? AND sourceKey=?', [
      item.lectureId,
      item.sourceKey,
    ])[0];
  }
  itemUpdate(id: string, patch: Partial<Pick<TranscriptItem, 'text' | 'status' | 'error' | 'language'>>): void {
    this.update('transcript_items', id, patch, ['text', 'status', 'error', 'language']);
  }
  gap(lectureId: string, at: number, reason: string): Gap {
    const gap = { id: randomUUID(), lectureId, at, reason, createdAt: now() };
    this.insert('gaps', gap);
    return gap;
  }
  taskAdd(
    kind: string,
    lectureId: string | null,
    payload: Record<string, unknown>,
    dedupeKey?: string,
  ): Task {
    const task: Task = {
      id: randomUUID(),
      lectureId,
      kind,
      payload,
      status: 'queued',
      attempts: 0,
      nextRun: 0,
      error: null,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO tasks(id,lectureId,kind,payload,status,attempts,nextRun,error,createdAt,dedupeKey) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupeKey) DO NOTHING',
      )
      .run(
        task.id,
        lectureId,
        kind,
        JSON.stringify(payload),
        task.status,
        0,
        0,
        null,
        task.createdAt,
        dedupeKey || null,
      );
    return dedupeKey ? this.rows<Task>('tasks', 'dedupeKey=?', [dedupeKey])[0] : task;
  }
  taskUpdate(id: string, patch: Partial<Task>): void {
    this.update('tasks', id, patch, ['payload', 'status', 'attempts', 'nextRun', 'error']);
  }
  tasks(): Task[] {
    return this.rows<Task>('tasks', '', [], 'createdAt');
  }
  taskGet(id: string): Task | undefined {
    return this.rows<Task>('tasks', 'id=?', [id])[0];
  }
  materialSave(material: Material): Material {
    this.insert('materials', material);
    return material;
  }
  materialUpdate(id: string, patch: Partial<Material>): void {
    this.update('materials', id, patch, ['pages', 'status', 'error']);
  }
  materials(): Material[] {
    return this.rows<Material>('materials', '', [], 'createdAt');
  }
  actionSave(input: CustomAction): CustomAction {
    if (this.rows<CustomAction>('actions', 'id=?', [input.id])[0])
      this.update('actions', input.id, { ...input }, [
        'name',
        'icon',
        'instructions',
        'language',
        'model',
        'format',
        'pinned',
      ]);
    else this.insert('actions', input);
    return input;
  }
  actionDelete(id: string): void {
    this.db.prepare('DELETE FROM actions WHERE id=?').run(id);
  }
  conversationCreate(context: ChatContext, mode: ChatMode, title = 'New conversation'): Conversation {
    const conversation: Conversation = { id: randomUUID(), title, context, mode, createdAt: now() };
    this.insert('conversations', conversation);
    return conversation;
  }
  conversations(): Conversation[] {
    return this.rows<Conversation>('conversations', '', [], 'createdAt DESC');
  }
  messages(conversationId: string): ChatMessage[] {
    return this.rows<ChatMessage>('messages', 'conversationId=?', [conversationId], 'createdAt,rowid');
  }
  messageSave(message: ChatMessage): ChatMessage {
    this.insert('messages', message);
    return message;
  }
  usageSave(
    lectureId: string | null,
    operation: string,
    model: string,
    data: Record<string, unknown>,
  ): Usage {
    const usage = { id: randomUUID(), lectureId, operation, model, data, createdAt: now() };
    this.insert('usage', usage);
    return usage;
  }
  close(): void {
    this.db.close();
  }
}
