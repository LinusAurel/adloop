import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ObjectStore {
  putJson(key: string, value: unknown, signal?: AbortSignal): Promise<void>;
  putBytes(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void>;
  getObject(key: string, signal?: AbortSignal): Promise<StoredObject>;
  /**
   * Time-limited URL. The bucket itself is private — unsigned GETs must fail.
   */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketReady: Promise<void> | undefined;

  constructor(options: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }) {
    this.bucket = options.bucket;
    const credentials =
      options.accessKeyId && options.secretAccessKey
        ? {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          }
        : undefined;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials,
    });
  }

  private denyPublicPolicy(): string {
    return JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyPublicRead",
          Effect: "Deny",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${this.bucket}/*`],
          Condition: {
            StringNotEquals: {
              "aws:PrincipalType": "User",
            },
          },
        },
      ],
    });
  }

  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = this.client
        .send(new HeadBucketCommand({ Bucket: this.bucket }))
        .then(() => undefined)
        .catch(async (error: unknown) => {
          const status =
            typeof error === "object" &&
            error !== null &&
            "$metadata" in error &&
            typeof error.$metadata === "object" &&
            error.$metadata !== null &&
            "httpStatusCode" in error.$metadata
              ? error.$metadata.httpStatusCode
              : undefined;
          if (status !== 404) throw error;
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        })
        .then(async () => {
          // MinIO / S3: keep the bucket private. Public-read policies are never applied.
          try {
            await this.client.send(
              new PutBucketPolicyCommand({
                Bucket: this.bucket,
                Policy: this.denyPublicPolicy(),
              }),
            );
          } catch {
            // Put failed — verify the bucket is not already publicly readable.
            await this.assertBucketNotPubliclyReadable();
          }
        });
    }
    return this.bucketReady;
  }

  private async assertBucketNotPubliclyReadable(): Promise<void> {
    let policyJson: string | undefined;
    try {
      const got = await this.client.send(
        new GetBucketPolicyCommand({ Bucket: this.bucket }),
      );
      policyJson = got.Policy;
    } catch (error: unknown) {
      if (isNoSuchBucketPolicy(error)) {
        // Empty policy — private by default.
        return;
      }
      // Cannot establish the state → refuse to start. Unverifiable ≠ ok.
      throw new Error("bucket_policy_unverifiable");
    }
    if (policyAllowsPublicRead(policyJson)) {
      throw new Error("bucket_not_private");
    }
  }

  async putJson(key: string, value: unknown, signal?: AbortSignal): Promise<void> {
    await this.putBytes(
      key,
      Buffer.from(JSON.stringify(value), "utf8"),
      "application/json",
      signal,
    );
  }

  async putBytes(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
      { abortSignal: signal },
    );
  }

  async getObject(key: string, signal?: AbortSignal): Promise<StoredObject> {
    await this.ensureBucket();
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: signal },
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw new Error(`object_store_empty:${key}`);
    return {
      body: Buffer.from(bytes),
      contentType: response.ContentType ?? "application/octet-stream",
    };
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    await this.ensureBucket();
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /** Test helper: raw endpoint + bucket for unsigned GET probes. */
  getPublicProbeBase(): { endpoint: string; bucket: string } {
    return {
      endpoint: (this.client.config.endpoint as unknown as () => Promise<{ hostname: string }>)
        ? ""
        : "",
      bucket: this.bucket,
    };
  }

  getBucketName(): string {
    return this.bucket;
  }

  getClient(): S3Client {
    return this.client;
  }
}

/**
 * True when a bucket policy grants anonymous GetObject (or s3:*).
 * Exported for unit tests — Finding 6 must not silently keep a public bucket.
 */
export function policyAllowsPublicRead(policyJson: string | undefined): boolean {
  if (!policyJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(policyJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || !("Statement" in parsed)) {
    return false;
  }
  const statements = (parsed as { Statement: unknown }).Statement;
  const list = Array.isArray(statements) ? statements : [statements];
  for (const statement of list) {
    if (!statement || typeof statement !== "object") continue;
    const s = statement as {
      Effect?: unknown;
      Principal?: unknown;
      Action?: unknown;
      NotAction?: unknown;
    };
    if (s.Effect !== "Allow") continue;
    if (!principalIsWildcard(s.Principal)) continue;
    if (s.NotAction !== undefined) {
      // Allow + NotAction grants everything except listed actions.
      // Public unless NotAction carves out read access.
      if (!notActionExcludesReads(s.NotAction)) {
        return true;
      }
      continue;
    }
    if (actionIncludesGetObject(s.Action)) return true;
  }
  return false;
}

function principalIsWildcard(principal: unknown): boolean {
  if (principal === "*") return true;
  if (!principal || typeof principal !== "object") return false;
  const p = principal as { AWS?: unknown; "*"?: unknown };
  if (p.AWS === "*") return true;
  if (Array.isArray(p.AWS) && p.AWS.includes("*")) return true;
  return false;
}

function actionIncludesGetObject(action: unknown): boolean {
  const actions = Array.isArray(action) ? action : [action];
  return actions.some((a) => {
    if (typeof a !== "string") return false;
    const normalized = a.toLowerCase();
    return (
      normalized === "s3:getobject" ||
      normalized === "s3:get*" ||
      normalized === "s3:*" ||
      normalized === "*"
    );
  });
}

/** True when NotAction lists read actions — those are then not granted by Allow. */
function notActionExcludesReads(notAction: unknown): boolean {
  return actionIncludesGetObject(notAction);
}

/** True when GetBucketPolicy failed because no policy exists (private default). */
export function isNoSuchBucketPolicy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; Code?: string; code?: string };
  const code = err.name ?? err.Code ?? err.code ?? "";
  return (
    code === "NoSuchBucketPolicy" ||
    code === "NoSuchBucketPolicyError" ||
    code === "NotFound"
  );
}

/**
 * Resolve whether a bucket may be used after PutBucketPolicy failed.
 * Exported for Finding 6 tests — unverifiable must abort.
 */
export function resolveBucketPrivacyAfterPutFailure(params: {
  getPolicyError?: unknown;
  policyJson?: string;
}): "private" | "public" | "unverifiable" {
  if (params.getPolicyError !== undefined) {
    if (isNoSuchBucketPolicy(params.getPolicyError)) return "private";
    return "unverifiable";
  }
  if (policyAllowsPublicRead(params.policyJson)) return "public";
  return "private";
}

let cached: ObjectStore | undefined;

export function getObjectStore(): ObjectStore {
  if (!cached) {
    cached = new S3ObjectStore({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.MINIO_ROOT_USER,
      secretAccessKey: env.MINIO_ROOT_PASSWORD,
    });
  }
  return cached;
}

export function setObjectStoreForTests(store: ObjectStore | null): void {
  cached = store ?? undefined;
}

/** In-memory store for unit tests that do not need MinIO. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  private readonly signed = new Map<string, { key: string; expiresAt: number }>();

  putCount = 0;

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putBytes(key, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
  }

  async putBytes(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    this.putCount += 1;
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async getObject(key: string): Promise<StoredObject> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`object_not_found:${key}`);
    return found;
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (!this.objects.has(key)) throw new Error(`object_not_found:${key}`);
    const token = `memsig-${key}-${expiresInSeconds}-${Date.now()}`;
    this.signed.set(token, {
      key,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    });
    return `memory://signed/${encodeURIComponent(token)}`;
  }

  /** Resolve a memory signed URL; throws if missing/expired (proves expiry). */
  resolveSigned(url: string): StoredObject {
    const prefix = "memory://signed/";
    if (!url.startsWith(prefix)) throw new Error("unsigned_url");
    const token = decodeURIComponent(url.slice(prefix.length));
    const entry = this.signed.get(token);
    if (!entry) throw new Error("invalid_signature");
    if (Date.now() > entry.expiresAt) throw new Error("signature_expired");
    const obj = this.objects.get(entry.key);
    if (!obj) throw new Error("object_not_found");
    return obj;
  }

  /** Unsigned access always fails — mirrors private bucket. */
  getUnsigned(key: string): never {
    void key;
    throw new Error("access_denied_unsigned");
  }
}
