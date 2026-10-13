import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const profile = await mkdtemp(path.join(tmpdir(), 'lecturedesk-capture-check-'));
const executable = path.resolve(
  process.argv[2] || 'release/mac-arm64/LectureDesk.app/Contents/MacOS/LectureDesk',
);
const application = await electron.launch({
  executablePath: executable,
  args:
    process.env.LECTUREDESK_CAPTURE_BACKEND === 'sckit-probe'
      ? ['--disable-features=MacCatapLoopbackAudioForScreenShare']
      : [],
  env: { ...process.env, LECTUREDESK_USER_DATA: profile },
  timeout: 30000,
});
const results = [];
const errors = [];
const report = {
  platform: process.platform,
  architecture: process.arch,
  packaged: true,
  executedAt: new Date().toISOString(),
  appAsarSha256: createHash('sha256')
    .update(await readFile(path.resolve(path.dirname(executable), '../Resources/app.asar')))
    .digest('hex'),
  profile,
  results,
  rendererErrors: errors,
  paidAPI: false,
  backend: process.env.LECTUREDESK_CAPTURE_BACKEND || 'production',
};
let player;
try {
  // Explicit diagnostic probe of real ScreenCaptureKit audio, separate from the production configuration.
  if (process.env.LECTUREDESK_CAPTURE_BACKEND === 'sckit-probe')
    await application.evaluate(({ session, desktopCapturer }) => {
      session.defaultSession.setDisplayMediaRequestHandler(
        async (_request, callback) => {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 },
          });
          callback({ video: sources[0], audio: 'loopback' });
        },
        { useSystemPicker: false },
      );
    });
  const page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.lecturedesk);
  await page.evaluate(() =>
    window.lecturedesk.call('settings.save', {
      setupComplete: true,
      uiLanguage: 'en',
      liveTranscription: false,
      theme: 'light',
    }),
  );
  // Instrument the real APIs without replacing streams or PCM. Both sources must actually be acquired.
  await page.evaluate(() => {
    window.captureDevicesLog = [];
    for (const method of ['getUserMedia', 'getDisplayMedia']) {
      const original = navigator.mediaDevices[method].bind(navigator.mediaDevices);
      navigator.mediaDevices[method] = async (...args) => {
        const stream = await original(...args);
        window.captureDevicesLog.push({
          method,
          tracks: stream.getTracks().map((t) => ({ kind: t.kind, label: t.label, readyState: t.readyState })),
        });
        return stream;
      };
    }
  });
  const samples = 24000 * 15,
    pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(Math.round(2500 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  const tone = path.join(profile, 'tone.wav');
  await writeFile(tone, Buffer.concat([header, pcm]));
  const modes = (process.env.LECTUREDESK_CAPTURE_MODES || 'microphone,system,both').split(',');
  assert.ok(modes.every((mode) => ['microphone', 'system', 'both'].includes(mode)));
  const bar = page.locator('.recording-bar');
  for (const mode of modes) {
    console.log(`Checking real ${mode} capture; OS may request normal recording consent.`);
    await page.evaluate((mode) => window.lecturedesk.call('settings.save', { audioMode: mode }), mode);
    await page.waitForTimeout(400); // wait for the renderer's debounced settings snapshot to settle
    await page.getByRole('button', { name: 'Record lecture', exact: true }).click();
    try {
      await page.locator('.recording-bar').waitFor({ timeout: 60000 });
    } catch (e) {
      const text = await page.locator('.toast-stack').innerText();
      results.push({ mode, passed: false, error: text || e.message });
      console.log(JSON.stringify(results.at(-1)));
      // A native picker can still be pending; do not pretend later clicks tested another source.
      for (const remaining of modes.slice(modes.indexOf(mode) + 1))
        results.push({
          mode: remaining,
          passed: false,
          notRun: true,
          error: 'Previous native capture request did not finish',
        });
      break;
    }
    const id = (await page.evaluate(() => window.lecturedesk.call('library.get'))).lectures.find(
      (l) => l.status === 'recording',
    )?.id;
    assert.ok(id);
    player = spawn('/usr/bin/afplay', ['-v', '0.05', tone], { stdio: 'ignore' });
    await page.waitForTimeout(4200);
    await bar.getByRole('button', { name: 'Pause', exact: true }).click();
    await bar.getByRole('button', { name: 'Resume', exact: true }).waitFor();
    const paused = await page.evaluate((id) => window.lecturedesk.call('lecture.get', { lectureId: id }), id);
    assert.equal(paused.lecture.status, 'paused');
    assert.ok(paused.segments.length > 0);
    await bar.getByRole('button', { name: 'Resume', exact: true }).click();
    await bar.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await page.waitForTimeout(2100);
    await bar.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.locator('.recording-bar').waitFor({ state: 'hidden' });
    player.kill();
    player = null;
    const detail = await page.evaluate((id) => window.lecturedesk.call('lecture.get', { lectureId: id }), id);
    assert.equal(detail.lecture.status, 'ready');
    assert.ok(detail.lecture.duration > 5);
    assert.ok(detail.gaps.some((g) => g.reason.includes('paused')));
    let peak = 0,
      energy = 0,
      count = 0;
    for (const segment of detail.segments) {
      const data = await readFile(segment.path);
      for (let i = 44; i + 1 < data.length; i += 2) {
        const v = data.readInt16LE(i) / 32768;
        peak = Math.max(peak, Math.abs(v));
        energy += v * v;
        count++;
      }
    }
    const acquisition = await page.evaluate(() => window.captureDevicesLog.splice(0));
    if (mode !== 'system')
      assert.ok(
        acquisition.some(
          (a) =>
            a.method === 'getUserMedia' &&
            a.tracks.some((t) => t.kind === 'audio' && t.readyState === 'live'),
        ),
      );
    if (mode !== 'microphone')
      assert.ok(
        acquisition.some(
          (a) =>
            a.method === 'getDisplayMedia' &&
            a.tracks.some((t) => t.kind === 'audio' && t.readyState === 'live'),
        ),
      );
    // A silent microphone is possible; system capture must contain the real externally played tone.
    if (mode !== 'microphone') assert.ok(peak > 0.0001, `System audio produced a dead stream (peak ${peak})`);
    const url = await page.evaluate((a) => window.lecturedesk.call('audio.url', a), {
      lectureId: id,
      segmentId: detail.segments[0].id,
    });
    const playback = await page.evaluate(async (url) => {
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.muted = true;
      await new Promise((resolve, reject) => {
        audio.onloadedmetadata = resolve;
        audio.onerror = () => reject(new Error('Playback metadata failed'));
      });
      if (!Number.isFinite(audio.duration)) throw new Error('Playback duration is not finite');
      const sought = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Playback seek timed out')), 5000);
        audio.onseeked = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      audio.currentTime = Math.min(1, audio.duration / 2);
      await sought;
      audio.playbackRate = 1.5;
      await audio.play();
      const initialPosition = audio.currentTime;
      await new Promise((resolve) => {
        audio.ontimeupdate = resolve;
      });
      const result = {
        duration: audio.duration,
        rate: audio.playbackRate,
        initialPosition,
        playedTo: audio.currentTime,
      };
      audio.pause();
      audio.src = '';
      return result;
    }, url.url);
    assert.ok(playback.duration > 0);
    assert.equal(playback.rate, 1.5);
    assert.ok(Math.abs(playback.duration - (detail.segments[0].end - detail.segments[0].start)) < 0.05);
    assert.ok(playback.playedTo > playback.initialPosition);
    const result = {
      mode,
      passed: true,
      duration: detail.lecture.duration,
      segments: detail.segments.length,
      peak,
      rms: Math.sqrt(energy / count),
      acquisition,
      playback,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/capture-check.png' });
  assert.ok(
    results.every((r) => r.passed),
    'One or more actual capture checks failed',
  );
  assert.deepEqual(errors, []);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  player?.kill();
  await application.close();
  await mkdir('docs', { recursive: true });
  await writeFile('docs/capture-result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
