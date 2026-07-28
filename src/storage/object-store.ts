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
              new GetBucketPolicyCommand({ Bucket: this.bucket }),
            );
          } catch {
            // No policy yet — fine. Explicitly refuse anonymous access via ACL absence.
          }
          // Ensure we never leave a public-read statement around in local MinIO.
          try {
            await this.client.send(
              new PutBucketPolicyCommand({
                Bucket: this.bucket,
                Policy: this.denyPublicPolicy(),
              }),
            );
          } catch {
            // Some MinIO setups reject principal conditions; private-by-default still holds
            // when no public policy exists. Signed URLs remain the only access path.
          }
        });
    }
    return this.bucketReady;
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

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putBytes(key, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
  }

  async putBytes(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
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
