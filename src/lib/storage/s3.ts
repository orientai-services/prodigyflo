import { randomBytes } from 'node:crypto'
import type { FileStorage, PutMeta } from './types'
import { signFileToken } from './sign'

/**
 * S3 / Spaces driver. Production documents go here — never local disk, never
 * in-memory. Same interface as LocalFileStorage so callers do not branch.
 */
const KEY_RE = /^[A-Za-z0-9_-]{8,64}\.bin$/
const NAMED_KEY_RE = /^avatars\/[a-z0-9]{10,40}\.(jpg|png|webp)$/

export class S3FileStorage implements FileStorage {
  readonly name = 's3'
  private client: { send: (cmd: unknown) => Promise<unknown> } | null = null
  private readonly bucket: string
  private readonly prefix: string

  constructor() {
    const bucket = process.env.FILE_STORAGE_BUCKET || process.env.DO_SPACES_BUCKET
    if (!bucket) throw new Error('FILE_STORAGE_BUCKET (or DO_SPACES_BUCKET) is required for the s3 driver.')
    this.bucket = bucket
    this.prefix = (process.env.FILE_STORAGE_PREFIX ?? 'documents').replace(/\/$/, '')
  }

  private async s3() {
    if (this.client) return this.client
    const mod = await import('@aws-sdk/client-s3')
    const endpoint = process.env.FILE_STORAGE_ENDPOINT || process.env.DO_SPACES_ENDPOINT
    this.client = new mod.S3Client({
      region: process.env.FILE_STORAGE_REGION || process.env.DO_SPACES_REGION || 'us-east-1',
      endpoint: endpoint || undefined,
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.FILE_STORAGE_ACCESS_KEY || process.env.DO_SPACES_KEY || '',
        secretAccessKey: process.env.FILE_STORAGE_SECRET_KEY || process.env.DO_SPACES_SECRET || '',
      },
    })
    return this.client
  }

  private objectKey(key: string): string {
    if (!KEY_RE.test(key) && !NAMED_KEY_RE.test(key)) throw new Error('Invalid storage key.')
    return `${this.prefix}/${key}`
  }

  async put(buf: Buffer, meta: PutMeta): Promise<{ key: string }> {
    void meta
    const key = `${randomBytes(16).toString('hex')}.bin`
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await (await this.s3()).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: buf, ACL: 'private' }),
    )
    return { key }
  }

  async putAt(key: string, buf: Buffer): Promise<void> {
    if (!NAMED_KEY_RE.test(key)) throw new Error('Invalid named storage key.')
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await (await this.s3()).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: buf, ACL: 'private' }),
    )
  }

  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const res = await (await this.s3()).send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
    )
    const body = res.Body as { transformToByteArray(): Promise<Uint8Array> }
    return Buffer.from(await body.transformToByteArray())
  }

  async stat(key: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
      const res = await (await this.s3()).send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      )
      return {
        mtimeMs: res.LastModified?.getTime() ?? Date.now(),
        size: res.ContentLength ?? 0,
      }
    } catch {
      return null
    }
  }

  async signUrl(key: string, ttlSeconds: number): Promise<string> {
    if (!KEY_RE.test(key)) throw new Error('Invalid storage key.')
    return signFileToken({ key, exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await (await this.s3()).send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
    )
  }
}
