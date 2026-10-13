# Validation and release status

Validation date: 3 October 2026. Host: macOS ARM64 (Darwin 27.2), Node 22.16, Electron 44.5.1. All temporary test libraries are isolated from the user's library. No real OpenAI API key was provided and no paid API call was made.

## Automated checks

`npm run typecheck`, production build and `npm test` pass. The current suite has **72 passed tests and one deliberately skipped accelerated long-duration test** across eight files. The separate four-hour persistence run passed all ten recording tests.

| Area | Evidence covered |
| --- | --- |
| Durable recording | Exact PCM ordering across independent WAV boundaries; duplicate IPC acknowledgement; pause-tail flushing/resume; crash-partial recovery; orphan WAV reconciliation; conflicting partial retention; corrupt originals preserved; restart guards; database failure during stop and interruption; bounded memory in accelerated disk simulation |
| Audio acquisition | Test-only browser device adapters verify that the system picker runs before asynchronous IPC/microphone consent, missing audio fails visibly, permission denial releases already granted tracks, and closing a pending picker releases late grants |
| AI queue | Test-only HTTP/WebSocket adapters verify reconnect/file fallback, out-of-order events, cancellation, offline/backoff/quota states, session renewal, persisted checkpoints, immutable original finalization, and section coverage for final notes |
| Scoped chat | Local FTS retrieval, explicit scope/trash exclusion, strict/general/web modes, whole-scope summary coverage, history, and saved-answer reconciliation |
| Local storage | Real SQLite migrations, restart durability, subject deletion preserving lectures, original guards, search, version references, and unknown settings filtering |
| Imports and OCR | Real FFmpeg splitting/conversion, original audio preservation, document parsers, text PDF extraction, scanned PDF/image OCR, page/slide references, invalid input handling, and retry |
| Export and backups | Real TXT/MD/DOCX/PDF and audio exports, portable archive round trip, SQLite snapshots, hash checks, corruption/path/symlink rejection, retention, non-destructive merge restore, unfinished PCM retention, credential exclusion, and pending AI checkpoint reference remapping |
| IPC | Method allowlist, strict argument schemas, invalid values rejected, and renderer version creation restricted to user edits |
| Audio playback transport | Explicit finite content lengths, exact full/ranged WAV bytes, suffix/open-ended ranges, HEAD handling, and invalid/out-of-bounds range rejection |

The separately run four-hour simulation writes 14,400 seconds of PCM: **1,440 WAV segments and 691,200,000 PCM bytes**. Its RSS growth assertion is below 192 MiB. The default ten-minute simulation asserts below 128 MiB. These are accelerated persistence tests, **not physical recordings lasting four hours**.

## Packaged application checks

`scripts/smoke.mjs` launches the actual `.app` with a temporary profile. It verifies onboarding, IPC, local create/import/version, light/dark rendering, backup preview/restore, Trash recovery, safe subject deletion, external protocol rejection, and no renderer errors. The reproducible result is in [smoke-result.json](smoke-result.json), with screenshots in [screenshots](screenshots/).

`scripts/packaged-material-smoke.mjs` passed outside the repository: bundled PDF worker/native canvas/resource paths, real multilingual PDF/DOCX/TXT import, offline image/scanned PDF OCR, and all four document exports opened through the production parsers. The image/scanned-page samples are English; multilingual text preservation is checked separately. See [packaged-material-result.json](packaged-material-result.json).

`scripts/capture-smoke.mjs` verified real microphone/system/both capture on this Mac, with actual live MediaStream tracks, nonzero saved PCM, pause/resume, and durable WAV segments. The production ScreenCaptureKit configuration is recorded explicitly in [capture-result.json](capture-result.json), including the exact tested app archive hash. These are short hardware checks, not four-hour physical recordings. Final playback checks require finite duration, successful seek completion, rate 1.5 and advancing playback position.

`scripts/credentials-smoke.mjs` passed using an explicitly invalid test-only key in a temporary profile: OS-backed encryption, ciphertext outside assets, restart decryption, deletion across restart, and inspecting every backup archive member for credential exclusion. No key validation/network call was made. See [credentials-result.json](credentials-result.json).

## Platform and distribution requirements

The supported Mac target is **Apple Silicon with macOS 15+**. System capture uses ScreenCaptureKit; microphone and system recording require the corresponding OS permissions. Windows uses Electron loopback for the default output device and microphone capture through Chromium.

On this Mac, Electron's default CoreAudio Tap/native-picker route returned no live system audio. The real ScreenCaptureKit probe succeeded, so production disables `MacCatapLoopbackAudioForScreenShare` using Electron's documented compatibility switch and selects a screen for audio loopback. Video tracks are disabled, never recorded or sent to AI. Electron is pinned to 44.5.1: this switch is removed in Electron 45 and an upgrade requires revalidating physical capture. See the [Electron 44 desktop-capture caveat](https://www.electronjs.org/docs/latest/api/desktop-capturer#macos-versions-142-or-higher) and [upstream source documentation](https://github.com/electron/electron/blob/main/docs/api/desktop-capturer.md).

The ARM64 `.app` and DMG are development distributions. **No Developer ID certificate, signing or notarization is supplied.** Gatekeeper acceptance on another person's Mac has not been verified. README includes normal signing/notarization instructions; no security protections are disabled.

Windows has a native NSIS build command and a [GitHub Actions workflow](../.github/workflows/build.yml). This Mac environment has not built, launched, or tested the Windows installer. Native Windows dependencies must be installed and packaged on the Windows runner. The workflow itself has not been dispatched from this environment.

`npm audit --omit=dev` reports zero runtime vulnerabilities. The full development audit currently reports eight high-severity entries along electron-builder's transitive `@electron/get` → `got` → `http-cache-semantics` dependency chain. The current registry release of the underlying package is still reported affected; no forced downgrade was applied. These build-tool packages are not included as runtime app dependencies.

## Still unverified

- Paid OpenAI requests, account-specific model availability/quota, real multilingual transcription quality/latency and long real API sessions. HTTP/WebSocket tests use clearly separated test providers.
- Physical four-hour recordings and multi-hour mixed-source drift/echo behavior.
- Real disk exhaustion, forced OS sleep, unplugging devices, OS revocation, and hard power loss. Recovery/error logic is tested with controlled failures; target-hardware fault tests remain necessary.
- Windows device capture, secure storage, installer behavior, FFmpeg/PDF native dependencies and SmartScreen.
- Secure credential-store recovery across signed upgrades and OS accounts; the API key is never included in library archives.
- Actual iCloud Drive/Google Drive upload/download interruptions. Coherent local backups and incomplete/corrupt archive rejection are tested; the app does not implement bidirectional cloud synchronization.
- OCR accuracy for arbitrary Russian/Ukrainian/Polish scans, handwriting, complex layouts and lecture audio quality. All four language resources are bundled; resource presence is not a quality guarantee.

Long lecture audio is exported as ordered lossless PCM WAV. Imported originals remain intact in attached materials/portable packages; DOCX page numbering is intentionally not invented because pagination depends on a document renderer. Transcripts navigate at honest segment timestamps rather than presenting approximate word alignment as exact.
