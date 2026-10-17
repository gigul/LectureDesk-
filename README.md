# LectureDesk

Local desktop workspace for lectures: microphone/system recording, OpenAI transcription, translations, notes, source-scoped chat, learning materials, versions, exports and folder backups.

[Инструкция пользователя на русском](docs/USER_GUIDE_RU.md).

## Install

| Computer | Installer | Status |
| --- | --- | --- |
| Mac with Apple Silicon (M-series), macOS 15+ | `LectureDesk-0.1.0-mac-arm64.dmg` (or `.zip`) | Validated on hardware (see [validation](docs/VALIDATION.md)) |
| Mac with an Intel processor, macOS 15+ | `LectureDesk-0.1.0-mac-x64.dmg` (or `.zip`) | Configured to build on a native Intel runner; **not yet built in CI or run on Intel Mac hardware** |
| Windows 10/11 PC with a 64-bit Intel or AMD processor | `LectureDesk-0.1.0-windows-x64-setup.exe` | Native Windows x64 build; hardware validation still required |

macOS: pick the DMG for your processor (Apple menu → **About This Mac** shows **Chip: Apple M…** for arm64, or **Processor: … Intel …** for x64), open it and drag LectureDesk into Applications. Minimum macOS **15.0** (Sequoia), the version LectureDesk was validated on. Intel Macs that can run macOS 15 are: MacBook Pro 2018 and later, MacBook Air 2020, iMac 2019 and later, iMac Pro 2017, Mac mini 2018 and Mac Pro 2019. Older Intel Macs cannot install macOS 15 and are not supported. Recording, system-audio capture, OCR/PDF import and FFmpeg import have so far only been exercised on Apple Silicon; please report problems with the Intel build. System audio uses ScreenCaptureKit with the normal **Screen & System Audio Recording** permission. This development distribution is **unsigned and not notarized**. macOS may block its first launch; inspect the source and use the normal **Privacy & Security → Open Anyway** process if you trust the build. Do not disable Gatekeeper. Stable public distribution needs Developer ID signing and notarization (below).

Windows x64: build the NSIS installer on Windows, or run the included GitHub Actions workflow. Install `LectureDesk-0.1.0-windows-x64-setup.exe`. Windows 10/11 x64 (Intel or AMD) is the target; Windows on Arm is not a build target. Actual hardware validation is still required. Users of installers do **not** need Node, Python or other developer tools.

## First use

The setup wizard selects interface language (Русский / Українська / English / Polski), lecture language and translation language independently. Connect your own API key, choose model quality, test the audio source, choose an asset folder and optionally configure folder backups and a subject. Key entry may be skipped to record and manage materials locally.

Get an API key from the [OpenAI API dashboard](https://platform.openai.com/api-keys). API billing is separate from a ChatGPT subscription. Paste the key only into the key field in LectureDesk Settings, validate it, then save it. Model choices are task-specific and checked against your account's model list. No automatic model downgrade occurs after an error. API model listing confirms visibility; task-specific permission or quota errors can still occur when an operation runs.

The library and audio live on your computer. When you enable AI, selected audio/text is sent to OpenAI. Chat web search requires the separately selected web mode. Image/PDF OCR is local and works with bundled language files; handwriting recognition is fallible. No cloud registration is required.

## Use

- Create subjects and select one before recording, or record in Unfiled. Deleting a subject retains its lectures. Lecture deletion moves it to Trash and is reversible.
- Choose microphone, system audio, or both in Settings. Use headphones when mixing microphone and speakers to avoid recording the same sound twice. Start, pause/resume, stop; saved segments appear in the built-in player.
- Recording saves every audio batch to disk before network processing. Offline audio remains local. Recover an interrupted recording from the banner after reopening. Each interruption is listed as a gap.
- Imported audio is copied intact and converted into independent PCM WAV segments by bundled FFmpeg. Imported PDF/PPTX text keeps page/slide references; DOCX retains paragraphs as one logical document because page breaks depend on a document renderer. Scanned PDFs and images are marked as OCR.
- Original finalized transcripts are immutable. Editing, improving from audio, translation, actions and notes create separate versions with provenance. Improving audio performs additional billable transcription operations. Text rephrasing is a different action.
- Live translation and analysis have independent switches and thresholds. Notes distinguish cited lecture facts from AI explanations. Final notes use section processing and synthesis over all completed source text.
- Chat lets you select a lecture, multiple lectures, subject, library and explicit files. Ordinary questions use a local SQLite FTS index; summary requests process all selected passages before synthesis. Strict, general-knowledge and web modes are visibly separate. Conversations are stored locally. Source citations are supplied; generated citations and answers still require normal human review.
- Export TXT, Markdown, DOCX, PDF, ordered audio WAV, or a portable `.lecturedesk` lecture archive. Import a lecture archive to copy it into this library. Backups use `.ldbackup` archives and can be previewed/restored without overwriting current lectures.
- Select an existing iCloud Drive or Google Drive folder managed by the provider's desktop client for backups. The app creates coherent local SQLite snapshots, SHA-256 integrity manifests and atomically finalizes ZIP archives. This is **backup**, not bidirectional synchronization. An unavailable/incomplete cloud file is reported as an error.

## Develop and build

Node 22.16+ and npm are development prerequisites. FFmpeg and the PDF canvas are prebuilt per OS **and CPU** (`@ffmpeg-installer/<os>-<arch>`, `@napi-rs/canvas-<os>-<arch>` optional dependencies), and `npm ci` installs only the variant matching the CPU of the Node.js that runs it. Build each installer on a native host or runner.

```sh
npm ci
npm run resources
npm run icon
npm run dev
```

```sh
npm run verify
npm run dist:mac:arm64  # Apple Silicon Mac: release/LectureDesk-<version>-mac-arm64.dmg/.zip, app in release/mac-arm64/
npm run dist:mac:x64    # Intel Mac:         release/LectureDesk-<version>-mac-x64.dmg/.zip, app in release/mac/
npm run dist:mac        # Mac, CPU of the Node.js running the build (same as one of the two above)
npm run dist:win        # Windows x64:       release/LectureDesk-<version>-windows-x64-setup.exe, app in release/win-unpacked/
```

Every packaging run ends with an `afterPack` check (`scripts/check-native-binaries.cjs`) that fails the build if the packaged app lacks the FFmpeg or PDF canvas binary for the target OS/CPU, or if that binary is compiled for another CPU. A cross-CPU build without matching dependencies therefore stops instead of producing an installer that fails at import time.

Intel build on an Apple Silicon Mac (fallback; prefer the `macos-15-intel` CI job or a real Intel Mac). npm 10.1+ `--os`/`--cpu` overrides make `npm ci` install the Intel variants of optional native packages instead of the host's:

```sh
npm ci && npm run resources && npm run build   # build out/ with the native arm64 toolchain
npm ci --os=darwin --cpu=x64                   # swap optional native packages to darwin-x64
npx electron-builder --mac --x64 --publish never
npm ci                                         # restore arm64 packages for development
```

The override swaps every optional native package, including build tools (esbuild, Rollup, sharp), so do not run `npm run build`/`dev`/`test` between the second and last commands. Alternatively run the whole toolchain under Rosetta 2 with an x86_64 Node.js; then `npm ci` installs Intel packages and `npm run dist:mac:x64` behaves as on an Intel Mac. Neither fallback has been exercised yet; the `afterPack` check verifies the result either way.

`npm run resources` downloads open-source OCR trained data and a Noto Sans font once at build time. These are bundled in installers; end users need no downloads for OCR. FFmpeg's platform binary, Tesseract WASM/worker and the native PDF canvas package are packaged with the app. See resource licenses in `resources/` and dependency licenses. FFmpeg distributor/license obligations must be reviewed before public redistribution.

`.github/workflows/build.yml` builds unsigned installers on native GitHub-hosted runners on a `v*` tag or manual dispatch: macOS arm64 on `macos-15`, macOS x64 on `macos-15-intel`, Windows x64 on `windows-latest`. Each job runs `npm ci`, `npm run verify` (so the Intel job also runs the test suite against the Intel FFmpeg and canvas binaries) and the matching `dist:*` script, then uploads the DMG/ZIP/EXE as workflow artifacts. Intel macOS runner images have a limited lifetime; if `macos-15-intel` is retired, switch the label to a current Intel image from [GitHub's runner list](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), a self-hosted Intel Mac, or the fallback above. No credentials are embedded. `.gitignore` excludes `node_modules/`, `out/` and `release/`; `package-lock.json` pins dependencies.

Run the accelerated persistence test separately:

```sh
LECTUREDESK_LONG_TEST=1 npx vitest run tests/recording.test.ts
```

This simulation generates four hours of PCM into disk segments in accelerated time. It is **not** a physical four-hour capture test.

Run packaged integration checks with an isolated temporary profile:

```sh
node scripts/smoke.mjs release/mac-arm64/LectureDesk.app/Contents/MacOS/LectureDesk
node scripts/packaged-material-smoke.mjs release/mac-arm64/LectureDesk.app/Contents/MacOS/LectureDesk
node scripts/capture-smoke.mjs release/mac-arm64/LectureDesk.app/Contents/MacOS/LectureDesk
node scripts/credentials-smoke.mjs release/mac-arm64/LectureDesk.app/Contents/MacOS/LectureDesk
```

These paths are for the Apple Silicon build, which the scripts also use by default. On an Intel Mac pass `release/mac/LectureDesk.app/Contents/MacOS/LectureDesk`; on Windows `scripts/smoke.mjs` accepts `release/win-unpacked/LectureDesk.exe`.

The last check requests real microphone/system permissions. It uses actual captured PCM and a quiet external test tone, without synthetic microphone devices. Its current tone player is macOS-specific; Windows capture validation must be performed on Windows hardware. Integration results are saved in `docs/*-result.json`.

## Architecture and data safety

`src/shared` contains DTOs and the fixed IPC allowlist. `src/renderer` is React with no Node integration, context isolation, sandbox and CSP. `src/preload` exposes one validated command channel, event subscription and Electron's dropped-file path resolver; no key or privileged objects are returned. Only the app's main frame can call IPC. Audio is served by a segment-ID protocol whose filesystem resolution stays inside library assets. External links permit HTTP(S) only. Imported content is rendered as escaped React nodes and treated as evidence, never executable application instructions.

`src/renderer/audio` uses an AudioWorklet on one 24 kHz clock. Chromium resamples device inputs, gains mix sources, a compressor limits peaks, and bounded 250 ms PCM batches go through IPC. `src/main/recording.ts` fsyncs batches into recoverable partial files and atomically creates independent 10-second WAVs. These WAVs are only the durable backup and playback copy; they are never the unit of transcription. A maximum 16-batch renderer backlog stops and marks capture instead of accumulating unlimited memory. The application prevents automatic idle sleep during capture; forced sleep, disconnects and process failure are interruptions.

`src/main/store.ts` owns SQLite migrations, WAL durability, originals, tasks and metadata. The database stays in the app's local data directory even when an asset folder changes. Originals have SQL update/delete guards. Moving assets copies audio/materials/imports/restored files before updating database references; the old folder remains available for manual cleanup.

`src/main/ai*` holds production HTTP/WebSocket adapters, the durable two-operation queue, controlled retries, quota errors, cancellation, cache keys, stable ordering and bounded-context analysis/retrieval. Live transcription streams the durable audio continuously to one realtime session per window: `gpt-4o-transcribe` (default) lets OpenAI detect speech turns (`semantic_vad`, falling back to `server_vad`), while `gpt-live-transcribe`/`gpt-transcribe` require turn detection off and LectureDesk commits only at pauses it detects locally. Every window owns a durable `transcribe-range` task; audio the live session did not confirm (connection loss, timeouts, the 60-minute session limit) is transcribed from disk by splitting the saved PCM only at silences, never at fixed 10-second marks. With live transcription off, the recording is transcribed from disk after stop. Transcripts may contain only the selected lecture language plus English; other languages are retried with a strict language hint and otherwise hidden as warnings while the audio is kept. Silence is never sent on its own. Preliminary text never drives translation/analysis. Timestamps mark the start of each spoken phrase, not invented word alignment. Where Whisper supplies timestamps, raw provider timestamps are stored with usage/provenance.

`src/main/materials.ts` owns validated imports and local extraction/OCR. `src/main/portability.ts` owns exports, safe archive staging, hash validation, consistent snapshots and transactional ID-remapped merge restores. Restores do not overwrite existing records. Archives contain library data only, never the key store. Cancelled API calls can still incur provider charges for work already processed; result storage checks prevent late cancelled results from being adopted.

API credentials are encrypted by Electron's asynchronous `safeStorage`, using macOS Keychain or Windows DPAPI. Ciphertext lives outside library assets. Plaintext exists only in the temporary input field and main-process memory for API headers. Replace/delete from Settings. Windows DPAPI protects against other OS users, not processes already running as the same user. Unsigned macOS builds may prompt Keychain again after updates.

## API references checked during implementation

Checked against current official documentation on 3 October 2026:

- [File transcription](https://developers.openai.com/api/docs/guides/speech-to-text): 25 MB files, supported formats, language hints, current transcription models and timestamp capabilities.
- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription): PCM 24 kHz, session schema, deltas/finals, item ordering, `gpt-live-transcribe`, manual commit and language hints.
- [Realtime WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime) and [session management](https://developers.openai.com/api/docs/guides/realtime-conversations).
- [Models](https://developers.openai.com/api/docs/models), [Responses](https://developers.openai.com/api/docs/guides/text), [web search](https://developers.openai.com/api/docs/guides/tools-web-search).
- [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer), [display media](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts), [secure storage](https://www.electronjs.org/docs/latest/api/safe-storage).

Balanced default: specialized live/file speech models and GPT-6.1 Sol text. Maximum quality preset: specialized speech models and GPT-6 Astra text. The current preset is not a claim that one model is best for every accent/course. Real lecture evaluation and account access determine the appropriate model. Usage metadata is displayed when returned; no fabricated dollar estimates are shown.

## Signing and notarization

The included build intentionally has no distribution certificate. On macOS, obtain an Apple Developer **Developer ID Application** certificate, export it securely, configure electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD`, use a stable signing identity, and notarize with Apple's `notarytool` credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) using electron-builder notarization support. Staple/verify the notarization ticket and check `codesign --verify --deep --strict` and `spctl --assess` before publication. Keep certificates and passwords in CI secrets, never source.

On Windows, configure an Authenticode certificate or Azure Trusted Signing with electron-builder; timestamp the signature and verify with `signtool verify /pa`. SmartScreen reputation is separate from an installer successfully building.

See [validation and limitations](docs/VALIDATION.md) for the exact checks completed and checks that still require target hardware, microphone consent or paid API access.
