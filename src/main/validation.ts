import { z } from 'zod';
import { MODEL_CATALOG, type Method } from '../shared/types';
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const str = z.string().max(1000);
const text = z.string().max(4_000_000);
const language = z.enum(['ru', 'uk', 'en', 'pl']);
const audioMode = z.enum(['microphone', 'system', 'both']);
const lectureId = z.object({ lectureId: id }).strict();
const itemId = z.object({ id }).strict();
const context = z
  .object({
    scope: z.enum(['lecture', 'lectures', 'subject', 'library']),
    lectureIds: z.array(id).max(10000),
    subjectId: id.nullable(),
    materialIds: z.array(id).max(10000),
  })
  .strict();
export const settingsSchema = z
  .object({
    setupComplete: z.boolean(),
    uiLanguage: language,
    lectureLanguage: language,
    lectureLanguageConfirmed: z.boolean(),
    outputLanguage: language,
    theme: z.enum(['light', 'dark', 'system']),
    storageFolder: z.string().max(4096),
    audioMode,
    microphoneId: str,
    liveTranscription: z.boolean(),
    liveTranslation: z.boolean(),
    liveAnalysis: z.boolean(),
    finalNotes: z.boolean(),
    translationWords: z.number().int().min(1).max(10000),
    translationWaitSeconds: z.number().min(5).max(300),
    analysisWords: z.number().int().min(1).max(20000),
    analysisIntervalSeconds: z.number().min(10).max(3600),
    liveModel: z.enum(MODEL_CATALOG.live as [string, ...string[]]),
    fileModel: z.enum(MODEL_CATALOG.file as [string, ...string[]]),
    translationModel: z.enum(MODEL_CATALOG.text as [string, ...string[]]),
    analysisModel: z.enum(MODEL_CATALOG.text as [string, ...string[]]),
    chatModel: z.enum(MODEL_CATALOG.text as [string, ...string[]]),
    quality: z.enum(['maximum', 'balanced']),
    backupFolder: z.string().max(4096),
    backupAudio: z.boolean(),
    backupHours: z.number().min(0).max(8760),
    backupRetention: z.number().int().min(1).max(100),
  })
  .partial()
  .strict();
const schemas: Partial<Record<Method, z.ZodType>> = {
  'subject.save': z
    .object({
      id: id.optional(),
      name: z.string().trim().min(1).max(300),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      glossary: z.string().max(10000).optional(),
    })
    .strict(),
  'subject.delete': itemId,
  'lecture.create': z.object({ subjectId: id.nullable().optional(), title: str.optional() }).strict(),
  'lecture.get': lectureId,
  'lecture.recover': lectureId,
  'lecture.trash': lectureId,
  'lecture.restore': lectureId,
  'trash.empty': z.object({}).strict(),
  'lecture.save': z
    .object({
      id,
      subjectId: id.nullable().optional(),
      title: str.optional(),
      topic: str.optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      tags: z.array(z.string().max(100)).max(100).optional(),
    })
    .strict(),
  'version.save': z
    .object({
      lectureId: id,
      kind: z.literal('edited'),
      title: str,
      content: text,
      sourceVersionId: id.nullable().optional(),
    })
    .strict(),
  'version.activate': z.object({ lectureId: id, versionId: id }).strict(),
  'settings.save': settingsSchema,
  'key.set': z.object({ key: z.string().min(20).max(512) }).strict(),
  'key.validate': z.object({ key: z.string().min(20).max(512).optional() }).strict(),
  'record.start': z.object({ lectureId: id, mode: audioMode }).strict(),
  'record.chunk': z
    .object({
      lectureId: id,
      sequence: z.number().int().min(0).max(10_000_000),
      pcm: z.custom<ArrayBuffer>(
        (v) =>
          v instanceof ArrayBuffer && v.byteLength > 0 && v.byteLength <= 96000 && v.byteLength % 2 === 0,
      ),
    })
    .strict(),
  'record.pause': lectureId,
  'record.resume': lectureId,
  'record.stop': lectureId,
  'record.gap': z.object({ lectureId: id, reason: str }).strict(),
  'audio.url': z.object({ lectureId: id, segmentId: id.optional() }).strict(),
  'import.pick': z.object({ lectureId: id.optional(), subjectId: id.optional() }).strict(),
  'import.paths': z
    .object({
      paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
      lectureId: id.optional(),
      subjectId: id.optional(),
    })
    .strict(),
  'material.retry': itemId,
  'material.open': itemId,
  'export.lecture': z
    .object({
      lectureId: id,
      versionId: id.optional(),
      format: z.enum(['txt', 'md', 'docx', 'pdf', 'audio', 'package']),
    })
    .strict(),
  'backup.create': z
    .object({ folder: z.string().max(4096).optional(), includeAudio: z.boolean().optional() })
    .strict(),
  'backup.list': z.object({ folder: z.string().max(4096).optional() }).strict(),
  'backup.preview': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'backup.restore': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'action.run': z
    .object({
      lectureId: id,
      versionId: id.optional(),
      text: text.optional(),
      action: str,
      language: language.optional(),
      customActionId: id.optional(),
    })
    .strict(),
  'action.save': z
    .object({
      id: id.optional(),
      name: z.string().min(1).max(100),
      icon: z.string().max(40),
      instructions: z.string().min(1).max(20000),
      language,
      model: z.string().max(100),
      format: z.enum(['markdown', 'text', 'json']),
      pinned: z.boolean(),
    })
    .strict(),
  'action.delete': itemId,
  'transcript.improve': lectureId,
  'task.retry': itemId,
  'task.cancel': itemId,
  'chat.create': z
    .object({ context, mode: z.enum(['strict', 'knowledge', 'web']), title: str.optional() })
    .strict(),
  'chat.messages': z.object({ conversationId: id }).strict(),
  'chat.send': z.object({ conversationId: id, message: z.string().trim().min(1).max(30000) }).strict(),
  'shell.url': z.object({ url: z.string().url().max(8192) }).strict(),
};
export function validate(method: Method, args: unknown): any {
  const schema = schemas[method];
  if (!schema) {
    if (args !== undefined && args !== null && (typeof args !== 'object' || Object.keys(args).length))
      throw new Error('Unexpected arguments');
    return {};
  }
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success)
    throw new Error(
      `Invalid ${method} request: ${parsed.error.issues
        .map((i) => i.path.join('.') + ': ' + i.message)
        .slice(0, 3)
        .join('; ')}`,
    );
  return parsed.data;
}
