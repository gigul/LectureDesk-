import { promises as fs, createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { Worker as NodeWorker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import mammoth from 'mammoth';
import { createWorker, type Worker } from 'tesseract.js';
import { XMLParser } from 'fast-xml-parser';
import yauzl from 'yauzl';
import type { Store } from './store.js';
import type { Material, AppEvent, Segment } from '../shared/types.js';
import { wavDataOffset } from './audio-range.js';

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
function installedModule(specifier: string): string {
  const resolved = require.resolve(specifier),
    physical = resolved.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  return existsSync(physical) ? physical : resolved;
}
export function resolveFFmpeg(): string {
  const executable = (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  return executable.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}
export async function resourceFile(relative: string): Promise<string> {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const moduleDirectory = typeof __dirname === 'string' ? __dirname : import.meta.dirname;
  const candidates = [
    resources && path.join(resources, 'resources', relative),
    resources && path.join(resources, relative),
    path.join(process.cwd(), 'resources', relative),
    path.resolve(moduleDirectory, '../../resources', relative),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`Required offline resource is missing: ${relative}. Reinstall LectureDesk.`);
}
const mimeTypes: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.webm': 'audio/webm',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Isolate PDF parsing/rasterization in a worker: PDF.js's Node fake worker otherwise runs CPU work on Electron's main thread.
// Dependencies are trusted installation paths; document contents are passed only as parser data.
const PDF_WORKER_SOURCE = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
  const fs=require('node:fs/promises');
  const {getDocument}=await import(workerData.pdfURL);
  const {createCanvas}=require(workerData.canvasModule);
  const {createWorker}=require(workerData.ocrModule);
  const loading=getDocument({data:new Uint8Array(await fs.readFile(workerData.filename)),useSystemFonts:true});
  const document=await loading.promise;const pages=[];let ocr;
  try{
    if(document.numPages>2000)throw new Error('PDF exceeds 2,000 pages');
    for(let number=1;number<=document.numPages;number++){
      const page=await document.getPage(number),content=await page.getTextContent();
      const text=content.items.map(item=>'str'in item?item.str+(item.hasEOL?'\n':' '):'').join('').trim();
      if(text.length>=30)pages.push({page:number,text,ocr:false});
      else{
        ocr ||= await createWorker(workerData.languages,1,{langPath:workerData.langPath,gzip:true,cacheMethod:'none',workerPath:workerData.ocrWorker});
        const native=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(2,1600/Math.max(native.width,native.height))});
        const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
        await page.render({canvasContext:canvas.getContext('2d'),viewport,canvas}).promise;
        const recognized=await ocr.recognize(canvas.toBuffer('image/png'));pages.push({page:number,text:recognized.data.text,ocr:true});
      }
      page.cleanup();parentPort.postMessage({progress:number/document.numPages});
    }
    parentPort.postMessage({pages});
  }finally{await ocr?.terminate();await loading.destroy();}
})().catch(error=>parentPort.postMessage({error:error.message||String(error)}));
`;

export function runFFmpeg(
  args: string[],
  onProgress?: (seconds: number) => void,
  onDiagnostic?: (chunk: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFFmpeg(), ['-nostdin', '-hide_banner', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-8000);
      onDiagnostic?.(chunk);
      const times = [...chunk.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
      const last = times.at(-1);
      if (last) onProgress?.(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]));
    });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Audio conversion failed (${signal || code}): ${tail.replace(/\r/g, '\n').split('\n').filter(Boolean).slice(-6).join('\n')}`,
            ),
          ),
    );
  });
}

export async function checkedLibraryAsset(store: Store, value: string): Promise<string> {
  const root = await fs.realpath(store.root);
  const filename = await fs.realpath(path.resolve(store.root, value));
  const relative = path.relative(root, filename);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !['audio', 'lectures', 'materials', 'restored'].includes(relative.split(path.sep)[0])
  )
    throw new Error('Asset path is outside library content directories');
  if (!(await fs.stat(filename)).isFile()) throw new Error('Library asset is not a regular file');
  return filename;
}

/** Seek nearby silence without retaining samples or a list proportional to every detected pause. */
async function audioBoundaries(filename: string): Promise<number[]> {
  const boundaries: number[] = [];
  let target = 285,
    best: number | undefined,
    duration = 0,
    buffer = '';
  const commit = (through: number) => {
    while (through > target + 15) {
      const boundary = best ?? target;
      boundaries.push(boundary);
      target = boundary + 285;
      best = undefined;
      if (boundaries.length > 20000) throw new Error('Audio duration exceeds the supported import limit');
    }
  };
  await runFFmpeg(
    ['-i', filename, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'],
    (seconds) => {
      duration = Math.max(duration, seconds);
      commit(seconds);
    },
    (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/[\r\n]/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const match = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
        if (match) {
          const midpoint = Number(match[1]) - Number(match[2]) / 2;
          commit(midpoint);
          if (
            Math.abs(midpoint - target) <= 15 &&
            (best === undefined || Math.abs(midpoint - target) < Math.abs(best - target))
          )
            best = midpoint;
        }
        const full = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(line);
        if (full)
          duration = Math.max(duration, Number(full[1]) * 3600 + Number(full[2]) * 60 + Number(full[3]));
      }
    },
  );
  commit(duration);
  return boundaries.filter((boundary) => boundary < duration - 1);
}

/** Read only selected XML ZIP members, limiting uncompressed size and avoiding extraction. */
async function validateOfficeZip(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error('Corrupt Office document'));
      let total = 0,
        count = 0;
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (
          entry.uncompressedSize > 64 * 1024 ** 2 ||
          (total += entry.uncompressedSize) > 512 * 1024 ** 2 ||
          ++count > 20000 ||
          entry.generalPurposeBitFlag & 1
        ) {
          zip.close();
          reject(new Error('Office document exceeds safe expanded size limits or is encrypted'));
          return;
        }
        zip.readEntry();
      });
      zip.readEntry();
    }),
  );
}
async function pptxSlides(file: string): Promise<Material['pages']> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error('Corrupt presentation'));
      const pages: Material['pages'] = [];
      let total = 0;
      const parser = new XMLParser({ ignoreAttributes: false, textNodeName: '#text', preserveOrder: true });
      const textNodes = (nodes: unknown): string[] => {
        if (Array.isArray(nodes)) return nodes.flatMap(textNodes);
        if (!nodes || typeof nodes !== 'object') return [];
        return Object.entries(nodes).flatMap(([key, value]) =>
          key === 'a:t'
            ? [typeof value === 'string' ? value : textNodes(value).join('')]
            : key === '#text'
              ? [String(value)]
              : key === ':@'
                ? []
                : textNodes(value),
        );
      };
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.fileName);
        if (!match) {
          zip.readEntry();
          return;
        }
        if (
          entry.uncompressedSize > 16 * 1024 * 1024 ||
          (total += entry.uncompressedSize) > 128 * 1024 * 1024
        ) {
          zip.close();
          reject(new Error('Presentation text is too large'));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zip.close();
            reject(streamError || new Error('Corrupt presentation'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            try {
              const xml = Buffer.concat(chunks).toString('utf8');
              if (/<!DOCTYPE|<!ENTITY/i.test(xml))
                throw new Error('Presentation contains unsupported XML entities');
              pages.push({
                page: Number(match[1]),
                text: textNodes(parser.parse(xml)).join('\n'),
                ocr: false,
              });
              zip.readEntry();
            } catch (parseError) {
              zip.close();
              reject(parseError);
            }
          });
        });
      });
      zip.on('end', () =>
        pages.length
          ? resolve(pages.sort((a, b) => a.page - b.page))
          : reject(new Error('No slides found in presentation')),
      );
      zip.readEntry();
    }),
  );
}

export class MaterialService {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private emit: (event: AppEvent) => void,
  ) {}
  importPaths(
    paths: string[],
    context: { lectureId?: string; subjectId?: string } = {},
  ): Promise<Material[]> {
    if (!Array.isArray(paths) || paths.length > 100)
      return Promise.reject(new Error('Import at most 100 files at a time'));
    const operation = this.serial.then(async () => {
      const imported: Material[] = [];
      for (const source of paths) imported.push(await this.importOne(source, context));
      return imported;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  retry(id: string): Promise<Material> {
    const operation = this.serial.then(async () => {
      const material = this.store.materials().find((item) => item.id === id);
      if (!material) throw new Error('Material does not exist');
      this.store.materialUpdate(id, { status: 'processing', error: null });
      await this.extract(material);
      return this.store.materials().find((item) => item.id === id)!;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  private async importOne(
    source: string,
    context: { lectureId?: string; subjectId?: string },
  ): Promise<Material> {
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error('Only regular files can be imported');
    const extension = path.extname(source).toLowerCase();
    const mime = mimeTypes[extension];
    if (!mime) throw new Error(`Unsupported file type: ${extension || '(none)'}`);
    const isAudio = mime.startsWith('audio/');
    const maximum = isAudio ? 8 * 1024 ** 3 : 256 * 1024 ** 2;
    if (stat.size < 1 || stat.size > maximum)
      throw new Error(`File must be nonempty and smaller than ${isAudio ? '8 GB' : '256 MB'}`);
    let lectureId = context.lectureId || null;
    let subjectId = context.subjectId || null;
    if (lectureId) {
      const selected = this.store.lectureGet(lectureId);
      if (isAudio) {
        subjectId = selected.lecture.subjectId;
        if (
          selected.segments.length ||
          selected.versions.some((version) => version.kind === 'original') ||
          selected.lecture.deletedAt ||
          ['recording', 'paused', 'interrupted', 'importing'].includes(selected.lecture.status)
        )
          lectureId = null;
      } else subjectId ||= selected.lecture.subjectId;
    }
    if (isAudio && !lectureId)
      lectureId = this.store.lectureCreate({ subjectId, title: path.basename(source, extension) }).id;
    // Reserve the primary-audio slot before yielding to file copy. Capture must reject importing lectures.
    if (isAudio && lectureId) this.store.lectureSave({ id: lectureId, status: 'importing' });
    const id = randomUUID();
    const directory = path.join(this.store.root, 'materials', id);
    const destination = path.join(directory, `original${extension}`);
    try {
      await fs.mkdir(directory, { recursive: true });
      await pipeline(
        createReadStream(source),
        createWriteStream(`${destination}.part`, { flags: 'wx', mode: 0o600 }),
      );
      const handle = await fs.open(`${destination}.part`, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(`${destination}.part`, destination);
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      if (isAudio && lectureId) this.store.lectureSave({ id: lectureId, status: 'ready' });
      throw error;
    }
    const material: Material = {
      id,
      lectureId,
      subjectId,
      name: path.basename(source),
      path: destination,
      mime,
      size: stat.size,
      status: 'processing',
      error: null,
      pages: [],
      createdAt: new Date().toISOString(),
    };
    this.store.materialSave(material);
    this.emit({ type: 'changed', lectureId: lectureId || undefined });
    await this.extract(material);
    return this.store.materials().find((item) => item.id === id)!;
  }
  private async ocrWorker(): Promise<Worker> {
    const languages = this.ocrLanguages();
    const languageFile = await resourceFile(`ocr/${languages[0]}.traineddata.gz`);
    for (const code of languages.slice(1)) await resourceFile(`ocr/${code}.traineddata.gz`);
    return createWorker(languages, 1, {
      langPath: path.dirname(languageFile),
      gzip: true,
      cacheMethod: 'none',
      workerPath: installedModule('tesseract.js/src/worker-script/node/index.js'),
    });
  }
  private ocrLanguages(): string[] {
    // Slides and handouts are in the lecture language, often with English terms.
    const language = this.store.settings().lectureLanguage;
    return [...new Set([{ en: 'eng', ru: 'rus', uk: 'ukr', pl: 'pol' }[language], 'eng'])];
  }
  private async extract(material: Material): Promise<void> {
    try {
      material = { ...material, path: await checkedLibraryAsset(this.store, material.path) };
      this.emit({
        type: 'import-progress',
        lectureId: material.lectureId || undefined,
        progress: 0,
        message: material.name,
      });
      let pages: Material['pages'] = [];
      if (material.mime.startsWith('audio/')) await this.audio(material);
      else if (material.mime.startsWith('text/')) {
        const data = await fs.readFile(material.path);
        if (data.includes(0) && !(data[0] === 0xff && data[1] === 0xfe))
          throw new Error('Text file contains binary data');
        const text =
          data[0] === 0xff && data[1] === 0xfe
            ? data.subarray(2).toString('utf16le')
            : data.toString('utf8').replace(/^\uFEFF/, '');
        pages = [{ page: 1, text, ocr: false }];
      } else if (material.mime === 'application/pdf') pages = await this.pdf(material);
      else if (material.mime.endsWith('wordprocessingml.document')) {
        await validateOfficeZip(material.path);
        const result = await mammoth.extractRawText({ path: material.path });
        // DOCX pagination is renderer-dependent: retain paragraphs as one document, never invent pages.
        pages = [{ page: 1, text: result.value, ocr: false }];
      } else if (material.mime.endsWith('presentationml.presentation')) {
        await validateOfficeZip(material.path);
        pages = await pptxSlides(material.path);
      } else if (material.mime.startsWith('image/')) {
        const worker = await this.ocrWorker();
        try {
          const result = await worker.recognize(material.path);
          pages = [{ page: 1, text: result.data.text, ocr: true }];
        } finally {
          await worker.terminate();
        }
      }
      this.store.materialUpdate(material.id, { pages, status: 'ready', error: null });
      this.emit({
        type: 'import-progress',
        lectureId: material.lectureId || undefined,
        progress: 1,
        message: material.name,
      });
    } catch (error) {
      this.store.materialUpdate(material.id, { status: 'error', error: describeError(error) });
      if (material.lectureId && material.mime.startsWith('audio/'))
        this.store.lectureSave({ id: material.lectureId, status: 'ready' });
      this.emit({
        type: 'error',
        lectureId: material.lectureId || undefined,
        message: `${material.name}: ${describeError(error)}`,
      });
    }
    this.emit({ type: 'changed', lectureId: material.lectureId || undefined });
  }
  private async pdf(material: Material): Promise<Material['pages']> {
    const languages = this.ocrLanguages();
    const languageFile = await resourceFile(`ocr/${languages[0]}.traineddata.gz`);
    for (const language of languages.slice(1)) await resourceFile(`ocr/${language}.traineddata.gz`);
    return new Promise((resolve, reject) => {
      const worker = new NodeWorker(PDF_WORKER_SOURCE, {
        eval: true,
        workerData: {
          filename: material.path,
          languages,
          langPath: path.dirname(languageFile),
          pdfURL: pathToFileURL(installedModule('pdfjs-dist/legacy/build/pdf.mjs')).href,
          canvasModule: installedModule('@napi-rs/canvas'),
          ocrModule: installedModule('tesseract.js'),
          ocrWorker: installedModule('tesseract.js/src/worker-script/node/index.js'),
        },
      });
      let finished = false;
      worker.on('message', (message: { progress?: number; pages?: Material['pages']; error?: string }) => {
        if (message.progress !== undefined)
          this.emit({
            type: 'import-progress',
            lectureId: material.lectureId || undefined,
            progress: message.progress,
            message: material.name,
          });
        if (message.pages) {
          finished = true;
          resolve(message.pages);
        }
        if (message.error) {
          finished = true;
          reject(new Error(message.error));
        }
      });
      worker.on('error', (error) => {
        finished = true;
        reject(error);
      });
      worker.on('exit', (code) => {
        if (!finished) reject(new Error(`PDF worker exited before completing (${code})`));
      });
    });
  }
  private async audio(material: Material): Promise<void> {
    if (!material.lectureId) throw new Error('Audio requires a lecture');
    const lectureId = material.lectureId;
    const directory = path.join(
      this.store.root,
      'lectures',
      material.lectureId,
      'imported-audio',
      material.id,
    );
    const existing = this.store
      .lectureGet(material.lectureId)
      .segments.filter((segment) => path.dirname(segment.path) === directory);
    if (existing.length) return;
    await fs.mkdir(directory, { recursive: true });
    this.store.lectureSave({ id: material.lectureId, status: 'importing' });
    const boundaries = await audioBoundaries(material.path);
    await runFFmpeg(
      [
        '-y',
        '-i',
        material.path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-c:a',
        'pcm_s16le',
        '-f',
        'segment',
        ...(boundaries.length ? ['-segment_times', boundaries.join(',')] : ['-segment_time', '300']),
        '-reset_timestamps',
        '1',
        path.join(directory, '%06d.wav'),
      ],
      (seconds) =>
        this.emit({
          type: 'import-progress',
          lectureId: material.lectureId!,
          progress: 0,
          message: `${material.name}: ${Math.floor(seconds)} s`,
        }),
    );
    const files = (await fs.readdir(directory)).filter((file) => /^\d{6}\.wav$/.test(file)).sort();
    if (!files.length) throw new Error('No audio stream found');
    const detail = this.store.lectureGet(material.lectureId);
    let sequence = Math.max(-1, ...detail.segments.map((segment) => segment.sequence)) + 1;
    let offset = detail.lecture.duration;
    const segments: Segment[] = [];
    for (const file of files) {
      const filename = path.join(directory, file);
      // FFmpeg WAV includes varying metadata; parse data chunk for exact sample count.
      const bytes = await wavDataOffset(filename).then(
        (info) => info.bytes,
        () => 0,
      );
      if (!bytes || bytes / 48000 > 301) throw new Error('Invalid converted audio segment');
      const duration = bytes / 48000;
      segments.push({
        id: randomUUID(),
        lectureId,
        sequence: sequence++,
        start: offset,
        end: offset + duration,
        path: filename,
        text: '',
        status: 'queued',
        error: null,
      });
      offset += duration;
    }
    this.store.transaction(() => {
      for (const segment of segments) {
        this.store.segmentSave(segment);
        this.store.taskAdd('transcribe', lectureId, { segmentId: segment.id }, `transcribe:${segment.id}`);
      }
      this.store.lectureSave({ id: lectureId, status: 'ready', duration: offset });
    });
  }
}
