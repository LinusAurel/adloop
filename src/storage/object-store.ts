import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/lib/env";

export interface ObjectStore {
  putJson(key: string, value: unknown, signal?: AbortSignal): Promise<void>;
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
        });
    }
    return this.bucketReady;
  }

  async putJson(key: string, value: unknown, signal?: AbortSignal): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json",
      }),
      { abortSignal: signal },
    );
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
