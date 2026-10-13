import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { Store } from '../src/main/store.js';
import { Portability, safeArchivePath } from '../src/main/portability.js';

async function entries(filename: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) =>
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const result = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            result.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        }),
      );
      zip.on('end', () => resolve(result));
      zip.readEntry();
    }),
  );
}
async function zipEntries(filename: string, items: Map<string, Buffer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(filename);
    const zip = archiver('zip');
    zip.on('error', reject);
    output.on('error', reject);
    output.on('close', resolve);
    zip.pipe(output);
    for (const [name, data] of items) zip.append(data, { name });
    void zip.finalize().catch(reject);
  });
}
describe('verified portable archives and atomic backups', () => {
  let directory: string;
  let store: Store;
  let portability: Portability;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-portability-test-'));
    store = new Store(path.join(directory, 'library'));
    portability = new Portability(store);
  });
  afterEach(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function sample() {
    const subject = store.subjectSave({ name: 'Українська фізика' });
    const lecture = store.lectureCreate({ subjectId: subject.id, title: 'Термодинаміка' });
    await fs.mkdir(path.join(store.root, 'audio'), { recursive: true });
    const audio = path.join(store.root, 'audio', 'audio.wav');
    await fs.writeFile(audio, Buffer.from('original-audio-bytes'));
    const segment = store.segmentSave({
      id: randomUUID(),
      lectureId: lecture.id,
      sequence: 0,
      start: 0,
      end: 10,
      path: audio,
      text: 'Original segment',
      status: 'done',
      error: null,
    });
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Оригінальний текст',
    });
    const notes = store.versionSave({
      lectureId: lecture.id,
      kind: 'notes',
      title: 'Notes',
      content: 'Похідні нотатки',
      sourceVersionId: original.id,
    });
    await fs.mkdir(path.join(store.root, 'materials'), { recursive: true });
    const materialPath = path.join(store.root, 'materials', 'material.txt');
    await fs.writeFile(materialPath, 'Матеріали');
    const material = store.materialSave({
      id: randomUUID(),
      lectureId: lecture.id,
      subjectId: subject.id,
      name: 'material.txt',
      path: materialPath,
      mime: 'text/plain',
      size: Buffer.byteLength('Матеріали'),
      status: 'ready',
      error: null,
      pages: [{ page: 1, text: 'Матеріали', ocr: false }],
      createdAt: new Date().toISOString(),
    });
    return { subject, lecture, original, notes, material, segment };
  }
  it('exports and reimports a complete lecture with remapped IDs and linked immutable originals', async () => {
    const original = await sample();
    const filename = path.join(directory, 'lecture.ldlecture');
    await portability.exportLecture(original.lecture.id, original.notes.id, 'package', filename);
    expect(await portability.preview(filename)).toMatchObject({
      kind: 'lecture',
      lectures: 1,
      subjects: 1,
      materials: 1,
      versions: 2,
      audioIncluded: true,
    });
    const imported = await portability.importPackage(filename);
    expect(imported.lectureIds[0]).not.toBe(original.lecture.id);
    const detail = store.lectureGet(imported.lectureIds[0]);
    const restoredOriginal = detail.versions.find((version) => version.kind === 'original')!;
    const restoredNotes = detail.versions.find((version) => version.kind === 'notes')!;
    expect(restoredOriginal.content).toBe(original.original.content);
    expect(restoredNotes.sourceVersionId).toBe(restoredOriginal.id);
    expect(detail.lecture.activeVersionId).toBe(restoredNotes.id);
    expect(await fs.readFile(detail.segments[0].path, 'utf8')).toBe('original-audio-bytes');
    expect(await fs.readFile(detail.materials[0].path, 'utf8')).toBe('Матеріали');
    expect(store.lectureGet(original.lecture.id).versions).toHaveLength(2);
    expect(store.snapshot().lectures).toHaveLength(2);
  });
  it('makes a coherent SQLite backup without credentials, preserves chats and restores as a merge', async () => {
    const sampleData = await sample();
    const conversation = store.conversationCreate(
      {
        scope: 'lecture',
        lectureIds: [sampleData.lecture.id],
        subjectId: null,
        materialIds: [sampleData.material.id],
      },
      'strict',
      'Physics',
    );
    store.messageSave({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Answer',
      sources: [{ title: 'Original', lectureId: sampleData.lecture.id, start: 0 }],
      createdAt: new Date().toISOString(),
    });
    await fs.writeFile(path.join(store.baseRoot, 'key.enc'), 'sk-secret-never-archive');
    store.saveSettings({ setupComplete: false, ...{ apiKey: 'sk-secret-never-archive' } });
    const folder = path.join(directory, 'backups');
    await fs.mkdir(folder);
    const backup = await portability.backup(folder, true, 5);
    const contents = await entries(backup.path);
    expect(contents.has('library.sqlite')).toBe(true);
    expect([...contents.values()].some((data) => data.includes('sk-secret-never-archive'))).toBe(false);
    expect(await portability.preview(backup.path)).toMatchObject({
      kind: 'backup',
      lectures: 1,
      audioIncluded: true,
    });
    const restored = await portability.restore(backup.path);
    expect(store.snapshot().lectures).toHaveLength(2);
    const importedChat = store.conversations().find((item) => item.id !== conversation.id)!;
    expect(importedChat.context.lectureIds).toEqual(restored.lectureIds);
    expect(store.messages(importedChat.id)[0].sources[0].lectureId).toBe(restored.lectureIds[0]);
  });
  it('explicitly marks omitted audio unavailable and retains only successful backup history', async () => {
    await sample();
    const folder = path.join(directory, 'backups');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'unrelated.zip'), 'keep');
    const backup = await portability.backup(folder, false, 1);
    const restored = await portability.restore(backup.path);
    expect(store.lectureGet(restored.lectureIds[0]).segments[0]).toMatchObject({
      path: '',
      status: 'error',
      error: 'Audio was excluded from this backup',
    });
    await portability.backup(folder, true, 1);
    expect(await portability.listBackups(folder)).toHaveLength(1);
    expect(await fs.readFile(path.join(folder, 'unrelated.zip'), 'utf8')).toBe('keep');
    expect((await fs.readdir(folder)).some((name) => name.endsWith('.part'))).toBe(false);
  });
  it('remaps pending AI message, dependency and paid transcription checkpoint references on restore', async () => {
    const data = await sample();
    const conversation = store.conversationCreate(
      {
        scope: 'lecture',
        lectureIds: [data.lecture.id],
        subjectId: null,
        materialIds: [],
      },
      'strict',
    );
    const user = store.messageSave({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      content: 'Explain the lecture',
      sources: [],
      createdAt: new Date().toISOString(),
    });
    const answer = store.messageSave({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: 'A completed paid answer',
      sources: [],
      createdAt: new Date().toISOString(),
    });
    const previous = store.taskAdd('live-translation', data.lecture.id, { segmentIds: [data.segment.id] });
    store.taskUpdate(previous.id, { status: 'done' });
    const next = store.taskAdd('live-translation', data.lecture.id, { previousTaskId: previous.id });
    const chat = store.taskAdd('chat', data.lecture.id, {
      conversationId: conversation.id,
      userMessageId: user.id,
      answerId: answer.id,
    });
    store.taskUpdate(chat.id, { status: 'running' });
    store.taskAdd('improve', data.lecture.id, {
      sourceVersionId: data.original.id,
      segmentIds: [data.segment.id],
      coverageSegmentIds: [data.segment.id],
      results: { [data.segment.id]: 'Completed paid audio transcript' },
    });
    const folder = path.join(directory, 'backups');
    await fs.mkdir(folder);
    const backup = await portability.backup(folder, true, 5);
    const restored = await portability.restore(backup.path);
    const id = restored.lectureIds[0];
    const detail = store.lectureGet(id);
    const tasks = store.tasks().filter((task) => task.lectureId === id);
    const restoredPrevious = tasks.find(
      (task) => task.kind === 'live-translation' && task.status === 'done',
    )!;
    const restoredNext = tasks.find((task) => task.kind === 'live-translation' && task.status === 'queued')!;
    expect(restoredNext.id).not.toBe(next.id);
    expect(restoredNext.payload.previousTaskId).toBe(restoredPrevious.id);
    const restoredChat = tasks.find((task) => task.kind === 'chat')!;
    expect(restoredChat.status).toBe('queued');
    const messages = store.messages(String(restoredChat.payload.conversationId));
    expect(messages.find((message) => message.id === restoredChat.payload.userMessageId)?.content).toBe(
      user.content,
    );
    expect(messages.find((message) => message.id === restoredChat.payload.answerId)?.content).toBe(
      answer.content,
    );
    const improved = tasks.find((task) => task.kind === 'improve')!;
    expect(improved.payload.segmentIds).toEqual([detail.segments[0].id]);
    expect(improved.payload.coverageSegmentIds).toEqual([detail.segments[0].id]);
    expect(improved.payload.results).toEqual({ [detail.segments[0].id]: 'Completed paid audio transcript' });
    expect(improved.payload.sourceVersionId).toBe(
      detail.versions.find((version) => version.kind === 'original')!.id,
    );
  });
  it('rejects corruption before mutating the library and removes staged files', async () => {
    const sampleData = await sample();
    const filename = path.join(directory, 'lecture.ldlecture');
    await portability.exportLecture(sampleData.lecture.id, undefined, 'package', filename);
    const contents = await entries(filename);
    const data = JSON.parse(contents.get('data.json')!.toString());
    data.tables.lectures[0].title = 'Tampered';
    contents.set('data.json', Buffer.from(JSON.stringify(data)));
    const corrupt = path.join(directory, 'corrupt.zip');
    await zipEntries(corrupt, contents);
    await expect(portability.restore(corrupt)).rejects.toThrow(/Integrity/);
    expect(store.snapshot().lectures).toHaveLength(1);
    expect(await fs.readdir(path.join(store.root, 'restored')).catch(() => [])).toHaveLength(0);
  });
  it('rejects traversal, absolute paths and cross-platform path attacks', () => {
    for (const member of [
      '../escape',
      'files/../../escape',
      '/tmp/escape',
      'C:/escape',
      'files\\..\\escape',
      'files//escape',
      'files/./escape',
      'files/\0escape',
    ])
      expect(() => safeArchivePath(member)).toThrow();
    expect(safeArchivePath('files/materials/example.txt')).toBe('files/materials/example.txt');
  });
  it('keeps an existing destination intact if source data is unavailable', async () => {
    const sampleData = await sample();
    await fs.unlink(sampleData.material.path);
    const destination = path.join(directory, 'existing.zip');
    await fs.writeFile(destination, 'previous successful export');
    await expect(
      portability.exportLecture(sampleData.lecture.id, undefined, 'package', destination),
    ).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous successful export');
  });
  it('blocks asset references or symlinks that would archive credential files', async () => {
    const sampleData = await sample();
    const credential = path.join(store.root, 'key.enc');
    await fs.writeFile(credential, 'sk-private');
    store.db.prepare('UPDATE materials SET path=? WHERE id=?').run(credential, sampleData.material.id);
    await expect(
      portability.exportLecture(
        sampleData.lecture.id,
        undefined,
        'package',
        path.join(directory, 'unsafe.zip'),
      ),
    ).rejects.toThrow(/content directories/);
    const link = path.join(store.root, 'materials', 'secret-link.txt');
    await fs.symlink(credential, link);
    store.db.prepare('UPDATE materials SET path=? WHERE id=?').run(link, sampleData.material.id);
    await expect(
      portability.exportLecture(
        sampleData.lecture.id,
        undefined,
        'package',
        path.join(directory, 'unsafe-link.zip'),
      ),
    ).rejects.toThrow(/content directories/);
  });
  it('scopes lecture packages without pulling in files attached to other lectures in the subject', async () => {
    const sampleData = await sample();
    const other = store.lectureCreate({ subjectId: sampleData.subject.id, title: 'Other lecture' });
    store.materialSave({
      ...sampleData.material,
      id: randomUUID(),
      lectureId: other.id,
      name: 'Other lecture file',
    });
    const shared = store.materialSave({
      ...sampleData.material,
      id: randomUUID(),
      lectureId: null,
      name: 'Shared subject file',
    });
    const filename = path.join(directory, 'scoped.ldlecture');
    await portability.exportLecture(sampleData.lecture.id, undefined, 'package', filename);
    expect(await portability.preview(filename)).toMatchObject({ lectures: 1, materials: 2 });
    const imported = await portability.importPackage(filename);
    expect(store.lectureGet(imported.lectureIds[0]).materials).toHaveLength(1);
    expect(store.materials().filter((material) => material.name === shared.name)).toHaveLength(2);
  });
  it('preserves recoverable crash-tail PCM batches with remapped lecture folders', async () => {
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'interrupted', duration: 2 });
    const audio = path.join(store.root, 'audio', lecture.id);
    await fs.mkdir(audio, { recursive: true });
    const tail = Buffer.alloc(96000, 17);
    await fs.writeFile(path.join(audio, '000000-0.pcm.part'), tail);
    const folder = path.join(directory, 'backups');
    await fs.mkdir(folder);
    const backup = await portability.backup(folder, true, 5);
    const restored = await portability.restore(backup.path);
    const newId = restored.lectureIds[0];
    expect(store.lectureGet(newId).lecture.status).toBe('interrupted');
    expect(await fs.readFile(path.join(store.root, 'audio', newId, '000000-0.pcm.part'))).toEqual(tail);
    expect(store.snapshot().recoverable.map((item) => item.id)).toContain(newId);
  });
  it('refuses a recording snapshot rather than silently omitting the active audio tail', async () => {
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    const folder = path.join(directory, 'backups');
    await fs.mkdir(folder);
    await expect(portability.backup(folder, true, 5)).rejects.toThrow(/Stop the active recording/);
    expect(await fs.readdir(folder)).toHaveLength(0);
  });
});
