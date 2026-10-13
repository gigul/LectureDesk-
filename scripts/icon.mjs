import sharp from 'sharp';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await sharp('build/icon.svg').resize(1024, 1024).png().toFile('build/icon.png');
if (process.platform === 'darwin') {
  await mkdir('build/icon.iconset', { recursive: true });
  for (const n of [16, 32, 128, 256, 512]) {
    await sharp('build/icon.svg').resize(n, n).png().toFile(`build/icon.iconset/icon_${n}x${n}.png`);
    await sharp('build/icon.svg')
      .resize(n * 2, n * 2)
      .png()
      .toFile(`build/icon.iconset/icon_${n}x${n}@2x.png`);
  }
  execFileSync('iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns']);
  await rm('build/icon.iconset', { recursive: true });
}
