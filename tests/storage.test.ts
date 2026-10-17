import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store.js';
import { LocalRetrieval } from '../src/main/ai-retrieval.js';

// Version one blocked every deletion of an original transcript, even for lectures in Trash.
const VERSION_ONE_ORIGINAL_DELETE =
  "CREATE TRIGGER original_delete BEFORE DELETE ON versions WHEN OLD.kind='original' BEGIN SELECT RAISE(ABORT,'Original transcripts are immutable'); END;";
function downgradeToVersionOne(store: Store) {
  store.db.exec(`DROP TRIGGER original_delete; ${VERSION_ONE_ORIGINAL_DELETE} PRAGMA user_version=1;`);
}
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
describe('local durable library', () => {
  let directory: string;
  let store: Store;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-store-test-'));
    store = new Store(directory);
  });
  afterEach(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('orphans lectures safely when deleting a subject and supports trash recovery', () => {
    const subject = store.subjectSave({ name: 'Physics' });
    const lecture = store.lectureCreate({ subjectId: subject.id, title: 'Lecture 1' });
    store.subjectDelete(subject.id);
    expect(store.lectureGet(lecture.id).lecture.subjectId).toBeNull();
    store.lectureTrash(lecture.id);
    expect(store.lectureGet(lecture.id).lecture.deletedAt).not.toBeNull();
    store.lectureRestore(lecture.id);
    expect(store.lectureGet(lecture.id).lecture.deletedAt).toBeNull();
  });
  it('preserves finalized originals through actions and direct SQL mutation', () => {
    const lecture = store.lectureCreate();
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Actual speech',
    });
    const edited = store.versionSave({
      lectureId: lecture.id,
      kind: 'edited',
      title: 'My edit',
      content: 'Corrected text',
      sourceVersionId: original.id,
    });
    expect(store.lectureGet(lecture.id).versions.find((version) => version.id === original.id)?.content).toBe(
      'Actual speech',
    );
    expect(store.lectureGet(lecture.id).lecture.activeVersionId).toBe(edited.id);
    expect(() =>
      store.versionSave({ lectureId: lecture.id, kind: 'original', title: 'Another', content: 'Overwrite' }),
    ).toThrow(/original/i);
    expect(() =>
      store.db.prepare('UPDATE versions SET content=? WHERE id=?').run('Overwrite', original.id),
    ).toThrow(/immutable/i);
    expect(() => store.db.prepare('DELETE FROM versions WHERE id=?').run(original.id)).toThrow(/immutable/i);
    expect(
      store.versionSave({ lectureId: lecture.id, kind: 'original', title: 'Retry', content: 'Actual speech' })
        .id,
    ).toBe(original.id);
  });
  it('rejects activating and deriving a version from another lecture', () => {
    const a = store.lectureCreate();
    const b = store.lectureCreate();
    const version = store.versionSave({ lectureId: a.id, kind: 'edited', title: 'A', content: 'Text' });
    expect(() => store.versionActivate(b.id, version.id)).toThrow();
    expect(() =>
      store.versionSave({
        lectureId: b.id,
        kind: 'notes',
        title: 'B',
        content: 'Notes',
        sourceVersionId: version.id,
      }),
    ).toThrow();
  });
  it('requeues interrupted jobs, preserves stable audio order and identifies crash recovery', () => {
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    for (const sequence of [2, 0, 1])
      store.segmentSave({
        id: randomUUID(),
        lectureId: lecture.id,
        sequence,
        start: sequence * 10,
        end: (sequence + 1) * 10,
        path: `${sequence}.wav`,
        text: `${sequence}`,
        status: 'done',
        error: null,
      });
    const task = store.taskAdd('transcribe', lecture.id, { segmentId: 'x' }, 'same');
    store.taskUpdate(task.id, { status: 'running', attempts: 2 });
    store.close();
    store = new Store(directory);
    expect(store.snapshot().recoverable.map((item) => item.id)).toEqual([lecture.id]);
    expect(store.tasks()[0]).toMatchObject({ id: task.id, status: 'queued', attempts: 2 });
    expect(store.lectureGet(lecture.id).segments.map((item) => item.sequence)).toEqual([0, 1, 2]);
  });
  it('deduplicates durable tasks even after completion and only allows known settings', () => {
    const lecture = store.lectureCreate();
    const task = store.taskAdd('action', lecture.id, { text: 'x' }, 'action:fingerprint');
    store.taskUpdate(task.id, { status: 'done', payload: { text: 'updated' } });
    expect(store.taskAdd('action', lecture.id, { text: 'x' }, 'action:fingerprint')).toMatchObject({
      id: task.id,
      status: 'done',
      payload: { text: 'updated' },
    });
    store.saveSettings({ uiLanguage: 'uk', ...{ apiKey: 'sk-do-not-store', secret: 'secret' } });
    expect(JSON.stringify(store.settings())).not.toContain('sk-do-not-store');
    expect(JSON.stringify(store.db.prepare('SELECT * FROM settings').all())).not.toContain('sk-do-not-store');
  });
  it('rolls back a compound write instead of leaving partial records', () => {
    expect(() =>
      store.transaction(() => {
        store.subjectSave({ name: 'Should roll back' });
        throw new Error('Simulated disk failure');
      }),
    ).toThrow();
    expect(store.snapshot().subjects).toHaveLength(0);
  });
  it('repairs a version-one missing settings singleton without resetting library records', () => {
    const subject = store.subjectSave({ name: 'Preserved subject' });
    const lecture = store.lectureCreate({ subjectId: subject.id, title: 'Preserved lecture' });
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Preserved original',
    });
    store.db.prepare('DELETE FROM settings WHERE id=1').run();
    downgradeToVersionOne(store);
    store.close();
    store = new Store(directory);
    expect(store.settings()).toMatchObject({ setupComplete: false, storageFolder: directory });
    expect(store.snapshot().subjects[0].id).toBe(subject.id);
    expect(store.lectureGet(lecture.id).versions[0]).toMatchObject({
      id: original.id,
      content: 'Preserved original',
    });
    expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
  });
  it('commits settings and schema version together and preserves existing settings on reopening', () => {
    expect(store.db.prepare('SELECT count(*) AS count FROM settings').get()).toMatchObject({ count: 1 });
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    store.saveSettings({ uiLanguage: 'pl', outputLanguage: 'uk' });
    store.close();
    store = new Store(directory);
    expect(store.settings()).toMatchObject({ uiLanguage: 'pl', outputLanguage: 'uk' });
  });
  it('migrates a version-one library to the current version and only then allows purging trashed originals', () => {
    const lecture = store.lectureCreate({ title: 'Trashed in version one' });
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Speech',
    });
    store.lectureTrash(lecture.id);
    downgradeToVersionOne(store);
    expect(() => store.db.prepare('DELETE FROM versions WHERE id=?').run(original.id)).toThrow(/immutable/i);
    store.close();
    store = new Store(directory);
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    const trigger = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='original_delete'")
      .get() as { sql: string };
    expect(trigger.sql).toMatch(/deletedAt IS NOT NULL/);
    expect(store.lectureGet(lecture.id).versions).toMatchObject([{ id: original.id, content: 'Speech' }]);
    // Originals of trashed lectures remain unmodifiable; only permanent deletion is unlocked.
    expect(() =>
      store.db.prepare('UPDATE versions SET content=? WHERE id=?').run('Overwrite', original.id),
    ).toThrow(/immutable/i);
    store.lecturePurge(lecture.id);
    expect(() => store.lectureGet(lecture.id)).toThrow(/does not exist/);
  });
  it('migrates version two to three: transcript items table and an explicit lecture language', () => {
    const lecture = store.lectureCreate();
    // A version-two library: no items table, 'auto' lecture language, old default live model.
    const legacy = {
      ...store.settings(),
      setupComplete: true,
      uiLanguage: 'uk',
      lectureLanguage: 'auto',
      liveModel: 'gpt-live-transcribe',
    } as Record<string, unknown>;
    delete legacy.lectureLanguageConfirmed;
    store.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(legacy));
    store.db.exec('DROP TABLE transcript_items; PRAGMA user_version=2;');
    store.close();
    store = new Store(directory);
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    expect(store.settings()).toMatchObject({
      lectureLanguage: 'uk',
      lectureLanguageConfirmed: false,
      liveModel: 'gpt-4o-transcribe',
    });
    const item = {
      lectureId: lecture.id,
      start: 12.5,
      end: 15,
      text: 'Перша фраза.',
      status: 'done' as const,
      source: 'live' as const,
      model: 'gpt-4o-transcribe',
      language: 'uk',
      error: null,
      sourceKey: 'live:window:item_1',
    };
    const saved = store.itemSave(item);
    // Saving the same turn again (duplicate completion) keeps the first row.
    expect(store.itemSave({ ...item, text: 'Duplicate' })).toEqual(saved);
    store.itemSave({ ...item, start: 2, end: 4, text: 'Earlier.', sourceKey: 'range:task:0' });
    expect(store.lectureGet(lecture.id).items.map((row) => row.text)).toEqual(['Earlier.', 'Перша фраза.']);
    store.itemUpdate(saved.id, { status: 'rejected', error: 'Not in Ukrainian' });
    expect(store.lectureGet(lecture.id).items[1]).toMatchObject({ status: 'rejected', error: 'Not in Ukrainian' });
  });
  it('migrates a version-one library with an explicit lecture language as confirmed', () => {
    const legacy = { ...store.settings(), setupComplete: true, lectureLanguage: 'pl', liveModel: 'gpt-transcribe' };
    delete (legacy as Record<string, unknown>).lectureLanguageConfirmed;
    store.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(legacy));
    store.db.exec('DROP TABLE transcript_items;');
    downgradeToVersionOne(store);
    store.close();
    store = new Store(directory);
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    expect(store.settings()).toMatchObject({
      lectureLanguage: 'pl',
      lectureLanguageConfirmed: true,
      liveModel: 'gpt-transcribe',
    });
    // A stray 'auto' written later never reaches a request.
    store.db
      .prepare('UPDATE settings SET data=? WHERE id=1')
      .run(JSON.stringify({ ...store.settings(), lectureLanguage: 'auto', lectureLanguageConfirmed: true }));
    expect(store.settings()).toMatchObject({ lectureLanguage: store.settings().uiLanguage, lectureLanguageConfirmed: false });
  });
  it('refuses to open a library written by a newer schema and releases the database file', async () => {
    store.db.exec('PRAGMA user_version=99');
    store.close();
    expect(() => new Store(directory)).toThrow(/newer version/);
    // The failed open must not keep the file locked (Windows) — it can be reopened and repaired.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path.join(directory, 'library.sqlite'));
    raw.exec('PRAGMA user_version=2');
    raw.close();
    // Re-running the 2 → 3 step over an existing items table is harmless.
    store = new Store(directory);
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
  });
  it('permanently deletes a trashed lecture with its original, derived rows, chat index and files', async () => {
    const outsideFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-outside-'));
    try {
      const root = store.root;
      const keep = store.lectureCreate({ title: 'Keep' });
      const keepOriginal = store.versionSave({
        lectureId: keep.id,
        kind: 'original',
        title: 'Original',
        content: 'Unrelated speech',
      });
      const lecture = store.lectureCreate({ title: 'Purge me' });
      const audioFolder = path.join(root, 'audio', lecture.id);
      await fs.mkdir(audioFolder, { recursive: true });
      const recorded = path.join(audioFolder, '000000.wav');
      await fs.writeFile(recorded, 'pcm');
      await fs.writeFile(path.join(audioFolder, '000001-0.pcm.part'), 'unregistered crash tail');
      const importedFolder = path.join(root, 'lectures', lecture.id, 'imported-audio', 'material');
      await fs.mkdir(importedFolder, { recursive: true });
      const imported = path.join(importedFolder, '000000.wav');
      await fs.writeFile(imported, 'wav');
      const segment = store.segmentSave({
        id: randomUUID(),
        lectureId: lecture.id,
        sequence: 0,
        start: 0,
        end: 10,
        path: recorded,
        text: 'Purged speech',
        status: 'done',
        error: null,
      });
      store.segmentSave({ ...segment, id: randomUUID(), sequence: 1, start: 10, end: 20, path: imported });
      const materialId = randomUUID();
      const materialFolder = path.join(root, 'materials', materialId);
      await fs.mkdir(materialFolder, { recursive: true });
      const materialFile = path.join(materialFolder, 'original.txt');
      await fs.writeFile(materialFile, 'slides');
      const material = {
        id: materialId,
        lectureId: lecture.id,
        subjectId: null,
        name: 'slides.txt',
        path: materialFile,
        mime: 'text/plain',
        size: 6,
        status: 'ready' as const,
        error: null,
        pages: [{ page: 1, text: 'Purged slides', ocr: false }],
        createdAt: new Date().toISOString(),
      };
      store.materialSave(material);
      // Rows that point at the database or outside the library must never delete those files.
      const outsideFile = path.join(outsideFolder, 'personal.txt');
      await fs.writeFile(outsideFile, 'not library content');
      store.materialSave({ ...material, id: randomUUID(), path: outsideFile, pages: [] });
      store.materialSave({ ...material, id: randomUUID(), path: store.databasePath, pages: [] });
      const original = store.versionSave({
        lectureId: lecture.id,
        kind: 'original',
        title: 'Original',
        content: 'Purged speech',
      });
      const notes = store.versionSave({
        lectureId: lecture.id,
        kind: 'notes',
        title: 'Notes',
        content: 'Purged notes',
        sourceVersionId: original.id,
      });
      store.versionSave({
        lectureId: lecture.id,
        kind: 'edited',
        title: 'Edit',
        content: 'Purged edit',
        sourceVersionId: notes.id,
      });
      store.gap(lecture.id, 5, 'Recording paused by user');
      store.usageSave(lecture.id, 'transcribe', 'gpt-transcribe', { seconds: 10 });
      store.taskAdd('translation', lecture.id, { segmentIds: [segment.id] }, `translation:${lecture.id}`);
      store.itemSave({
        lectureId: lecture.id,
        start: 1,
        end: 3,
        text: 'Purged live turn',
        status: 'done',
        source: 'live',
        model: 'gpt-4o-transcribe',
        language: 'en',
        error: null,
        sourceKey: 'live:window:item',
      });
      new LocalRetrieval(store).sync({ scope: 'library', lectureIds: [], subjectId: null, materialIds: [] });
      const indexed = (key: string) =>
        (
          store.db.prepare('SELECT count(*) AS n FROM ai_passages WHERE sourceKey=?').get(key) as {
            n: number;
          }
        ).n;
      const sources = (key: string) =>
        (
          store.db.prepare('SELECT count(*) AS n FROM ai_index_sources WHERE sourceKey=?').get(key) as {
            n: number;
          }
        ).n;
      expect(indexed(`lecture:${lecture.id}`)).toBeGreaterThan(0);
      expect(indexed(`material:${materialId}`)).toBeGreaterThan(0);

      expect(() => store.lecturePurge(lecture.id)).toThrow(/Trash/);
      store.lectureTrash(lecture.id);
      store.lecturePurge(lecture.id);

      expect(() => store.lectureGet(lecture.id)).toThrow(/does not exist/);
      for (const table of ['segments', 'transcript_items', 'versions', 'materials', 'gaps', 'usage', 'tasks'])
        expect(
          store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE lectureId=?`).get(lecture.id),
        ).toMatchObject({ n: 0 });
      for (const key of [`lecture:${lecture.id}`, `material:${materialId}`]) {
        expect(indexed(key)).toBe(0);
        expect(sources(key)).toBe(0);
      }
      expect(
        store.db
          .prepare("SELECT count(*) AS n FROM ai_passage_fts WHERE ai_passage_fts MATCH 'purged'")
          .get(),
      ).toMatchObject({ n: 0 });
      expect(await exists(audioFolder)).toBe(false);
      expect(await exists(path.join(root, 'lectures', lecture.id))).toBe(false);
      expect(await exists(materialFolder)).toBe(false);
      expect(await exists(path.join(root, 'materials'))).toBe(true);
      expect(await fs.readFile(outsideFile, 'utf8')).toBe('not library content');
      expect(await exists(store.databasePath)).toBe(true);
      // Deleted text is overwritten in the database file and the WAL is flushed.
      for (const file of [store.databasePath, `${store.databasePath}-wal`])
        expect((await fs.readFile(file).catch(() => Buffer.alloc(0))).includes('Purged notes')).toBe(false);
      expect(store.lectureGet(keep.id).versions).toMatchObject([{ id: keepOriginal.id }]);
      expect(indexed(`lecture:${keep.id}`)).toBeGreaterThan(0);
    } finally {
      await fs.rm(outsideFolder, { recursive: true, force: true });
    }
  });
  it('keeps originals of lectures outside Trash immutable and refuses to purge them', () => {
    const lecture = store.lectureCreate();
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Speech',
    });
    expect(() => store.db.prepare('DELETE FROM versions WHERE id=?').run(original.id)).toThrow(/immutable/i);
    expect(() => store.lecturePurge(lecture.id)).toThrow(/Trash/);
    expect(() => store.lecturePurge('missing-lecture')).toThrow(/does not exist/);
    store.lectureTrash(lecture.id);
    store.lectureRestore(lecture.id);
    expect(() => store.db.prepare('DELETE FROM versions WHERE id=?').run(original.id)).toThrow(/immutable/i);
    expect(store.lectureGet(lecture.id).versions).toMatchObject([{ id: original.id, content: 'Speech' }]);
  });
  it('empties the whole trash at once and deletes nothing while a trashed lecture is importing', () => {
    const lectures = ['A', 'B', 'C'].map((title) => {
      const lecture = store.lectureCreate({ title });
      store.versionSave({ lectureId: lecture.id, kind: 'original', title: 'Original', content: title });
      return lecture;
    });
    store.lectureTrash(lectures[0].id);
    store.lectureTrash(lectures[1].id);
    store.lectureSave({ id: lectures[1].id, status: 'importing' });
    expect(() => store.trashEmpty()).toThrow(/import/);
    expect(store.snapshot().lectures).toHaveLength(3);
    expect(store.lectureGet(lectures[0].id).versions).toHaveLength(1);
    store.lectureSave({ id: lectures[1].id, status: 'ready' });
    expect(store.trashEmpty()).toEqual({ count: 2 });
    expect(store.snapshot().lectures.map((lecture) => lecture.id)).toEqual([lectures[2].id]);
    expect(store.trashEmpty()).toEqual({ count: 0 });
  });
});
