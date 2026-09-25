import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { FileStorage, PutMeta } from './types'
import { signFileToken } from './sign'

/**
 * Local-disk driver. Files live under an opaque random key with a neutral
 * extension — the original name, type, and owner exist only in the database,
 * so a directory listing leaks nothing and a crafted key can't traverse paths.
 */

const KEY_RE = /^[A-Za-z0-9_-]{8,64}\.bin$/

/**
 * Namespaced keys for putAt: one fixed directory, an id-shaped basename, an
 * image extension. As strict as KEY_RE — no dots or slashes can smuggle a
 * traversal, and the namespace can never collide with a document key.
 */
const NAMED_KEY_RE = /^(?:avatars\/[a-z0-9]{10,40}\.(?:jpg|png|webp)|closer-packets\/[a-z0-9]{10,40}\/(?:review|pitch)\.pdf)$/

export class LocalFileStorage implements FileStorage {
  readonly name = 'local'
  private readonly dir: string

  constructor(dir?: string) {
    // The directory is chosen at runtime and holds only uploads, so there is
    // nothing here for the bundler to trace; without the opt-out Turbopack pulls
    // the entire project into the server output.
    this.dir = path.resolve(
      /*turbopackIgnore: true*/ process.cwd(),
      dir ?? process.env.FILE_STORAGE_LOCAL_DIR ?? 'storage/documents',
    )
  }

  private pathFor(key: string): string {
    if (!KEY_RE.test(key) && !NAMED_KEY_RE.test(key)) throw new Error('Invalid storage key.')
    return path.join(this.dir, key)
  }

  async put(buf: Buffer, meta: PutMeta): Promise<{ key: string }> {
    void meta // identity lives in the database, not on disk
    const key = `${randomBytes(16).toString('hex')}.bin`
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.pathFor(key), buf)
    return { key }
  }

  async putAt(key: string, buf: Buffer): Promise<void> {
    if (!NAMED_KEY_RE.test(key)) throw new Error('Invalid named storage key.')
    const target = this.pathFor(key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, buf)
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key))
  }

  async stat(key: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const s = await stat(this.pathFor(key))
      return { mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  }

  async signUrl(key: string, ttlSeconds: number): Promise<string> {
    if (!KEY_RE.test(key)) throw new Error('Invalid storage key.')
    return signFileToken({ key, exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
  }
}
