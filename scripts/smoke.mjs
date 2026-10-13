import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const profile = await mkdtemp(path.join(tmpdir(), 'lecturedesk-smoke-'));
const executable = process.argv[2];
const options = { env: { ...process.env, LECTUREDESK_USER_DATA: profile }, timeout: 30000 };
if (executable) options.executablePath = path.resolve(executable);
else options.args = ['out/main/index.js'];
const application = await electron.launch(options);
const errors = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.lecturedesk);
  const initial = await page.evaluate(() => window.lecturedesk.call('library.get'));
  assert.equal(initial.hasKey, false);
  assert.equal(initial.lectures.length, 0);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/onboarding.png' });
  await page.evaluate(() =>
    window.lecturedesk.call('settings.save', {
      setupComplete: true,
      uiLanguage: 'en',
      liveTranscription: false,
    }),
  );
  await page.getByRole('heading', { name: 'All lectures', exact: true }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/library-empty.png' });
  const subject = await page.evaluate(() =>
    window.lecturedesk.call('subject.save', {
      name: 'Integration test subject',
      glossary: 'mitochondria, ATP',
      color: '#7465d9',
    }),
  );
  const lecture = await page.evaluate(
    (id) => window.lecturedesk.call('lecture.create', { subjectId: id, title: 'Integrated local workflow' }),
    subject.id,
  );
  const textFile = path.join(profile, 'lecture-text.txt');
  await writeFile(
    textFile,
    'Lecture evidence: mitochondria generate ATP. No assignment deadline was stated.\n',
  );
  await page.evaluate((a) => window.lecturedesk.call('import.paths', a), {
    paths: [textFile],
    lectureId: lecture.id,
  });
  const version = await page.evaluate(
    (id) =>
      window.lecturedesk.call('version.save', {
        lectureId: id,
        kind: 'edited',
        title: 'User notes',
        content: '# Learning notes\n\nMitochondria generate ATP.',
      }),
    lecture.id,
  );
  let detail = await page.evaluate(
    (id) => window.lecturedesk.call('lecture.get', { lectureId: id }),
    lecture.id,
  );
  assert.equal(detail.materials[0].status, 'ready');
  assert.ok(detail.materials[0].pages[0].text.includes('ATP'));
  assert.equal(detail.versions[0].id, version.id);
  await page.getByText('Integrated local workflow', { exact: true }).first().click();
  await page.getByRole('heading', { name: 'Integrated local workflow', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.getByText('Mitochondria generate ATP.', { exact: true }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/library.png' });
  await page.evaluate(() => window.lecturedesk.call('settings.save', { theme: 'dark' }));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: 'docs/screenshots/library-dark.png' });
  const backupFolder = path.join(profile, 'cloud-folder');
  await mkdir(backupFolder);
  await page.evaluate(
    (folder) => window.lecturedesk.call('settings.save', { backupFolder: folder }),
    backupFolder,
  );
  const backup = await page.evaluate(() => window.lecturedesk.call('backup.create'));
  const preview = await page.evaluate(
    (p) => window.lecturedesk.call('backup.preview', { path: p }),
    backup.path,
  );
  assert.equal(preview.lectures, 1);
  await page.evaluate((p) => window.lecturedesk.call('backup.restore', { path: p }), backup.path);
  const after = await page.evaluate(() => window.lecturedesk.call('library.get'));
  assert.equal(after.lectures.length, 2);
  await page.evaluate((id) => window.lecturedesk.call('lecture.trash', { lectureId: id }), lecture.id);
  await page.evaluate((id) => window.lecturedesk.call('lecture.restore', { lectureId: id }), lecture.id);
  await page.evaluate((id) => window.lecturedesk.call('subject.delete', { id }), subject.id);
  detail = await page.evaluate((id) => window.lecturedesk.call('lecture.get', { lectureId: id }), lecture.id);
  assert.equal(detail.lecture.subjectId, null);
  assert.equal(detail.versions[0].content, version.content);
  const blocked = await page.evaluate(async () => {
    try {
      await window.lecturedesk.call('shell.url', { url: 'javascript:alert(1)' });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true);
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    packaged: !!executable,
    platform: initial.platform,
    profile,
    checks: [
      'onboarding rendering',
      'secure IPC bridge',
      'local create/import/version',
      'light/dark rendering',
      'real backup/preview/merge restore',
      'trash restore',
      'subject deletion preserves lecture',
      'external protocol rejection',
    ],
    rendererErrors: errors,
  };
  await writeFile('docs/smoke-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await application.close();
}
