import { describe, it, expect } from 'vitest';
import { validate } from '../src/main/validation';
describe('privileged IPC validation', () => {
  it('rejects unsupported settings, credential leaks and mismatched models', () => {
    expect(() => validate('settings.save', { apiKey: 'sk-example' })).toThrow();
    expect(() => validate('settings.save', { liveModel: 'gpt-6-astra' })).toThrow();
    expect(() => validate('settings.save', { analysisModel: 'gpt-transcribe' })).toThrow();
  });
  it('only allows user edits as new versions', () => {
    expect(() =>
      validate('version.save', { lectureId: 'id', kind: 'original', title: 'replace', content: 'x' }),
    ).toThrow();
    expect(
      validate('version.save', { lectureId: 'id', kind: 'edited', title: 'Edit', content: 'x' }),
    ).toMatchObject({ kind: 'edited' });
  });
  it('caps recording batches and rejects arbitrary parameter payloads', () => {
    expect(() =>
      validate('record.chunk', { lectureId: 'id', sequence: 0, pcm: new ArrayBuffer(100000) }),
    ).toThrow();
    expect(() => validate('lecture.save', { id: 'id', status: 'ready', path: '/private/key' })).toThrow();
    expect(() =>
      validate('chat.create', {
        context: { scope: 'library', lectureIds: [], subjectId: null, materialIds: [], shell: 'rm' },
        mode: 'strict',
      }),
    ).toThrow();
  });
});
