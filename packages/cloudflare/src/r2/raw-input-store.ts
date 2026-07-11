import {
  getRawInputMetadata,
  insertRawInputMetadata,
  isUniqueConstraintError,
  sessionExists,
  type RawInputMetadata,
} from "../d1/repository.js";
import { SessionNotFoundError } from "../errors.js";

export type PutRawInputInput = {
  sessionId: string;
  actorId: string;
  body: ArrayBuffer | Uint8Array;
  contentType?: string | null;
  inputId?: string;
};

export type PutRawInputResult = RawInputMetadata;

/** Default max raw body size accepted by the HTTP upload path (10 MiB). */
export const DEFAULT_MAX_RAW_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * Stores Raw Input bytes in R2 and metadata + checksum in D1 (FR-07).
 */
export class R2RawInputStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly db: D1Database,
  ) {}

  async put(input: PutRawInputInput): Promise<PutRawInputResult> {
    if (!(await sessionExists(this.db, input.sessionId))) {
      throw new SessionNotFoundError(input.sessionId);
    }

    const id = input.inputId ?? crypto.randomUUID();
    const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    const checksumSha256 = await sha256Hex(bytes);
    const objectKey = `raw/${input.sessionId}/${id}`;
    const contentType = input.contentType ?? null;

    // Idempotent reuse: same id + same content returns existing metadata.
    const existing = await getRawInputMetadata(this.db, input.sessionId, id);
    if (existing) {
      if (existing.checksumSha256 === checksumSha256) {
        return existing;
      }
      throw new Error(`Raw input already exists with different content: ${id}`);
    }

    const createdAt = new Date();
    const putOptions: R2PutOptions = {
      customMetadata: {
        sessionId: input.sessionId,
        inputId: id,
        checksumSha256,
      },
    };
    if (contentType) {
      putOptions.httpMetadata = { contentType };
    }
    await this.bucket.put(objectKey, bytes, putOptions);

    const metadata: RawInputMetadata = {
      id,
      sessionId: input.sessionId,
      objectKey,
      contentType,
      byteSize: bytes.byteLength,
      checksumSha256,
      createdAt,
      createdByActorId: input.actorId,
    };

    try {
      await insertRawInputMetadata(this.db, metadata);
    } catch (error) {
      // Race: another writer may have inserted the same id after our existence check.
      if (isUniqueConstraintError(error)) {
        const raced = await getRawInputMetadata(this.db, input.sessionId, id);
        if (raced && raced.checksumSha256 === checksumSha256) {
          return raced;
        }
        // Metadata owns the key with different content — do not delete their object.
        if (raced) {
          throw new Error(`Raw input already exists with different content: ${id}`);
        }
      }
      // Our object is orphaned only when no metadata row exists for this id.
      const stillMissing = !(await getRawInputMetadata(this.db, input.sessionId, id));
      if (stillMissing) {
        await this.bucket.delete(objectKey);
      }
      throw error;
    }

    return metadata;
  }

  async getMetadata(sessionId: string, inputId: string): Promise<RawInputMetadata | undefined> {
    return getRawInputMetadata(this.db, sessionId, inputId);
  }

  async getObject(sessionId: string, inputId: string): Promise<R2ObjectBody | null> {
    const metadata = await this.getMetadata(sessionId, inputId);
    if (!metadata) return null;
    return this.bucket.get(metadata.objectKey);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
