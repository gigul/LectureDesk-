import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store.js';

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
    store.close();
    store = new Store(directory);
    expect(store.settings()).toMatchObject({ setupComplete: false, storageFolder: directory });
    expect(store.snapshot().subjects[0].id).toBe(subject.id);
    expect(store.lectureGet(lecture.id).versions[0]).toMatchObject({
      id: original.id,
      content: 'Preserved original',
    });
    expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
  });
  it('commits settings and schema version together and preserves existing settings on reopening', () => {
    expect(store.db.prepare('SELECT count(*) AS count FROM settings').get()).toMatchObject({ count: 1 });
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    store.saveSettings({ uiLanguage: 'pl', outputLanguage: 'uk' });
    store.close();
    store = new Store(directory);
    expect(store.settings()).toMatchObject({ uiLanguage: 'pl', outputLanguage: 'uk' });
  });
});
