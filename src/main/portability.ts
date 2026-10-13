import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import archiver from 'archiver';
import yauzl from 'yauzl';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { Store } from './store.js';
import { resourceFile, runFFmpeg, checkedLibraryAsset } from './materials.js';
import {
  type Backup,
  type Lecture,
  type Subject,
  type Segment,
  type Version,
  type Material,
  type Gap,
  type CustomAction,
  type Conversation,
  type ChatMessage,
  type Usage,
  type Task,
} from '../shared/types.js';

type Tables = {
  subjects: Subject[];
  lectures: Lecture[];
  segments: Segment[];
  versions: Version[];
  materials: Material[];
  gaps: Gap[];
  actions: CustomAction[];
  conversations: Conversation[];
  messages: ChatMessage[];
  usage: Usage[];
  tasks: Task[];
};
type ArchiveData = {
  schema: 1;
  kind: 'lecture' | 'backup';
  createdAt: string;
  audioIncluded: boolean;
  tables: Tables;
  recoveryFiles?: { lectureId: string; path: string; name: string }[];
};
type Manifest = {
  schema: 1;
  format: 'LectureDesk';
  entries: { path: string; size: number; sha256: string }[];
};
export type ArchivePreview = {
  kind: 'lecture' | 'backup';
  createdAt: string;
  lectures: number;
  subjects: number;
  materials: number;
  versions: number;
  audioIncluded: boolean;
  bytes: number;
};
const tableNames = [
  'subjects',
  'lectures',
  'segments',
  'versions',
  'materials',
  'gaps',
  'actions',
  'conversations',
  'messages',
  'usage',
  'tasks',
] as const;
const jsonFields = new Set(['tags', 'parameters', 'pages', 'context', 'sources', 'data', 'payload']);
const columns: Record<keyof Tables, string[]> = {
  subjects: ['id', 'name', 'color', 'glossary', 'createdAt'],
  lectures: [
    'id',
    'subjectId',
    'title',
    'topic',
    'date',
    'tags',
    'status',
    'duration',
    'createdAt',
    'deletedAt',
    'activeVersionId',
  ],
  segments: ['id', 'lectureId', 'sequence', 'start', 'end', 'path', 'text', 'status', 'error'],
  versions: [
    'id',
    'lectureId',
    'kind',
    'title',
    'content',
    'model',
    'parameters',
    'sourceVersionId',
    'createdAt',
  ],
  materials: [
    'id',
    'lectureId',
    'subjectId',
    'name',
    'path',
    'mime',
    'size',
    'status',
    'error',
    'pages',
    'createdAt',
  ],
  gaps: ['id', 'lectureId', 'at', 'reason', 'createdAt'],
  actions: ['id', 'name', 'icon', 'instructions', 'language', 'model', 'format', 'pinned'],
  conversations: ['id', 'title', 'context', 'mode', 'createdAt'],
  messages: ['id', 'conversationId', 'role', 'content', 'sources', 'createdAt'],
  usage: ['id', 'lectureId', 'operation', 'model', 'data', 'createdAt'],
  tasks: ['id', 'lectureId', 'kind', 'payload', 'status', 'attempts', 'nextRun', 'error', 'createdAt'],
};
export function safeArchivePath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value)
  )
    throw new Error('Unsafe archive path');
  const components = value.split('/');
  if (components.some((component) => !component || component === '.' || component === '..'))
    throw new Error('Unsafe archive path');
  return components.join('/');
}
async function digest(filename: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest('hex') };
}
async function atomicFile(destination: string, produce: (temporary: string) => Promise<void>): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    await produce(temporary);
    const file = await fs.open(temporary, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
function decodeRows<T>(database: DatabaseSync, table: string): T[] {
  return database
    .prepare(`SELECT * FROM ${table}`)
    .all()
    .map((row) => {
      const object: Record<string, unknown> = { ...row };
      for (const field of jsonFields)
        if (typeof object[field] === 'string') object[field] = JSON.parse(object[field] as string);
      if ('pinned' in object) object.pinned = Boolean(object.pinned);
      delete object.dedupeKey;
      return object as T;
    });
}
async function readArchive(
  filename: string,
  stage: string,
): Promise<{ data: ArchiveData; manifest: Manifest; bytes: number }> {
  // Limit both individual members and the whole expanded archive, independent of compressed size.
  await new Promise<void>((resolve, reject) =>
    yauzl.open(filename, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error('Invalid archive'));
      let total = 0;
      const names = new Set<string>();
      let failed = false;
      const fail = (reason: unknown) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(reason);
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        try {
          const member = safeArchivePath(entry.fileName);
          if (names.has(member)) throw new Error('Duplicate archive member');
          names.add(member);
          if (entry.generalPurposeBitFlag & 1 || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
            throw new Error('Encrypted entries and symlinks are unsupported');
          if (
            entry.uncompressedSize > 8 * 1024 ** 3 ||
            (total += entry.uncompressedSize) > 64 * 1024 ** 3 ||
            names.size > 100000
          )
            throw new Error('Archive exceeds safe size limits');
          if (
            (member === 'manifest.json' || member === 'data.json') &&
            entry.uncompressedSize > 128 * 1024 ** 2
          )
            throw new Error('Archive metadata is too large');
          const destination = path.join(stage, ...member.split('/'));
          void fs
            .mkdir(path.dirname(destination), { recursive: true })
            .then(
              () =>
                new Promise<void>((done, streamReject) =>
                  zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream)
                      return streamReject(streamError || new Error('Invalid archive entry'));
                    pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: 0o600 })).then(
                      () => done(),
                      streamReject,
                    );
                  }),
                ),
            )
            .then(() => {
              if (!failed) zip.readEntry();
            }, fail);
        } catch (reason) {
          fail(reason);
        }
      });
      zip.on('end', () => resolve());
      zip.readEntry();
    }),
  );
  const manifest = JSON.parse(await fs.readFile(path.join(stage, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.schema !== 1 || manifest.format !== 'LectureDesk' || !Array.isArray(manifest.entries))
    throw new Error('Unsupported LectureDesk archive');
  const listed = new Set<string>();
  let bytes = 0;
  for (const item of manifest.entries) {
    const member = safeArchivePath(item.path);
    if (
      member === 'manifest.json' ||
      listed.has(member) ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      !/^([a-f0-9]{64})$/.test(item.sha256)
    )
      throw new Error('Invalid archive manifest');
    listed.add(member);
    const actual = await digest(path.join(stage, ...member.split('/')));
    if (actual.size !== item.size || actual.sha256 !== item.sha256)
      throw new Error(`Integrity check failed: ${member}`);
    bytes += actual.size;
  }
  if (!listed.has('data.json')) throw new Error('Archive metadata is missing');
  const files = await walkFiles(stage);
  if (files.some((file) => file !== 'manifest.json' && !listed.has(file)))
    throw new Error('Archive contains unlisted files');
  const data = JSON.parse(await fs.readFile(path.join(stage, 'data.json'), 'utf8')) as ArchiveData;
  validateData(data, listed);
  return { data, manifest, bytes };
}
async function walkFiles(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await walkFiles(root, name)));
    else result.push(name);
  }
  return result;
}
function validateData(data: ArchiveData, entries: Set<string>): void {
  if (
    data.schema !== 1 ||
    !['lecture', 'backup'].includes(data.kind) ||
    !data.tables ||
    typeof data.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(data.createdAt))
  )
    throw new Error('Invalid archive data');
  const ids = new Set<string>();
  for (const table of tableNames) {
    if (!Array.isArray(data.tables[table]) || data.tables[table].length > 100000)
      throw new Error(`Invalid archive table: ${table}`);
    for (const row of data.tables[table]) {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.id !== 'string' ||
        row.id.length > 128 ||
        ids.has(row.id)
      )
        throw new Error('Duplicate or invalid archive ID');
      ids.add(row.id);
      for (const column of columns[table])
        if (!(column in row)) throw new Error(`Missing ${table}.${column}`);
      for (const [key, value] of Object.entries(row)) {
        if (!columns[table].includes(key)) throw new Error(`Unexpected ${table}.${key}`);
        if (value !== null && typeof value === 'object' && !jsonFields.has(key))
          throw new Error(`Invalid ${table}.${key}`);
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid archive number');
      }
    }
  }
  const subjects = new Set(data.tables.subjects.map((row) => row.id));
  const lectures = new Set(data.tables.lectures.map((row) => row.id));
  const versions = new Map(data.tables.versions.map((row) => [row.id, row]));
  const conversations = new Set(data.tables.conversations.map((row) => row.id));
  for (const table of ['segments', 'versions', 'materials', 'gaps', 'usage', 'tasks'] as const)
    for (const row of data.tables[table])
      if (row.lectureId && !lectures.has(row.lectureId))
        throw new Error('Archive references a missing lecture');
  for (const row of [...data.tables.lectures, ...data.tables.materials])
    if (row.subjectId && !subjects.has(row.subjectId))
      throw new Error('Archive references a missing subject');
  for (const row of data.tables.versions)
    if (row.sourceVersionId && versions.get(row.sourceVersionId)?.lectureId !== row.lectureId)
      throw new Error('Invalid source version');
  for (const row of data.tables.lectures)
    if (row.activeVersionId && versions.get(row.activeVersionId)?.lectureId !== row.id)
      throw new Error('Invalid active version');
  for (const row of data.tables.messages)
    if (!conversations.has(row.conversationId)) throw new Error('Invalid conversation');
  for (const row of [...data.tables.segments, ...data.tables.materials])
    if (row.path) {
      if (!row.path.startsWith('files/') || !entries.has(safeArchivePath(row.path)))
        throw new Error('Missing or unsafe material path');
    }
  const originals = new Set<string>();
  const sequences = new Set<string>();
  for (const row of data.tables.versions)
    if (row.kind === 'original') {
      if (originals.has(row.lectureId)) throw new Error('Duplicate original transcript');
      originals.add(row.lectureId);
    }
  for (const row of data.tables.segments) {
    const key = `${row.lectureId}:${row.sequence}`;
    if (sequences.has(key) || row.end < row.start || !Number.isSafeInteger(row.sequence) || row.sequence < 0)
      throw new Error('Invalid segment ordering');
    sequences.add(key);
  }
  if (data.recoveryFiles !== undefined) {
    if (!Array.isArray(data.recoveryFiles) || data.recoveryFiles.length > 100000)
      throw new Error('Invalid recovery file list');
    const names = new Set<string>();
    for (const recovery of data.recoveryFiles) {
      const key = `${recovery.lectureId}/${recovery.name}`;
      if (
        !lectures.has(recovery.lectureId) ||
        !/^\d+-\d+\.(pcm\.part|wav)$/.test(recovery.name) ||
        !recovery.path.startsWith('files/recovery/') ||
        !entries.has(safeArchivePath(recovery.path)) ||
        names.has(key)
      )
        throw new Error('Invalid recovery file');
      names.add(key);
    }
  }
}

export class Portability {
  constructor(private store: Store) {}
  async exportLecture(
    lectureId: string,
    versionId: string | undefined,
    format: 'txt' | 'md' | 'docx' | 'pdf' | 'audio' | 'package',
    destination: string,
  ): Promise<{ path: string }> {
    const detail = this.store.lectureGet(lectureId);
    if (format === 'package') {
      await this.archive(destination, true, lectureId);
      return { path: destination };
    }
    if (format === 'audio') {
      const segments = await Promise.all(
        detail.segments
          .filter((segment) => segment.path)
          .sort((a, b) => a.sequence - b.sequence)
          .map(async (segment) => ({
            ...segment,
            path: await checkedLibraryAsset(this.store, segment.path),
          })),
      );
      if (!segments.length) throw new Error('This lecture has no saved audio');
      const original = detail.materials.filter(
        (material) => material.mime.startsWith('audio/') && material.path,
      );
      if (
        original.length === 1 &&
        segments.every((segment) => segment.path.includes(original[0].id)) &&
        path.extname(destination).toLowerCase() === path.extname(original[0].path).toLowerCase()
      ) {
        const source = await checkedLibraryAsset(this.store, original[0].path);
        await atomicFile(destination, (temporary) =>
          pipeline(createReadStream(source), createWriteStream(temporary)),
        );
      } else {
        const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-audio-'));
        try {
          const list = path.join(stage, 'sources.txt');
          await fs.writeFile(
            list,
            segments.map((segment) => `file '${segment.path.replace(/'/g, "'\\''")}'`).join('\n'),
          );
          await atomicFile(destination, (temporary) =>
            runFFmpeg([
              '-y',
              '-f',
              'concat',
              '-safe',
              '0',
              '-i',
              list,
              '-c:a',
              'pcm_s16le',
              '-f',
              'wav',
              temporary,
            ]),
          );
        } finally {
          await fs.rm(stage, { recursive: true, force: true });
        }
      }
      return { path: destination };
    }
    const version =
      detail.versions.find((item) => item.id === (versionId || detail.lecture.activeVersionId)) ||
      (!versionId ? detail.versions.find((item) => item.kind === 'original') : undefined);
    if (!version) throw new Error('Select a saved transcript or processed version to export');
    const content = version.content;
    if (format === 'txt' || format === 'md')
      await atomicFile(destination, (temporary) => fs.writeFile(temporary, content, 'utf8'));
    else if (format === 'docx') {
      const paragraphs = [
        new Paragraph({ text: detail.lecture.title, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: `${detail.lecture.date} · ${version.title}` }),
      ];
      for (const line of content.split('\n')) {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        paragraphs.push(
          heading
            ? new Paragraph({
                text: heading[2],
                heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
                  heading[1].length - 1
                ],
              })
            : new Paragraph({ children: [new TextRun(line)] }),
        );
      }
      const doc = new Document({ sections: [{ children: paragraphs }] });
      await atomicFile(destination, async (temporary) => {
        await pipeline(Packer.toStream(doc) as Readable, createWriteStream(temporary));
      });
    } else if (format === 'pdf') {
      const font = await resourceFile('fonts/NotoSans-Regular.ttf');
      await atomicFile(
        destination,
        (temporary) =>
          new Promise<void>((resolve, reject) => {
            const pdf = new PDFDocument({
              size: 'A4',
              margin: 50,
              info: { Title: detail.lecture.title, Creator: 'LectureDesk' },
            });
            const output = createWriteStream(temporary);
            output.on('finish', resolve);
            output.on('error', reject);
            pdf.on('error', reject);
            pdf.pipe(output);
            pdf.font(font).fontSize(20).text(detail.lecture.title);
            pdf
              .moveDown()
              .fontSize(10)
              .text(`${detail.lecture.date} · ${version.title}`)
              .moveDown()
              .fontSize(11)
              .text(content, { lineGap: 3 });
            pdf.end();
          }),
      );
    } else throw new Error('Unsupported export format');
    return { path: destination };
  }
  async importPackage(filename: string) {
    return this.restore(filename);
  }
  async backup(folder: string, includeAudio: boolean, retention: number): Promise<Backup> {
    const stat = await fs.stat(folder);
    if (!stat.isDirectory()) throw new Error('Backup destination is not a folder');
    const filename = `LectureDesk-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.ldbackup`;
    const destination = path.join(folder, filename);
    await this.archive(destination, includeAudio);
    const backups = await this.listBackups(folder);
    const keep = Math.max(1, Math.min(100, Math.floor(retention) || 5));
    // Prune only this application's complete archive names after a successful replacement exists.
    for (const obsolete of backups.slice(keep)) await fs.unlink(obsolete.path);
    const created = await fs.stat(destination);
    return { name: filename, path: destination, size: created.size, createdAt: created.mtime.toISOString() };
  }
  async listBackups(folder: string): Promise<Backup[]> {
    const names = await fs.readdir(folder);
    const result: Backup[] = [];
    for (const name of names.filter((name) =>
      /^LectureDesk-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}\.ldbackup$/.test(name),
    )) {
      const filename = path.join(folder, name);
      const stat = await fs.stat(filename);
      if (stat.isFile())
        result.push({ name, path: filename, size: stat.size, createdAt: stat.mtime.toISOString() });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async preview(filename: string): Promise<ArchivePreview> {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-preview-'));
    try {
      const { data, bytes } = await readArchive(filename, stage);
      return {
        kind: data.kind,
        createdAt: data.createdAt,
        lectures: data.tables.lectures.length,
        subjects: data.tables.subjects.length,
        materials: data.tables.materials.length,
        versions: data.tables.versions.length,
        audioIncluded: data.audioIncluded,
        bytes,
      };
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  async restore(filename: string): Promise<{ lectureIds: string[]; subjects: number; materials: number }> {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-restore-'));
    const destination = path.join(this.store.root, 'restored', randomUUID());
    let committed = false;
    const recoveryDirectories = new Set<string>();
    try {
      const { data } = await readArchive(filename, stage);
      const ids = new Map<string, string>();
      for (const table of tableNames) for (const row of data.tables[table]) ids.set(row.id, randomUUID());
      await fs.mkdir(destination, { recursive: true });
      try {
        await fs.cp(path.join(stage, 'files'), path.join(destination, 'files'), {
          recursive: true,
          errorOnExist: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const recovery of data.recoveryFiles || []) {
        const directory = path.join(this.store.root, 'audio', ids.get(recovery.lectureId)!);
        recoveryDirectories.add(directory);
        await fs.mkdir(directory, { recursive: true });
        await fs.copyFile(
          path.join(stage, ...recovery.path.split('/')),
          path.join(directory, recovery.name),
          1,
        );
      }
      const referenceNames = new Set([
        'id',
        'lectureId',
        'subjectId',
        'sourceVersionId',
        'activeVersionId',
        'conversationId',
        'segmentId',
        'versionId',
        'taskId',
        'previousTaskId',
        'userMessageId',
        'answerId',
        'customActionId',
        'materialId',
        'lectureIds',
        'materialIds',
        'segmentIds',
        'coverageSegmentIds',
      ]);
      const mapReferences = (value: unknown, key = ''): unknown => {
        if (typeof value === 'string') return referenceNames.has(key) ? ids.get(value) || value : value;
        if (Array.isArray(value)) return value.map((item) => mapReferences(item, key));
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([field, item]) => [
              key === 'results' ? ids.get(field) || field : field,
              mapReferences(item, field),
            ]),
          );
        return value;
      };
      this.store.transaction(() => {
        this.store.db.exec('PRAGMA defer_foreign_keys=ON');
        for (const table of tableNames) {
          for (const source of data.tables[table]) {
            const row = mapReferences(source) as Record<string, unknown>;
            if ('path' in row)
              row.path = row.path
                ? path.join(destination, ...(source as Material | Segment).path.split('/'))
                : '';
            // Restore as an independent library merge. Never resume stale live recording sessions.
            if (table === 'lectures' && ['recording', 'paused', 'importing'].includes(String(row.status)))
              row.status = 'interrupted';
            if (table === 'lectures' && row.status === 'interrupted' && !data.audioIncluded)
              row.status = 'ready';
            if (table === 'segments' && !row.path) {
              row.status = 'error';
              row.error = 'Audio was excluded from this backup';
            }
            if (table === 'materials' && !row.path) {
              row.status = 'error';
              row.error = 'Audio was excluded from this backup';
            }
            if (table === 'tasks') {
              const payload = row.payload as Record<string, unknown>;
              const linked = data.tables.segments.find(
                (segment) => ids.get(segment.id) === payload.segmentId,
              );
              if (row.status === 'running') row.status = 'queued';
              if (linked && !linked.path) {
                row.status = 'cancelled';
                row.error = 'Audio was excluded from this backup';
              }
            }
            // Deferrable foreign key checking supports source-version references in any archive order.
            const names = columns[table];
            this.store.db
              .prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
              .run(
                ...names.map((name) =>
                  jsonFields.has(name)
                    ? JSON.stringify(row[name])
                    : typeof row[name] === 'boolean'
                      ? Number(row[name])
                      : (row[name] as string | number | null),
                ),
              );
          }
        }
      });
      committed = true;
      return {
        lectureIds: data.tables.lectures.map((lecture) => ids.get(lecture.id)!),
        subjects: data.tables.subjects.length,
        materials: data.tables.materials.length,
      };
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
      if (!committed) {
        await fs.rm(destination, { recursive: true, force: true });
        for (const directory of recoveryDirectories) await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }
  private async archive(destination: string, includeAudio: boolean, lectureId?: string): Promise<void> {
    if (lectureId) await fs.mkdir(path.dirname(destination), { recursive: true });
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-snapshot-'));
    try {
      const snapshot = path.join(stage, 'library.sqlite');
      // SQLite creates a coherent snapshot while the active WAL database stays in its local folder.
      this.store.db.prepare('VACUUM INTO ?').run(snapshot);
      const database = new DatabaseSync(snapshot, { readOnly: true });
      const tables = {} as Tables;
      try {
        for (const table of tableNames)
          (tables as unknown as Record<string, unknown>)[table] = decodeRows(database, table);
      } finally {
        database.close();
      }
      if (lectureId) {
        const lecture = tables.lectures.find((item) => item.id === lectureId);
        if (!lecture) throw new Error('Lecture does not exist');
        tables.lectures = [lecture];
        tables.subjects = tables.subjects.filter((subject) => subject.id === lecture.subjectId);
        for (const table of ['segments', 'versions', 'gaps', 'usage', 'tasks'] as const)
          (tables[table] as unknown[]) = (tables[table] as { lectureId: string | null }[]).filter(
            (item) => item.lectureId === lectureId,
          );
        tables.materials = tables.materials.filter(
          (item) =>
            item.lectureId === lectureId ||
            (item.lectureId === null && item.subjectId === lecture.subjectId && lecture.subjectId !== null),
        );
        tables.actions = [];
        tables.conversations = [];
        tables.messages = [];
      }
      if (tables.lectures.some((lecture) => lecture.status === 'recording' || lecture.status === 'paused'))
        throw new Error('Stop the active recording before creating a complete archive');
      const files: { source: string; member: string }[] = [];
      const recoveryFiles: NonNullable<ArchiveData['recoveryFiles']> = [];
      if (includeAudio) {
        const registered = new Set(
          tables.segments.map((segment) => path.resolve(this.store.root, segment.path)),
        );
        for (const lecture of tables.lectures.filter((lecture) => lecture.status === 'interrupted')) {
          const directory = path.join(this.store.root, 'audio', lecture.id);
          let names: string[];
          try {
            names = await fs.readdir(directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          for (const name of names.filter((name) => /^\d+-\d+\.(pcm\.part|wav)$/.test(name))) {
            const source = await checkedLibraryAsset(this.store, path.join(directory, name));
            if (registered.has(source)) continue;
            const member = `files/recovery/${lecture.id}/${name}`;
            files.push({ source, member });
            recoveryFiles.push({ lectureId: lecture.id, path: member, name });
          }
        }
      }
      for (const table of ['segments', 'materials'] as const)
        for (const item of tables[table]) {
          if (!item.path) continue;
          const audio = table === 'segments' || ('mime' in item && item.mime.startsWith('audio/'));
          if (audio && !includeAudio) {
            item.path = '';
            continue;
          }
          const extension = path
            .extname(item.path)
            .slice(0, 16)
            .replace(/[^.a-zA-Z0-9]/g, '');
          const member = `files/${table}/${item.id}${extension}`;
          const source = await checkedLibraryAsset(this.store, item.path);
          files.push({ source, member });
          item.path = member;
        }
      const data: ArchiveData = {
        schema: 1,
        kind: lectureId ? 'lecture' : 'backup',
        createdAt: new Date().toISOString(),
        audioIncluded: includeAudio,
        tables,
        recoveryFiles,
      };
      const dataFile = path.join(stage, 'data.json');
      await fs.writeFile(dataFile, JSON.stringify(data));
      const manifest: Manifest = {
        schema: 1,
        format: 'LectureDesk',
        entries: [{ path: 'data.json', ...(await digest(dataFile)) }],
      };
      // Backups retain the coherent SQL snapshot for independent disaster recovery. Lecture packages are scoped JSON.
      if (!lectureId) manifest.entries.push({ path: 'library.sqlite', ...(await digest(snapshot)) });
      for (const file of files) manifest.entries.push({ path: file.member, ...(await digest(file.source)) });
      const manifestFile = path.join(stage, 'manifest.json');
      await fs.writeFile(manifestFile, JSON.stringify(manifest));
      const completedArchive = path.join(stage, 'complete.zip');
      await atomicFile(
        completedArchive,
        (temporary) =>
          new Promise<void>((resolve, reject) => {
            const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
            const archive = archiver('zip', { zlib: { level: 6 } });
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
            archive.on('warning', reject);
            archive.pipe(output);
            archive.file(manifestFile, { name: 'manifest.json' });
            archive.file(dataFile, { name: 'data.json' });
            if (!lectureId) archive.file(snapshot, { name: 'library.sqlite' });
            for (const file of files) archive.file(file.source, { name: file.member });
            void archive.finalize().catch(reject);
          }),
      );
      // Build the whole archive outside the synchronized destination. Usually its final move is a single atomic rename.
      // A different volume requires a .part copy; only the final verified extension becomes a backup candidate.
      try {
        await fs.rename(completedArchive, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await atomicFile(destination, (temporary) => fs.copyFile(completedArchive, temporary));
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
}
