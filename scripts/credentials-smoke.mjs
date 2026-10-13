import { _electron as electron } from 'playwright';
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import yauzl from 'yauzl';
import { createHash } from 'node:crypto';

const executable = path.resolve(
  process.argv[2] || 'release/mac-arm64/LectureDesk.app/Contents/MacOS/LectureDesk',
);
const profile = await mkdtemp(path.join(tmpdir(), 'lecturedesk-credential-check-'));
// This is deliberately an invalid, test-only fixture, never sent to OpenAI or used in the user's profile.
const fixture = 'sk-test-fixture-not-an-openai-key-00000000000000000000';
const ciphertextPath = path.join(profile, 'credentials/openai.encrypted');
let application;
const result = {
  passed: false,
  platform: process.platform,
  packaged: true,
  profile,
  executedAt: new Date().toISOString(),
  paidApiCalls: 0,
  appAsarSha256: createHash('sha256')
    .update(await readFile(path.resolve(path.dirname(executable), '../Resources/app.asar')))
    .digest('hex'),
  checks: [],
};
async function launch() {
  application = await electron.launch({
    executablePath: executable,
    env: { ...process.env, LECTUREDESK_USER_DATA: profile },
    timeout: 30000,
  });
  const page = await application.firstWindow();
  await page.waitForFunction(() => !!window.lecturedesk);
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  return page;
}
async function assertArchiveExcludesKey(filename) {
  await new Promise((resolve, reject) =>
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        assert.ok(!/credential|openai\.encrypted/i.test(entry.fileName));
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            try {
              assert.ok(!Buffer.concat(chunks).includes(fixture));
              zip.readEntry();
            } catch (error) {
              reject(error);
            }
          });
        });
      });
      zip.on('end', resolve);
      zip.readEntry();
    }),
  );
}
try {
  let page = await launch();
  assert.equal((await page.evaluate(() => window.lecturedesk.call('library.get'))).hasKey, false);
  assert.equal(
    await application.evaluate(({ safeStorage }) => safeStorage.isAsyncEncryptionAvailable()),
    true,
  );
  await page.evaluate(() =>
    window.lecturedesk.call('settings.save', { setupComplete: true, liveTranscription: false }),
  );
  await page.evaluate((key) => window.lecturedesk.call('key.set', { key }), fixture);
  assert.equal((await page.evaluate(() => window.lecturedesk.call('library.get'))).hasKey, true);
  const ciphertext = await readFile(ciphertextPath);
  assert.ok(ciphertext.length > 0);
  assert.ok(!ciphertext.includes(fixture));
  result.checks.push('Actual Electron OS-backed encryption persisted ciphertext outside library assets');
  const backupFolder = path.join(profile, 'backups');
  await mkdir(backupFolder);
  const backup = await page.evaluate(
    (folder) => window.lecturedesk.call('backup.create', { folder }),
    backupFolder,
  );
  await assertArchiveExcludesKey(backup.path);
  result.checks.push('Every extracted backup member excludes test key and credential store');
  await application.close();
  application = null;
  page = await launch();
  assert.equal((await page.evaluate(() => window.lecturedesk.call('library.get'))).hasKey, true);
  result.checks.push('App restart decrypted stored credential successfully through OS secure storage');
  await page.evaluate(() => window.lecturedesk.call('key.delete'));
  await assert.rejects(stat(ciphertextPath), { code: 'ENOENT' });
  await application.close();
  application = null;
  page = await launch();
  assert.equal((await page.evaluate(() => window.lecturedesk.call('library.get'))).hasKey, false);
  result.checks.push('Delete removes ciphertext and survives app restart');
  result.passed = true;
} catch (error) {
  result.failure = { message: error.message.replaceAll(fixture, '[test fixture redacted]') };
  process.exitCode = 1;
} finally {
  if (application) await application.close();
  await mkdir('docs', { recursive: true });
  await writeFile('docs/credentials-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
