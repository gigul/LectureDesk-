import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile, stat, realpath } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';
import { Document, Paragraph, Packer } from 'docx';

const repository = process.cwd();
const executable = path.resolve(
  process.argv[2] || 'release/mac-arm64/LectureDesk.app/Contents/MacOS/LectureDesk',
);
const resources = path.resolve(path.dirname(executable), '../Resources');
const profile = await mkdtemp(path.join(tmpdir(), 'lecturedesk-packaged-material-'));
const fixtureFolder = path.join(profile, 'fixtures');
await mkdir(fixtureFolder);
const resultPath = path.join(repository, 'docs/packaged-material-result.json');
const checks = [];
const rendererErrors = [];
const applicationErrors = [];
const source = 'Українська лекція. Русский текст. English lecture. Polski wykład. Матеріали з фізики.';
const requiredPhrases = ['Українська лекція', 'Русский текст', 'English lecture', 'Polski wykład'];
const result = {
  passed: false,
  packaged: true,
  platform: process.platform,
  architecture: process.arch,
  executedAt: new Date().toISOString(),
  executable,
  appAsarSha256: createHash('sha256')
    .update(await readFile(path.join(resources, 'app.asar')))
    .digest('hex'),
  isolatedProfile: profile,
  workingDirectory: profile,
  paidApiCalls: 0,
  checks,
  rendererErrors,
  applicationErrors,
};
let application;
let phase = 'fixture creation';

async function writePDF(filename, draw) {
  const pdf = new PDFDocument({ size: 'A4', margin: 40 });
  const complete = pipeline(pdf, createWriteStream(filename));
  draw(pdf);
  pdf.end();
  await complete;
}
function image(text) {
  const canvas = createCanvas(1100, 240);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'black';
  context.font = '54px sans-serif';
  context.fillText(text, 35, 140);
  return canvas.toBuffer('image/png');
}
function assertMultilingual(material) {
  assert.equal(material.status, 'ready', material.error || material.name);
  const text = material.pages.map((page) => page.text).join('\n');
  for (const phrase of requiredPhrases)
    assert.ok(text.includes(phrase), `${material.name}: missing ${phrase}`);
}
try {
  const textPDF = path.join(fixtureFolder, 'multilingual-text.pdf');
  await writePDF(textPDF, (pdf) =>
    pdf.font(path.join(repository, 'resources/fonts/NotoSans-Regular.ttf')).fontSize(16).text(source),
  );
  const png = path.join(fixtureFolder, 'ocr-image.png');
  await writeFile(png, image('LECTURE DESK OCR MATERIAL'));
  const scannedPDF = path.join(fixtureFolder, 'scanned-two-pages.pdf');
  await writePDF(scannedPDF, (pdf) => {
    pdf.image(png, 40, 100, { width: 515 });
    pdf.addPage();
    pdf.image(image('SECOND PAGE MATERIAL'), 40, 100, { width: 515 });
  });
  const docx = path.join(fixtureFolder, 'multilingual-document.docx');
  await writeFile(
    docx,
    await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(source)] }] })),
  );
  const txt = path.join(fixtureFolder, 'multilingual-text.txt');
  await writeFile(txt, source, 'utf8');

  phase = 'packaged launch';
  application = await electron.launch({
    executablePath: executable,
    cwd: profile,
    env: {
      ...process.env,
      LECTUREDESK_USER_DATA: path.join(profile, 'user-data'),
      ELECTRON_RENDERER_URL: '',
    },
    timeout: 30000,
  });
  application.process().stderr.on('data', (data) => {
    const text = data.toString();
    if (/uncaught|cannot find module|worker.*error|failed to load/i.test(text))
      applicationErrors.push(text.slice(-4000));
  });
  const packageState = await application.evaluate(({ app, session, dialog }) => {
    globalThis.materialSmokeSavePaths = [];
    globalThis.materialSmokeBlockedRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['*://api.openai.com/*'] },
      (_request, callback) => {
        globalThis.materialSmokeBlockedRequests++;
        callback({ cancel: true });
      },
    );
    // Only dialog destinations are supplied by the test. Actual IPC validation/import/export remain production code.
    dialog.showSaveDialog = async () => {
      const filePath = globalThis.materialSmokeSavePaths.shift();
      if (!filePath) throw new Error('Smoke test did not supply an export destination');
      return { canceled: false, filePath };
    };
    return {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      cwd: process.cwd(),
      appVersion: app.getVersion(),
    };
  });
  assert.equal(packageState.isPackaged, true);
  assert.equal(await realpath(packageState.cwd), await realpath(profile));
  Object.assign(result, { packageState });
  checks.push('Packaged app launched with cwd and profile outside the repository');
  const page = await application.firstWindow();
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.waitForFunction(() => !!window.lecturedesk);
  const initial = await page.evaluate(() => window.lecturedesk.call('library.get'));
  assert.equal(initial.hasKey, false);
  assert.equal(initial.lectures.length, 0);
  await page.evaluate(() =>
    window.lecturedesk.call('settings.save', {
      setupComplete: true,
      uiLanguage: 'en',
      lectureLanguage: 'auto',
      liveTranscription: false,
    }),
  );
  const lecture = await page.evaluate(() =>
    window.lecturedesk.call('lecture.create', { title: 'Packaged material validation' }),
  );
  phase = 'packaged import and workers';
  await page.evaluate((args) => window.lecturedesk.call('import.paths', args), {
    lectureId: lecture.id,
    paths: [textPDF, scannedPDF, png, docx, txt],
  });
  let detail = await page.evaluate(
    (lectureId) => window.lecturedesk.call('lecture.get', { lectureId }),
    lecture.id,
  );
  assert.equal(detail.materials.length, 5);
  assert.ok(
    detail.materials.every((material) => material.status === 'ready'),
    JSON.stringify(
      detail.materials.map((material) => ({
        name: material.name,
        status: material.status,
        error: material.error,
      })),
    ),
  );
  const byName = new Map(detail.materials.map((material) => [material.name, material]));
  assertMultilingual(byName.get(path.basename(textPDF)));
  assert.equal(byName.get(path.basename(textPDF)).pages[0].ocr, false);
  assertMultilingual(byName.get(path.basename(docx)));
  assertMultilingual(byName.get(path.basename(txt)));
  const scanned = byName.get(path.basename(scannedPDF));
  assert.deepEqual(
    scanned.pages.map((page) => page.page),
    [1, 2],
  );
  assert.ok(scanned.pages.every((page) => page.ocr));
  assert.ok(scanned.pages[0].text.toUpperCase().includes('LECTURE'));
  assert.ok(scanned.pages[1].text.toUpperCase().includes('SECOND'));
  const recognizedImage = byName.get(path.basename(png));
  assert.equal(recognizedImage.pages[0].ocr, true);
  assert.ok(recognizedImage.pages[0].text.toUpperCase().includes('LECTURE'));
  checks.push('Packaged PDF worker extracted multilingual text with page provenance');
  checks.push('Packaged PDF rasterizer and offline Tesseract OCR processed two scanned pages');
  checks.push(
    'Packaged image OCR loaded English/Russian/Ukrainian/Polish resources without repository fallback',
  );
  checks.push('Packaged DOCX and TXT import preserved multilingual text');

  phase = 'packaged document exports';
  const version = await page.evaluate((args) => window.lecturedesk.call('version.save', args), {
    lectureId: lecture.id,
    kind: 'edited',
    title: 'Multilingual export result',
    content: source,
  });
  const exports = [];
  for (const format of ['txt', 'md', 'docx', 'pdf']) {
    const destination = path.join(profile, `exported-multilingual.${format}`);
    await application.evaluate((_electron, filePath) => {
      globalThis.materialSmokeSavePaths.push(filePath);
    }, destination);
    const output = await page.evaluate((args) => window.lecturedesk.call('export.lecture', args), {
      lectureId: lecture.id,
      versionId: version.id,
      format,
    });
    assert.equal(output, destination);
    const metadata = await stat(output);
    assert.ok(metadata.size > 0);
    const bytes = await readFile(output);
    if (format === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    if (format === 'docx') assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    if (format === 'txt' || format === 'md') assert.equal(bytes.toString('utf8'), source);
    exports.push({
      format,
      path: output,
      size: metadata.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  phase = 'opening exports through production import parsers';
  await page.evaluate((args) => window.lecturedesk.call('import.paths', args), {
    lectureId: lecture.id,
    paths: exports.map((output) => output.path),
  });
  detail = await page.evaluate(
    (lectureId) => window.lecturedesk.call('lecture.get', { lectureId }),
    lecture.id,
  );
  for (const output of exports)
    assertMultilingual(detail.materials.find((material) => material.name === path.basename(output.path)));
  assert.equal(detail.versions[0].content, source);
  checks.push('Packaged TXT/Markdown/DOCX/PDF exports opened and round-tripped every multilingual phrase');
  Object.assign(result, {
    exports,
    importedMaterials: detail.materials.map((material) => ({
      name: material.name,
      status: material.status,
      pages: material.pages.map((page) => ({ page: page.page, ocr: page.ocr, characters: page.text.length })),
    })),
  });
  const blockedRequests = await application.evaluate(() => globalThis.materialSmokeBlockedRequests);
  assert.equal(blockedRequests, 0);
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(applicationErrors, []);
  checks.push('No API key, no attempted OpenAI calls, no renderer/module/worker errors');
  result.passed = true;
} catch (error) {
  result.failure = { phase, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  if (application) await application.close();
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
