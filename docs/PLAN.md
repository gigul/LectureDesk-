# LectureDesk implementation plan

1. Confirm current API schemas and audio capture feasibility. Electron 44.5.1; macOS ARM64 15+ ScreenCaptureKit, Windows x64 10+ loopback. Native runtimes bundled by Electron; SQLite node:sqlite avoids native addon ABI rebuilds.
2. Local SQLite migrations, library, immutable versions, encrypted OS key storage and strict isolated IPC.
3. AudioWorklet PCM24k capture/mix -> fsync disk batches -> independent WAV segments, ordered IDs, recovery, playback, gaps, sleep blocker. Recording has no network dependency.
4. Main-only OpenAI sockets/REST + durable background queue, streaming/final text, reconnect/renew, file splitting, translation and evidence-grounded notes.
5. Scoped retrieval chat, custom actions, preserved attachments, extraction/OCR, separate result versions.
6. Portable package, exports, atomic validated backups, recovery preview, four-language UI, dark/light and first-launch wizard.
7. Critical automated tests, real packaged macOS capture probe and smoke tests, unsigned ARM64 DMG/APP, native Windows CI installer, honest test matrix and signing instructions.

No API key or paid account is assumed. Availability must be validated using the user's own key. Actual Windows hardware, live paid responses, 4-hour physical capture, signing/notarization require external resources and cannot be claimed from simulation.
