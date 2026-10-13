import { mkdir, stat, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const files = [
  ...['eng', 'rus', 'ukr', 'pol'].map((code) => ({
    path: `ocr/${code}.traineddata.gz`,
    url: `https://tessdata.projectnaptha.com/4.0.0/${code}.traineddata.gz`,
  })),
  {
    path: 'fonts/NotoSans-Regular.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf',
  },
  { path: 'fonts/OFL.txt', url: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/LICENSE' },
];
for (const file of files) {
  const destination = path.join(root, 'resources', file.path);
  try {
    if ((await stat(destination)).size > 100) continue;
  } catch {}
  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Resource download failed ${file.path}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) throw new Error('Invalid resource');
  await writeFile(destination + '.partial', buffer);
  await rename(destination + '.partial', destination);
  console.log(`Bundled ${file.path} (${Math.round(buffer.length / 1024)} KB)`);
}
await mkdir(path.join(root, 'resources/licenses'), { recursive: true });
await copyFile(
  'node_modules/@ffmpeg-installer/ffmpeg/README.md',
  path.join(root, 'resources/licenses/ffmpeg-installer.md'),
);
console.log('Offline OCR and multilingual PDF resources ready.');
