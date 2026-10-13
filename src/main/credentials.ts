import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Ciphertext is outside library assets, never part of a portable package or backup. */
export class Credentials {
  private key: string | null = null;
  private path: string;
  constructor(userData: string) {
    this.path = join(userData, 'credentials', 'openai.encrypted');
  }
  get = () => this.key;
  async load() {
    try {
      const encrypted = await fs.readFile(this.path);
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        throw new Error('OS secure credential storage is unavailable');
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      this.key = decrypted.result;
      if (decrypted.shouldReEncrypt) await this.set(this.key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('The saved API key could not be unlocked. Replace the key in Settings.');
    }
  }
  async set(value: string) {
    const key = value.trim();
    if (key.length < 20 || key.length > 512 || /[\r\n\s]/.test(key))
      throw new Error('Invalid API key format');
    if (!(await safeStorage.isAsyncEncryptionAvailable()))
      throw new Error('OS secure credential storage is unavailable');
    const encrypted = await safeStorage.encryptStringAsync(key);
    await fs.mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const partial = `${this.path}.partial`;
    await fs.writeFile(partial, encrypted, { mode: 0o600 });
    await fs.rename(partial, this.path);
    this.key = key;
  }
  async delete() {
    this.key = null;
    await fs.rm(this.path, { force: true });
  }
}
export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Operation failed';
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 1200);
}
