'use strict';
// electron-builder afterPack hook (see electron-builder.yml).
// FFmpeg and the PDF canvas come from per-OS/CPU optional npm packages, and npm installs only the
// variant for the CPU of the Node.js that ran `npm ci`. Packaging for another CPU without the matching
// packages would silently produce an installer whose imports/OCR crash at runtime, so fail the build.
//
// Standalone use: node scripts/check-native-binaries.cjs <resources dir> <darwin|win32> <arm64|x64>
const fs = require('node:fs');
const path = require('node:path');

// Same order as builder-util's Arch enum (context.arch is its numeric value).
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

function expectedBinaries(platform, arch) {
  if (platform === 'darwin')
    return [
      { pkg: `@ffmpeg-installer/darwin-${arch}`, file: 'ffmpeg' },
      { pkg: `@napi-rs/canvas-darwin-${arch}`, file: `skia.darwin-${arch}.node` },
    ];
  if (platform === 'win32')
    return [
      { pkg: `@ffmpeg-installer/win32-${arch}`, file: 'ffmpeg.exe' },
      { pkg: `@napi-rs/canvas-win32-${arch}-msvc`, file: `skia.win32-${arch}-msvc.node` },
    ];
  return [];
}

// CPU architectures a PE or Mach-O (thin or fat) file was compiled for.
function binaryArchs(file) {
  const header = Buffer.alloc(4096);
  const fd = fs.openSync(file, 'r');
  let length;
  try {
    length = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (length < 8) return [];
  if (header[0] === 0x4d && header[1] === 0x5a) {
    const pe = header.readUInt32LE(0x3c);
    if (pe + 6 > length || header.readUInt32BE(pe) !== 0x50450000) return [];
    const machine = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[header.readUInt16LE(pe + 4)];
    return machine ? [machine] : [];
  }
  const machCpu = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32' };
  const magic = header.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) return [machCpu[header.readUInt32LE(4)]].filter(Boolean);
  const fatMagic = header.readUInt32BE(0);
  if (fatMagic === 0xcafebabe || fatMagic === 0xcafebabf) {
    const entrySize = fatMagic === 0xcafebabe ? 20 : 32;
    const archs = [];
    for (let i = 0, count = header.readUInt32BE(4); i < count && 8 + (i + 1) * entrySize <= length; i++)
      archs.push(machCpu[header.readUInt32BE(8 + i * entrySize)]);
    return archs.filter(Boolean);
  }
  return [];
}

function check(resourcesDir, platform, arch) {
  const modules = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
  const problems = [];
  for (const { pkg, file } of expectedBinaries(platform, arch)) {
    const binary = path.join(modules, ...pkg.split('/'), file);
    if (!fs.existsSync(binary)) {
      problems.push(`${pkg}/${file} is missing`);
      continue;
    }
    const archs = binaryArchs(binary);
    if (!archs.includes(arch))
      problems.push(`${pkg}/${file} is built for ${archs.join('+') || 'an unrecognized format'}, not ${arch}`);
  }
  if (problems.length)
    throw new Error(
      `Packaged LectureDesk for ${platform}-${arch} has unusable native binaries:\n  - ${problems.join('\n  - ')}\n` +
        `Install dependencies for ${platform}-${arch} before packaging: run npm ci on a native ${platform}-${arch} host ` +
        `(or see README "Develop and build" for the npm --os/--cpu override).`,
    );
  return expectedBinaries(platform, arch).length;
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_NAMES[context.arch];
  if (arch === 'universal' || expectedBinaries(platform, arch).length === 0) {
    console.log(`  • native binary check skipped  platform=${platform} arch=${arch}`);
    return;
  }
  const resourcesDir =
    typeof context.packager.getResourcesDir === 'function'
      ? context.packager.getResourcesDir(context.appOutDir)
      : platform === 'darwin'
        ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
        : path.join(context.appOutDir, 'resources');
  const count = check(resourcesDir, platform, arch);
  console.log(`  • native binaries verified  platform=${platform} arch=${arch} count=${count}`);
};
module.exports.check = check;
module.exports.binaryArchs = binaryArchs;

if (require.main === module) {
  const [resourcesDir, platform = process.platform, arch = process.arch] = process.argv.slice(2);
  if (!resourcesDir) {
    console.error('Usage: node scripts/check-native-binaries.cjs <resources dir> [darwin|win32] [arm64|x64]');
    process.exit(2);
  }
  try {
    const count = check(path.resolve(resourcesDir), platform, arch);
    console.log(`OK: ${count} native binaries match ${platform}-${arch}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
