import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import { createCanvas } from '@napi-rs/canvas';
import { Store } from '../src/main/store.js';
import { MaterialService, runFFmpeg } from '../src/main/materials.js';
import { Portability } from '../src/main/portability.js';

describe('real imported material processing', () => {
  let directory: string;
  let store: Store;
  let service: MaterialService;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturedesk-material-test-'));
    store = new Store(path.join(directory, 'library'));
    service = new MaterialService(store, () => {});
  });
  afterEach(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('preserves imported originals independently of the source and retries from that original', async () => {
    const input = path.join(directory, 'notes.md');
    await fs.writeFile(input, '# Первинний матеріал\nЗміст');
    const [material] = await service.importPaths([input]);
    expect(material).toMatchObject({
      status: 'ready',
      pages: [{ page: 1, text: '# Первинний матеріал\nЗміст', ocr: false }],
    });
    await fs.writeFile(input, 'Changed external file');
    await service.retry(material.id);
    expect(await fs.readFile(material.path, 'utf8')).toBe('# Первинний матеріал\nЗміст');
    expect(store.materials()[0].pages[0].text).toContain('Первинний');
  });
  it('preserves corrupt documents and exposes a retryable error instead of reporting success', async () => {
    const input = path.join(directory, 'broken.docx');
    await fs.writeFile(input, 'not an office archive');
    const [material] = await service.importPaths([input]);
    expect(material.status).toBe('error');
    expect(material.error).toBeTruthy();
    expect(await fs.readFile(material.path, 'utf8')).toBe('not an office archive');
  });
  it('preserves slide numbers and XML text from presentations', async () => {
    const input = path.join(directory, 'slides.pptx');
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(input);
      const zip = archiver('zip');
      output.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(output);
      zip.append('<p:sld><p:sp><a:p><a:r><a:t>Second &amp; more</a:t></a:r></a:p></p:sp></p:sld>', {
        name: 'ppt/slides/slide2.xml',
      });
      zip.append('<p:sld><p:sp><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sp></p:sld>', {
        name: 'ppt/slides/slide1.xml',
      });
      void zip.finalize().catch(reject);
    });
    const [material] = await service.importPaths([input]);
    expect(material.status).toBe('ready');
    expect(material.pages).toEqual([
      { page: 1, text: 'First slide', ocr: false },
      { page: 2, text: 'Second & more', ocr: false },
    ]);
  });
  it('runs bundled ffmpeg and splits long audio into sample-contiguous independent queued WAVs', async () => {
    const input = path.join(directory, 'source.wav');
    await runFFmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=24000:duration=301',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      input,
    ]);
    const [material] = await service.importPaths([input]);
    expect(material.status).toBe('ready');
    const detail = store.lectureGet(material.lectureId!);
    expect(detail.segments).toHaveLength(2);
    expect(detail.segments[0].start).toBe(0);
    expect(detail.segments[1].start).toBe(detail.segments[0].end);
    expect(detail.segments[1].end).toBeCloseTo(301, 5);
    expect(detail.lecture.duration).toBeCloseTo(301, 5);
    expect(store.tasks().filter((task) => task.kind === 'transcribe')).toHaveLength(2);
    await service.retry(material.id);
    expect(store.lectureGet(material.lectureId!).segments).toHaveLength(2);
    expect(store.tasks()).toHaveLength(2);
    const exported = path.join(directory, 'exported.wav');
    await new Portability(store).exportLecture(material.lectureId!, undefined, 'audio', exported);
    expect(
      createHash('sha256')
        .update(await fs.readFile(exported))
        .digest('hex'),
    ).toEqual(
      createHash('sha256')
        .update(await fs.readFile(input))
        .digest('hex'),
    );
  });
  it('exports real DOCX and multilingual PDF and extracts the text back from each', async () => {
    const lecture = store.lectureCreate({ title: 'Фізика / Fizyka' });
    const version = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Українська лекція. Русский текст. English lecture. Polski wykład.',
    });
    const portability = new Portability(store);
    const docx = path.join(directory, 'export.docx'),
      pdf = path.join(directory, 'export.pdf');
    await portability.exportLecture(lecture.id, version.id, 'docx', docx);
    await portability.exportLecture(lecture.id, version.id, 'pdf', pdf);
    const materials = await service.importPaths([docx, pdf], { lectureId: lecture.id });
    expect(materials.every((material) => material.status === 'ready')).toBe(true);
    for (const material of materials)
      expect(material.pages.map((page) => page.text).join('\n')).toContain('Українська лекція');
    expect(materials[1].pages[0].ocr).toBe(false);
  });
  it('chooses a nearby natural pause while maintaining contiguous audio boundaries', async () => {
    const input = path.join(directory, 'pause.wav');
    await runFFmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=24000:duration=301',
      '-af',
      "volume=enable='between(t,279,281)':volume=0",
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      input,
    ]);
    const [material] = await service.importPaths([input]);
    expect(material.status).toBe('ready');
    const segments = store.lectureGet(material.lectureId!).segments;
    expect(segments).toHaveLength(2);
    expect(Math.abs(segments[0].end - 280)).toBeLessThan(0.12);
    expect(segments[1].start).toBe(segments[0].end);
    expect(segments[1].end).toBeCloseTo(301, 5);
  });
  it('runs offline image OCR and scanned PDF OCR with page provenance', async () => {
    store.saveSettings({ lectureLanguage: 'en' });
    const canvas = createCanvas(1000, 220),
      context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, 1000, 220);
    context.fillStyle = 'black';
    context.font = '50px sans-serif';
    context.fillText('LECTURE DESK OCR TEST', 40, 125);
    const png = path.join(directory, 'scan.png');
    await fs.writeFile(png, canvas.toBuffer('image/png'));
    const pdf = path.join(directory, 'scan.pdf');
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(pdf);
      const document = new PDFDocument({ size: 'A4', margin: 40 });
      output.on('finish', resolve);
      output.on('error', reject);
      document.on('error', reject);
      document.pipe(output);
      document.image(png, 40, 100, { width: 500 });
      document.end();
    });
    const materials = await service.importPaths([png, pdf]);
    expect(materials.every((material) => material.status === 'ready')).toBe(true);
    for (const material of materials) {
      expect(material.pages[0].ocr).toBe(true);
      expect(material.pages[0].page).toBe(1);
      expect(material.pages[0].text.toUpperCase()).toContain('LECTURE');
    }
  });
  it('creates a separate primary-audio lecture when the selected lecture already has an original', async () => {
    const subject = store.subjectSave({ name: 'Physics' });
    const lecture = store.lectureCreate({ subjectId: subject.id, title: 'Existing lecture' });
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Unchanged speech',
    });
    store.segmentSave({
      id: randomUUID(),
      lectureId: lecture.id,
      sequence: 0,
      start: 0,
      end: 10,
      path: 'existing.wav',
      text: 'Unchanged speech',
      status: 'done',
      error: null,
    });
    store.lectureSave({ id: lecture.id, duration: 10 });
    const before = store.lectureGet(lecture.id);
    const input = path.join(directory, 'new-audio.wav');
    await runFFmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=24000:duration=1',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      input,
    ]);
    const [material] = await service.importPaths([input], { lectureId: lecture.id });
    expect(material.status).toBe('ready');
    expect(material.lectureId).not.toBe(lecture.id);
    expect(material.subjectId).toBe(subject.id);
    expect(store.lectureGet(lecture.id)).toEqual(before);
    expect(store.lectureGet(lecture.id).versions[0].id).toBe(original.id);
    expect(store.lectureGet(material.lectureId!).segments[0]).toMatchObject({ sequence: 0, start: 0 });
  });
  it.each(['recording', 'paused', 'interrupted', 'importing'] as const)(
    'isolates imported audio from a selected %s lecture before any capture segments exist',
    async (status) => {
      const subject = store.subjectSave({ name: 'Active subject' });
      const lecture = store.lectureCreate({ subjectId: subject.id, title: 'Active capture' });
      store.lectureSave({ id: lecture.id, status });
      const input = path.join(directory, 'another.wav');
      await runFFmpeg([
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=24000:duration=1',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        input,
      ]);
      const [material] = await service.importPaths([input], { lectureId: lecture.id });
      expect(material.lectureId).not.toBe(lecture.id);
      expect(material.status).toBe('ready');
      expect(store.lectureGet(lecture.id).lecture.status).toBe(status);
      expect(store.lectureGet(lecture.id).segments).toHaveLength(0);
      expect(store.lectureGet(material.lectureId!).lecture.subjectId).toBe(subject.id);
      expect(store.tasks().every((task) => task.lectureId === material.lectureId)).toBe(true);
    },
  );
  it('uses an empty selected lecture with text-only edited notes for its first primary recording', async () => {
    const lecture = store.lectureCreate();
    const notes = store.versionSave({
      lectureId: lecture.id,
      kind: 'edited',
      title: 'Preparation',
      content: 'Text notes',
    });
    const input = path.join(directory, 'first.wav');
    await runFFmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=24000:duration=1',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      input,
    ]);
    const [material] = await service.importPaths([input], { lectureId: lecture.id });
    expect(material.lectureId).toBe(lecture.id);
    expect(material.status).toBe('ready');
    expect(store.lectureGet(lecture.id).versions[0]).toMatchObject({ id: notes.id, content: 'Text notes' });
    expect(store.snapshot().lectures).toHaveLength(1);
  });
});
