import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  desktopCapturer,
  systemPreferences,
  protocol,
  shell,
  powerSaveBlocker,
  powerMonitor,
  Menu,
} from 'electron';
import { join, resolve, relative, extname, isAbsolute, sep } from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { MaterialService } from './materials';
import { Portability } from './portability';
import { AIService } from './ai';
import { Credentials, safeError } from './credentials';
import { RecordingService } from './recording';
import { audioResponse } from './audio-response';
import { validate } from './validation';
import { METHODS, type Method, type AppEvent, type Settings } from '../shared/types';

// Electron 44's CoreAudio Tap/native-picker path can return an ended audio track.
// Use the documented ScreenCaptureKit permission path, verified with real system PCM.
if (process.platform === 'darwin')
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lecture-audio',
    privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true },
  },
]);
app.setName('LectureDesk');
// Development and automated probes can isolate data without changing production behavior.
if (process.env.LECTUREDESK_USER_DATA) app.setPath('userData', resolve(process.env.LECTUREDESK_USER_DATA));
let window: BrowserWindow | null = null;
let store: Store;
let ai: AIService;
let recording: RecordingService;
let credentials: Credentials;
let wakeId: number | null = null;
let closing = false;
let quitting = false;
let lastBackup = Date.now();
let backupRunning = false;
let fileOperations = 0;
let movingLibrary = false;
const emit = (event: AppEvent) => {
  if (window && !window.isDestroyed()) window.webContents.send('lecturedesk:event', event);
};
function wake(active: boolean) {
  if (active && wakeId === null) wakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && wakeId !== null) {
    powerSaveBlocker.stop(wakeId);
    wakeId = null;
  }
}
function assetPath(value: string) {
  const result = resolve(store.root, value);
  const rel = relative(store.root, result);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error('Invalid library path');
  return result;
}
async function checkedAsset(value: string) {
  const file = await fs.realpath(assetPath(value));
  const root = await fs.realpath(store.root);
  const rel = relative(root, file);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel))
    throw new Error('Invalid library symlink');
  return file;
}
function trustedFrame(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    return false;
  const frame = event.senderFrame;
  if (!frame) return false;
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
    return new URL(frame.url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
  return frame.url.split(/[?#]/)[0] === pathToFileURL(join(__dirname, '../renderer/index.html')).href;
}
async function saveSettings(patch: Partial<Settings>) {
  if (
    recording.active &&
    ['storageFolder', 'audioMode', 'microphoneId', 'liveModel', 'liveTranscription'].some((k) => k in patch)
  )
    throw new Error('Stop recording before changing capture, live model, or storage settings');
  if (patch.storageFolder && resolve(patch.storageFolder) !== resolve(store.root)) {
    if (
      fileOperations ||
      store.materials().some((m) => m.status === 'processing') ||
      store.snapshot().lectures.some((l) => l.status === 'importing')
    )
      throw new Error('Finish importing, exporting or restoring before moving the library');
    if (aiBusy()) throw new Error('Finish or cancel queued work before moving the library');
    movingLibrary = true;
    try {
      const source = store.root,
        target = resolve(patch.storageFolder);
      const rel = relative(source, target);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel))
        throw new Error('Choose a folder outside the current library');
      await fs.mkdir(target, { recursive: true });
      for (const name of ['audio', 'materials', 'lectures', 'restored'])
        if (existsSync(join(source, name))) {
          if (existsSync(join(target, name)))
            throw new Error('Destination already contains a library. Choose an empty storage folder.');
          await fs.cp(join(source, name), join(target, name), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        }
      store.transaction(() => {
        for (const table of ['segments', 'materials']) {
          const rows = store.db.prepare(`SELECT id,path FROM ${table}`).all() as {
            id: string;
            path: string;
          }[];
          for (const row of rows)
            if (row.path) {
              const file = assetPath(row.path);
              const newPath = resolve(target, relative(source, file));
              store.db.prepare(`UPDATE ${table} SET path=? WHERE id=?`).run(newPath, row.id);
            }
        }
        store.saveSettings(patch);
      });
      emit({ type: 'changed' });
      return store.settings();
    } finally {
      movingLibrary = false;
    }
  }
  const result = store.saveSettings(patch);
  emit({ type: 'changed' });
  return result;
}
function aiBusy() {
  return store.tasks().some((t) => t.status === 'running' || t.status === 'queued');
}
let emptyingTrash = false;
/** Permanently deletes every lecture in Trash after stopping the AI work queued for them. */
async function emptyTrash(): Promise<{ count: number }> {
  if (emptyingTrash) throw new Error('The trash is already being emptied');
  const trashedIds = () =>
    new Set(
      store
        .snapshot()
        .lectures.filter((l) => l.deletedAt)
        .map((l) => l.id),
    );
  const trashed = trashedIds();
  if (!trashed.size) return { count: 0 };
  if (recording.active && trashed.has(recording.active))
    throw new Error('Stop recording before emptying the trash');
  if (
    store.snapshot().lectures.some((l) => trashed.has(l.id) && l.status === 'importing') ||
    store.materials().some((m) => m.lectureId && trashed.has(m.lectureId) && m.status === 'processing')
  )
    throw new Error('Wait for imports to finish before emptying the trash');
  // Exports and backups read lecture files; deleting them midway would fail those operations.
  if (fileOperations || backupRunning)
    throw new Error('Finish importing, exporting or backing up before emptying the trash');
  emptyingTrash = true;
  try {
    // Aborted requests settle asynchronously; wait until they have observed the cancellation while
    // their task rows still exist, so they finish quietly instead of reporting a failure.
    for (const id of trashed) await ai.cancelLecture(id);
    if (fileOperations || backupRunning || movingLibrary)
      throw new Error('Finish importing, exporting or backing up before emptying the trash');
    // Lectures trashed while waiting are deleted too; cancel their work first.
    for (const id of trashedIds()) if (!trashed.has(id)) await ai.cancelLecture(id);
    return store.trashEmpty();
  } finally {
    emptyingTrash = false;
  }
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 680,
    title: 'LectureDesk',
    backgroundColor: '#f6f7fb',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const current = window?.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', () =>
    recording.interrupt('The interface process stopped. Recover the durable audio segments.'),
  );
  window.on('close', (event) => {
    if (recording.active && !closing) {
      event.preventDefault();
      void dialog
        .showMessageBox(window!, {
          type: 'question',
          title: 'Recording in progress',
          message: 'Stop and save recording before closing?',
          buttons: ['Keep recording', 'Stop and close'],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1) {
            recording.interrupt(
              'Application closed during capture; recover the last segment on next launch.',
            );
            closing = true;
            window?.close();
          }
        });
    }
  });
  window.on('closed', () => {
    window = null;
    closing = false;
  });
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, '../renderer/index.html'));
  window.show();
}

async function boot() {
  store = new Store(join(app.getPath('userData'), 'library'));
  credentials = new Credentials(app.getPath('userData'));
  let keyError = '';
  try {
    await credentials.load();
  } catch (error) {
    keyError = safeError(error);
  }
  ai = new AIService(store, credentials.get, emit);
  const materials = new MaterialService(store, emit),
    portability = new Portability(store);
  for (const m of store.materials().filter((m) => m.status === 'processing')) {
    store.materialUpdate(m.id, {
      status: 'error',
      error: 'Import was interrupted. The original is saved; retry extraction.',
    });
    if (m.lectureId && store.lectureGet(m.lectureId).lecture.status === 'interrupted')
      store.lectureSave({ id: m.lectureId, status: 'ready' });
  }
  recording = new RecordingService(store, {
    append: (id, pcm, offset) => ai.liveAppend(id, pcm, offset),
    pause: (id) => ai.livePause(id),
    end: (id) => {
      ai.liveStop(id);
      ai.flush(id);
    },
    emit,
    wake,
  });
  const ses = session.defaultSession;
  const allowedOrigin = (url: string) =>
    url.startsWith('file:') ||
    (!app.isPackaged &&
      !!process.env.ELECTRON_RENDERER_URL &&
      url.startsWith(process.env.ELECTRON_RENDERER_URL));
  ses.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      contents === window?.webContents &&
      ['media', 'display-capture'].includes(permission) &&
      allowedOrigin(origin) &&
      (permission !== 'media' || details.mediaType !== 'video'),
  );
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = (details as Electron.MediaAccessPermissionRequest).mediaTypes;
    callback(
      contents === window?.webContents &&
        ['media', 'display-capture'].includes(permission) &&
        allowedOrigin(details.requestingUrl) &&
        (permission !== 'media' || !mediaTypes?.includes('video')),
    );
  });
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (
          !request.audioRequested ||
          !allowedOrigin(request.securityOrigin) ||
          request.frame !== window?.webContents.mainFrame
        )
          return callback({});
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: 'loopback' });
      } catch (error) {
        emit({ type: 'error', message: safeError(error) });
        callback({});
      }
    },
    { useSystemPicker: false },
  );
  protocol.handle('lecture-audio', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'segment') return new Response('Not found', { status: 404 });
      const id = url.pathname.slice(1);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return new Response('Not found', { status: 404 });
      const row = store.db.prepare('SELECT path FROM segments WHERE id=?').get(id) as
        { path: string } | undefined;
      if (!row) return new Response('Not found', { status: 404 });
      return audioResponse(
        await checkedAsset(row.path),
        request.headers.get('range'),
        request.method === 'HEAD',
      );
    } catch {
      return new Response('Audio is unavailable', { status: 404 });
    }
  });
  const importFiles = async (paths: string[], context: { lectureId?: string; subjectId?: string }) => {
    fileOperations++;
    try {
      const packages = paths.filter((p) =>
        ['.lecturedesk', '.ldlecture', '.ldbackup'].includes(extname(p).toLowerCase()),
      );
      const results = [];
      for (const file of packages) results.push(await portability.importPackage(file));
      const other = paths.filter((p) => !packages.includes(p));
      if (other.length) results.push(await materials.importPaths(other, context));
      emit({ type: 'changed' });
      return results;
    } finally {
      fileOperations--;
    }
  };
  ipcMain.handle('lecturedesk:call', async (event, name: Method, input: unknown) => {
    try {
      if (!trustedFrame(event) || !METHODS.includes(name))
        throw new Error('Unauthorized application request');
      if (movingLibrary && name !== 'library.get')
        throw new Error('The library is moving. Wait for it to finish and retry.');
      const a = validate(name, input);
      let result: unknown;
      switch (name) {
        case 'library.get':
          return {
            ...store.snapshot(),
            materials: store.materials(),
            hasKey: !!credentials.get(),
            platform: process.platform,
            appVersion: app.getVersion(),
          };
        case 'subject.save':
          result = store.subjectSave(a);
          break;
        case 'subject.delete':
          store.subjectDelete(a.id);
          break;
        case 'lecture.create':
          result = store.lectureCreate(a);
          break;
        case 'lecture.get':
          return store.lectureGet(a.lectureId);
        case 'lecture.save':
          result = store.lectureSave(a);
          break;
        case 'lecture.trash':
          if (recording.active === a.lectureId) throw new Error('Stop recording before moving it to trash');
          store.lectureTrash(a.lectureId);
          break;
        case 'lecture.restore':
          store.lectureRestore(a.lectureId);
          break;
        case 'trash.empty':
          result = await emptyTrash();
          break;
        case 'lecture.recover':
          return recording.recover(a.lectureId);
        case 'version.save':
          result = store.versionSave(a);
          break;
        case 'version.activate':
          store.versionActivate(a.lectureId, a.versionId);
          break;
        case 'settings.save':
          return saveSettings(a);
        case 'folder.choose': {
          const d = await dialog.showOpenDialog(window!, {
            properties: ['openDirectory', 'createDirectory'],
          });
          return d.canceled ? null : d.filePaths[0];
        }
        case 'key.set':
          ai.stop();
          try {
            await credentials.set(a.key);
          } finally {
            ai.start();
          }
          result = { saved: true };
          break;
        case 'key.delete':
          ai.stop();
          try {
            await credentials.delete();
          } finally {
            ai.start();
          }
          result = { deleted: true };
          break;
        case 'key.validate':
          return ai.validateKey(a.key);
        case 'models.list':
          return ai.models();
        case 'audio.sources':
          return {
            platform: process.platform,
            microphone:
              process.platform === 'darwin'
                ? systemPreferences.getMediaAccessStatus('microphone')
                : 'unknown',
            systemAudio:
              process.platform === 'darwin'
                ? 'macOS 15+; ScreenCaptureKit requires Screen & System Audio Recording permission'
                : 'Windows 10+; loopback captures default output',
            supported: ['microphone', 'system', 'both'],
          };
        case 'record.start': {
          if (
            process.platform === 'darwin' &&
            a.mode !== 'microphone' &&
            Number(process.getSystemVersion().split('.')[0]) < 15
          )
            throw new Error('System capture requires supported macOS 15 or newer.');
          if (process.platform === 'darwin' && (a.mode === 'microphone' || a.mode === 'both')) {
            const status = systemPreferences.getMediaAccessStatus('microphone');
            if (status !== 'granted' && !(await systemPreferences.askForMediaAccess('microphone')))
              throw new Error(
                'Microphone permission denied. Enable it in System Settings → Privacy & Security → Microphone.',
              );
          }
          return recording.start(a.lectureId, a.mode);
        }
        case 'record.chunk':
          return recording.chunk(a.lectureId, a.sequence, a.pcm);
        case 'record.pause':
          return recording.pause(a.lectureId);
        case 'record.resume':
          return recording.resume(a.lectureId);
        case 'record.stop':
          return recording.stop(a.lectureId);
        case 'record.gap':
          recording.interrupt(a.reason);
          return;
        case 'audio.url': {
          const segments = store.lectureGet(a.lectureId).segments;
          const segment = a.segmentId ? segments.find((s) => s.id === a.segmentId) : segments[0];
          return {
            url: segment ? `lecture-audio://segment/${segment.id}` : '',
            segments: segments.map((s) => ({ ...s, url: `lecture-audio://segment/${s.id}` })),
          };
        }
        case 'import.pick': {
          const d = await dialog.showOpenDialog(window!, {
            properties: ['openFile', 'multiSelections'],
            filters: [
              {
                name: 'Learning materials',
                extensions: [
                  'm4a',
                  'mp3',
                  'wav',
                  'webm',
                  'mp4',
                  'aac',
                  'flac',
                  'ogg',
                  'opus',
                  'aiff',
                  'wma',
                  'pdf',
                  'docx',
                  'pptx',
                  'txt',
                  'md',
                  'png',
                  'jpg',
                  'jpeg',
                  'webp',
                  'tif',
                  'tiff',
                  'lecturedesk',
                  'ldlecture',
                  'ldbackup',
                ],
              },
            ],
          });
          return d.canceled ? [] : importFiles(d.filePaths, a);
        }
        case 'import.paths':
          return importFiles(a.paths, a);
        case 'material.retry':
          return materials.retry(a.id);
        case 'material.open': {
          const m = store.materials().find((m) => m.id === a.id);
          if (!m) throw new Error('Material not found');
          const error = await shell.openPath(await checkedAsset(m.path));
          if (error) throw new Error(error);
          return;
        }
        case 'export.lecture': {
          if (recording.active === a.lectureId) throw new Error('Stop recording before exporting');
          const detail = store.lectureGet(a.lectureId);
          const extension = a.format === 'audio' ? 'wav' : a.format === 'package' ? 'lecturedesk' : a.format;
          const d = await dialog.showSaveDialog(window!, {
            defaultPath: `${detail.lecture.title.replace(/[<>:"/\\|?*]/g, '_')}.${extension}`,
            filters: [{ name: 'Lecture export', extensions: [extension] }],
          });
          if (d.canceled || !d.filePath) return null;
          fileOperations++;
          try {
            await portability.exportLecture(a.lectureId, a.versionId, a.format, d.filePath);
            return d.filePath;
          } finally {
            fileOperations--;
          }
        }
        case 'backup.create': {
          if (recording.active) throw new Error('Stop recording before making a backup');
          const settings = store.settings();
          const folder = a.folder || settings.backupFolder;
          if (!folder)
            throw new Error('Choose an iCloud Drive or Google Drive desktop backup folder in Settings');
          if (backupRunning) throw new Error('A backup is already running');
          backupRunning = true;
          try {
            result = await portability.backup(
              folder,
              a.includeAudio ?? settings.backupAudio,
              settings.backupRetention,
            );
            lastBackup = Date.now();
          } finally {
            backupRunning = false;
          }
          break;
        }
        case 'backup.list': {
          const folder = a.folder || store.settings().backupFolder;
          return folder ? portability.listBackups(folder) : [];
        }
        case 'backup.preview':
          return portability.preview(a.path);
        case 'backup.restore':
          if (recording.active || aiBusy())
            throw new Error('Stop recording and finish or cancel work before restoring');
          fileOperations++;
          try {
            result = await portability.restore(a.path);
          } finally {
            fileOperations--;
          }
          break;
        case 'action.run':
          return ai.runAction(a);
        case 'action.save':
          result = store.actionSave({ ...a, id: a.id || randomUUID() });
          break;
        case 'action.delete':
          store.actionDelete(a.id);
          break;
        case 'transcript.improve':
          return ai.improve(a.lectureId);
        case 'task.retry':
          return ai.retry(a.id);
        case 'task.cancel':
          return ai.cancel(a.id);
        case 'chat.list':
          return store.conversations();
        case 'chat.create':
          result = store.conversationCreate(a.context, a.mode, a.title);
          break;
        case 'chat.messages':
          return store.messages(a.conversationId);
        case 'chat.send':
          return ai.chatSend(a);
        case 'shell.url': {
          const u = new URL(a.url);
          if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Only web links may be opened');
          await shell.openExternal(u.href);
          return;
        }
      }
      emit({ type: 'changed' });
      return result;
    } catch (error) {
      throw new Error(safeError(error));
    }
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'LectureDesk',
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            } as Electron.MenuItemConstructorOptions,
          ]
        : []),
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'resetZoom' },
          { role: 'togglefullscreen' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' } as Electron.MenuItemConstructorOptions] : []),
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]),
  );
  powerMonitor.on('suspend', () => recording.interrupt('Computer entered sleep; recording interrupted.'));
  powerMonitor.on('shutdown', () => recording.interrupt('Computer shutdown interrupted recording.'));
  setInterval(() => {
    const s = store.settings();
    if (
      !s.backupHours ||
      !s.backupFolder ||
      backupRunning ||
      recording.active ||
      Date.now() - lastBackup < s.backupHours * 3600000
    )
      return;
    backupRunning = true;
    void portability
      .backup(s.backupFolder, s.backupAudio, s.backupRetention)
      .then(() => {
        lastBackup = Date.now();
        emit({ type: 'changed' });
      })
      .catch((e) => emit({ type: 'error', message: `Backup failed: ${safeError(e)}` }))
      .finally(() => {
        backupRunning = false;
      });
  }, 60000).unref();
  ai.start();
  await createWindow();
  if (keyError) emit({ type: 'error', message: keyError });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox('LectureDesk could not start', safeError(error));
      app.quit();
    });
  app.on('activate', () => {
    if (!window && store) void createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    if (recording?.active)
      recording.interrupt('Application quit while recording. Recover the last audio segment.');
    ai?.stop();
  });
  app.on('will-quit', () => {
    if (quitting) store?.close();
  });
}
