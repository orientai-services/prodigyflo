import { randomBytes } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { FileStorage, PutMeta } from './types'
import { signFileToken } from './sign'
import { objectStorageEnv, s3ForcePathStyle, s3PutExtra } from './s3-config'

/**
 * S3 / Spaces / Supabase Storage driver. Production documents go here — never
 * local disk, never in-memory. Same interface as LocalFileStorage so callers
 * do not branch.
 */
const KEY_RE = /^[A-Za-z0-9_-]{8,64}\.bin$/
const NAMED_KEY_RE = /^avatars\/[a-z0-9]{10,40}\.(jpg|png|webp)$/

export class S3FileStorage implements FileStorage {
  readonly name = 's3'
  // Keep the SDK statically linked in the server bundle. Vercel's production
  // Turbopack output can leave a lazily imported AWS module in a temporal-dead-
  // zone on its first request, which makes otherwise valid private uploads fail.
  private client: S3Client | null = null
  private readonly bucket: string
  private readonly prefix: string

  constructor() {
    const bucket = objectStorageEnv().bucket
    if (!bucket) throw new Error('FILE_STORAGE_BUCKET (or DO_SPACES_BUCKET) is required for the s3 driver.')
    this.bucket = bucket
    this.prefix = (process.env.FILE_STORAGE_PREFIX ?? 'documents').replace(/\/$/, '')
  }

  private async s3(): Promise<S3Client> {
    if (this.client) return this.client
    const env = objectStorageEnv()
    const client = new S3Client({
      region: env.region,
      endpoint: env.endpoint || undefined,
      forcePathStyle: s3ForcePathStyle(env.endpoint),
      credentials: {
        accessKeyId: env.accessKeyId,
        secretAccessKey: env.secretAccessKey,
      },
    })
    this.client = client
    return client
  }

  private objectKey(key: string): string {
    if (!KEY_RE.test(key) && !NAMED_KEY_RE.test(key)) throw new Error('Invalid storage key.')
    return `${this.prefix}/${key}`
  }

  async put(buf: Buffer, meta: PutMeta): Promise<{ key: string }> {
    void meta
    const key = `${randomBytes(16).toString('hex')}.bin`
    await (await this.s3()).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: buf, ...s3PutExtra() }),
    )
    return { key }
  }

  async putAt(key: string, buf: Buffer): Promise<void> {
    if (!NAMED_KEY_RE.test(key)) throw new Error('Invalid named storage key.')
    await (await this.s3()).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: buf, ...s3PutExtra() }),
    )
  }

  async get(key: string): Promise<Buffer> {
    const res = await (await this.s3()).send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
    )
    const body = res.Body as { transformToByteArray(): Promise<Uint8Array> }
    return Buffer.from(await body.transformToByteArray())
  }

  async stat(key: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
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
    await (await this.s3()).send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
    )
  }
}
