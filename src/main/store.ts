import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type Settings,
  type Subject,
  type Lecture,
  type Segment,
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

const now = () => new Date().toISOString();
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
    this.migrate();
    // Operations persisted before a crash remain queued; recordings require explicit recovery.
    this.db.exec(
      "UPDATE tasks SET status='queued',nextRun=0 WHERE status='running'; UPDATE lectures SET status='interrupted' WHERE status IN ('recording','paused','importing'); UPDATE materials SET status='error',error='Import was interrupted. Retry to continue from the preserved original.' WHERE status='processing';",
    );
  }
  get root(): string {
    return this.settings().storageFolder || this.baseRoot;
  }
  private migrate(): void {
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version,
    );
    if (version > 1) throw new Error('This library was created by a newer version of LectureDesk.');
    const defaults = JSON.stringify({ ...DEFAULT_SETTINGS, storageFolder: this.baseRoot });
    if (version === 1) {
      // Repair the missing singleton left by early builds without resetting any library records.
      this.db.prepare('INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)').run(defaults);
      return;
    }
    try {
      this.db.exec(`BEGIN IMMEDIATE;
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
      this.db.exec('PRAGMA user_version=1; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.data) };
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
      date: now().slice(0, 10),
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
