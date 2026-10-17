export type Language = 'ru' | 'uk' | 'en' | 'pl';
export type AudioMode = 'microphone' | 'system' | 'both';
export type VersionKind = 'original' | 'edited' | 'improved' | 'translation' | 'notes' | 'action';
export interface Settings {
  setupComplete: boolean;
  uiLanguage: Language;
  /** Transcripts may contain only this language plus English. 'auto' is migrated away (schema v3). */
  lectureLanguage: Language;
  /** False until the user explicitly chose the lecture language (wizard, settings or one-time prompt). */
  lectureLanguageConfirmed: boolean;
  outputLanguage: Language;
  theme: 'light' | 'dark' | 'system';
  storageFolder: string;
  audioMode: AudioMode;
  microphoneId: string;
  liveTranscription: boolean;
  liveTranslation: boolean;
  liveAnalysis: boolean;
  finalNotes: boolean;
  translationWords: number;
  translationWaitSeconds: number;
  analysisWords: number;
  analysisIntervalSeconds: number;
  liveModel: string;
  fileModel: string;
  translationModel: string;
  analysisModel: string;
  chatModel: string;
  quality: 'maximum' | 'balanced';
  backupFolder: string;
  backupAudio: boolean;
  backupHours: number;
  backupRetention: number;
}
export interface Subject {
  id: string;
  name: string;
  color: string;
  glossary: string;
  createdAt: string;
}
export interface Lecture {
  id: string;
  subjectId: string | null;
  title: string;
  topic: string;
  date: string;
  tags: string[];
  status: 'ready' | 'recording' | 'paused' | 'interrupted' | 'importing';
  duration: number;
  createdAt: string;
  deletedAt: string | null;
  activeVersionId: string | null;
}
export interface Segment {
  id: string;
  lectureId: string;
  sequence: number;
  start: number;
  end: number;
  path: string;
  text: string;
  /**
   * 'audio': recorded audio kept for backup/playback; its text lives in transcript items.
   * Other statuses belong to legacy recordings and imported audio transcribed per segment.
   */
  status: 'queued' | 'processing' | 'done' | 'error' | 'audio';
  error: string | null;
}
/** One finalized speech turn (live) or silence-split chunk (file) of a lecture, in lecture seconds. */
export interface TranscriptItem {
  id: string;
  lectureId: string;
  start: number;
  end: number;
  text: string;
  /** 'rejected': not in the lecture language or English; hidden from the transcript, audio preserved. */
  status: 'done' | 'rejected';
  source: 'live' | 'file';
  model: string;
  language: string | null;
  error: string | null;
  /** 'live:<windowId>:<item_id>' | 'range:<taskId>:<chunkIndex>' | 'segment:<segmentId>' */
  sourceKey: string;
  createdAt: string;
}
export interface Version {
  id: string;
  lectureId: string;
  kind: VersionKind;
  title: string;
  content: string;
  model: string;
  parameters: Record<string, unknown>;
  sourceVersionId: string | null;
  createdAt: string;
}
export interface Material {
  id: string;
  lectureId: string | null;
  subjectId: string | null;
  name: string;
  path: string;
  mime: string;
  size: number;
  status: 'processing' | 'ready' | 'error';
  error: string | null;
  pages: { page: number; text: string; ocr: boolean }[];
  createdAt: string;
}
export interface Task {
  id: string;
  lectureId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'error' | 'quota' | 'cancelled';
  attempts: number;
  nextRun: number;
  error: string | null;
  createdAt: string;
}
export interface Gap {
  id: string;
  lectureId: string;
  at: number;
  reason: string;
  createdAt: string;
}
export interface CustomAction {
  id: string;
  name: string;
  icon: string;
  instructions: string;
  language: Language;
  model: string;
  format: 'markdown' | 'text' | 'json';
  pinned: boolean;
}
export interface Conversation {
  id: string;
  title: string;
  context: ChatContext;
  mode: ChatMode;
  createdAt: string;
}
export type ChatMode = 'strict' | 'knowledge' | 'web';
export interface ChatContext {
  scope: 'lecture' | 'lectures' | 'subject' | 'library';
  lectureIds: string[];
  subjectId: string | null;
  materialIds: string[];
}
export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: {
    title: string;
    lectureId?: string;
    materialId?: string;
    page?: number;
    start?: number;
    url?: string;
  }[];
  createdAt: string;
}
export interface Usage {
  id: string;
  lectureId: string | null;
  operation: string;
  model: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface Backup {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}
export interface LibrarySnapshot {
  subjects: Subject[];
  lectures: Lecture[];
  materials: Material[];
  tasks: Task[];
  recoverable: Lecture[];
  settings: Settings;
  hasKey: boolean;
  platform: string;
  appVersion: string;
  actions: CustomAction[];
}
export interface LectureDetail {
  lecture: Lecture;
  segments: Segment[];
  items: TranscriptItem[];
  versions: Version[];
  materials: Material[];
  gaps: Gap[];
  usage: Usage[];
}
export interface AppEvent {
  type: 'changed' | 'partial' | 'error' | 'recording-gap' | 'import-progress';
  lectureId?: string;
  segmentId?: string;
  text?: string;
  /** Partial events: lecture seconds where the preliminary phrase starts. */
  start?: number;
  message?: string;
  progress?: number;
}
export const METHODS = [
  'library.get',
  'subject.save',
  'subject.delete',
  'lecture.create',
  'lecture.get',
  'lecture.save',
  'lecture.trash',
  'lecture.restore',
  'lecture.recover',
  'trash.empty',
  'version.save',
  'version.activate',
  'settings.save',
  'folder.choose',
  'key.set',
  'key.delete',
  'key.validate',
  'models.list',
  'record.start',
  'record.chunk',
  'record.pause',
  'record.resume',
  'record.stop',
  'record.gap',
  'audio.sources',
  'audio.url',
  'import.pick',
  'import.paths',
  'material.retry',
  'material.open',
  'export.lecture',
  'backup.create',
  'backup.list',
  'backup.preview',
  'backup.restore',
  'action.run',
  'action.save',
  'action.delete',
  'transcript.improve',
  'task.retry',
  'task.cancel',
  'chat.list',
  'chat.create',
  'chat.messages',
  'chat.send',
  'shell.url',
] as const;
export type Method = (typeof METHODS)[number];
export interface Bridge {
  call<T = unknown>(method: Method, args?: unknown): Promise<T>;
  on(listener: (event: AppEvent) => void): () => void;
  filePath(file: File): string;
}
declare global {
  interface Window {
    lecturedesk: Bridge;
  }
}
export const DEFAULT_SETTINGS: Settings = {
  setupComplete: false,
  uiLanguage: 'ru',
  lectureLanguage: 'ru',
  lectureLanguageConfirmed: false,
  outputLanguage: 'ru',
  theme: 'light',
  storageFolder: '',
  audioMode: 'microphone',
  microphoneId: '',
  liveTranscription: true,
  liveTranslation: false,
  liveAnalysis: false,
  finalNotes: false,
  translationWords: 50,
  translationWaitSeconds: 30,
  analysisWords: 500,
  analysisIntervalSeconds: 60,
  liveModel: 'gpt-4o-transcribe',
  fileModel: 'gpt-transcribe',
  translationModel: 'gpt-6.1-sol',
  analysisModel: 'gpt-6.1-sol',
  chatModel: 'gpt-6.1-sol',
  quality: 'balanced',
  backupFolder: '',
  backupAudio: true,
  backupHours: 0,
  backupRetention: 5,
};
export const MODEL_CATALOG = {
  // First entry = default/maximum preset: server-side turn detection (see turnPolicy in shared/transcript.ts).
  live: ['gpt-4o-transcribe', 'gpt-live-transcribe', 'gpt-transcribe', 'gpt-4o-mini-transcribe'],
  file: ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
  text: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.4', 'gpt-4.1'],
};
