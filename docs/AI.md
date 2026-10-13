# OpenAI processing and recovery

Production code lives in `src/main/ai-provider.ts` (HTTP/WebSocket adapter), `ai.ts` (durable orchestration), `ai-retrieval.ts` (local scoped FTS5 index), and `ai-logic.ts` (ordering, chunking, and retries). Only the Electron main process obtains the secure credential. Provider adapters can be replaced through `AIOptions`; fixture adapters exist only in automated tests.

## Official documentation checked on 3 October 2026

- [Model catalog](https://developers.openai.com/api/docs/models): `gpt-6.1-sol` balances quality and cost; the maximum quality preset uses `gpt-6-astra`.
- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription): `gpt-live-transcribe`, 24 kHz PCM, manual commits, transcript deltas/finals, plural `languages`, vocabulary `keywords`, and `delay: medium`. Turn detection is null for this model.
- [Realtime sessions](https://developers.openai.com/api/docs/guides/realtime-conversations): 60 minute lifetime; LectureDesk renews at a persisted audio segment boundary after 55 minutes, including after a long pause.
- [Realtime WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime): main-process authenticated socket transport. Committed item IDs reconcile final transcript events that may finish in a different order.
- [File transcription](https://developers.openai.com/api/docs/guides/speech-to-text): `gpt-transcribe`, 25 MB file limit, supported audio formats and vocabulary/language context. Imports are converted to bounded WAV files. Whisper alone supports the requested provider timestamp granularities.
- [Responses text generation](https://developers.openai.com/api/docs/guides/text): `instructions`, text input and text output; responses are sent with `store: false`.
- [Web search](https://developers.openai.com/api/docs/guides/tools-web-search): hosted `web_search` is supplied only for explicitly selected web chat mode. URL citation annotations are preserved and shown as clickable source links.

The curated compatibility catalog is filtered by the account's `/v1/models` response after key validation. Access and quotas still depend on the user's account; errors never silently substitute a different model. Live and file processing have independently selected models. No monetary estimate is fabricated from token or audio usage.

## Durability and costs

Audio is saved before `liveAppend`. Each finalized disk segment receives a persistent fallback transcription task. A successfully committed realtime turn postpones that file task for up to 45 seconds. A finalized realtime transcript marks the saved segment and task done, so the normal live path does not also upload its WAV file. On disconnect or delayed finalization, the selected file model processes the saved file. An interrupted or timed-out request might already have been billed by the provider; fallback cannot guarantee avoidance of that charge.

Queued API work runs with concurrency two. Transport failures retry indefinitely with exponential backoff capped at two minutes. Transient server/rate-limit errors retry at most five attempts, respecting Retry-After. Authentication, model/configuration, local-file errors and exhausted billing quotas remain visibly actionable. Removing the key pauses paid work; replacing it stops outstanding requests and resumes saved work. Cancellation aborts the request, prevents saving its result, and preserves source audio and immutable originals.

Task fingerprints cache identical text actions by source version, selected text, model, language, action instructions and format. Section processing and retranscription persist checkpoints. Already saved checkpoints and versions are reused on restart. There remains an unavoidable interruption window between a completed paid provider response and its first successful local database write.

Translation and live notes consume only an ordered prefix of finalized segments. Preliminary deltas never trigger AI analysis. Translation waits for the word threshold plus a sentence boundary, or the maximum wait, and flushes remaining text after transcription completes. A changed target language applies to subsequent text; translating the entire recording requires the explicit whole-recording action. Final notes map every source section and synthesize the section results through bounded requests. Originals and final notes wait for explicit recovery to finish an interrupted recording.

## Context and limitations

Chat builds a persistent Unicode FTS5 passage index from selected lectures' active versions, transcript segments, and selected/associated material pages. Scope filtering happens before a passage can enter an API request. Trashed lectures are excluded from implicit library and subject scopes. Retrieval includes prefix matching and common four-language study vocabulary, but does not provide general semantic or arbitrary cross-language vector search. A summary request maps all passages from all selected sources, rather than summarizing only the retrieved top passages.

Strict mode explicitly reports missing evidence. Knowledge and web modes request clearly distinguished additional knowledge. Source text is treated as untrusted data. The AI adapter exposes no application actions, command execution or filesystem tools to chat models.

Current live models provide no precise word alignment. LectureDesk displays honest audio-segment timestamps. Whisper's returned segment timestamps and detected languages are preserved in operation usage data. Quality, real service latency, account access, long real sessions, and multilingual real recordings still require paid API validation with representative audio; mocked adapter tests do not establish those outcomes.
