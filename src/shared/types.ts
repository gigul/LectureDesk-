export type Language = 'ru' | 'uk' | 'en' | 'pl';
export type AudioMode = 'microphone' | 'system' | 'both';
export type VersionKind = 'original' | 'edited' | 'improved' | 'translation' | 'notes' | 'action';
export interface Settings {
  setupComplete: boolean;
  uiLanguage: Language;
  lectureLanguage: Language | 'auto';
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
  status: 'queued' | 'processing' | 'done' | 'error';
  error: string | null;
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
  lectureLanguage: 'auto',
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
  liveModel: 'gpt-live-transcribe',
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
  live: ['gpt-live-transcribe', 'gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
  file: ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
  text: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.4', 'gpt-4.1'],
};
