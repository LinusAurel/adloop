import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_MAX_BYTES,
  downloadImageBytes,
} from "@/images/image-download";
import { mimeFromMagicBytes, resolveImageMime } from "@/images/image-mime";
import { materializeWebhookResult } from "@/app/api/webhooks/fal/[correlationId]/route";
import { FalImageProvider } from "@/images/providers/fal";
import { policyAllowsPublicRead } from "@/storage/object-store";
import { uuidv7 } from "uuidv7";

describe("review 16 — postfix2 etappe 6", () => {
  it("1 — reject oversized chunk before retaining it; Content-Length skips body", async () => {
    // First chunk alone exceeds the limit — must throw without keeping it in the
    // assembled buffer (check happens before chunks.push).
    const oversized = new Uint8Array(DOWNLOAD_MAX_BYTES + 1024);
    oversized.fill(0x42);
    await expect(
      downloadImageBytes("https://v3b.fal.media/files/big.bin", {
        async fetch() {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(oversized);
                controller.close();
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/octet-stream" },
            },
          );
        },
      }),
    ).rejects.toThrow("download_too_large");

    // Declared size over the limit: never open a reader on the body.
    let getReaderCalled = false;
    await expect(
      downloadImageBytes("https://v3b.fal.media/files/declared-huge.bin", {
        async fetch() {
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          });
          const original = body.getReader.bind(body);
          body.getReader = ((...args: Parameters<ReadableStream["getReader"]>) => {
            getReaderCalled = true;
            return original(...args);
          }) as ReadableStream["getReader"];
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(DOWNLOAD_MAX_BYTES + 1),
            },
          });
        },
      }),
    ).rejects.toThrow("download_too_large");
    expect(getReaderCalled).toBe(false);
  });

  it("2 — resolveImageMime used by webhook AND fal polling (GIF not forced to png)", async () => {
    const gif = Buffer.from("GIF89a" + "\0".repeat(10));
    expect(mimeFromMagicBytes(gif)).toBe("image/gif");
    expect(resolveImageMime(null, null, gif)).toBe("image/gif");
    expect(resolveImageMime(null, "image/webp", gif)).toBe("image/webp");
    expect(resolveImageMime("image/jpeg", "image/webp", gif)).toBe("image/jpeg");

    // Webhook caller
    const fromWebhook = await materializeWebhookResult(
      {
        images: [
          {
            bytesBase64: gif.toString("base64"),
            width: 8,
            height: 8,
            // no content_type
          },
        ],
      },
    );
    expect(fromWebhook!.images[0]!.mime).toBe("image/gif");

    // Polling caller (FalImageProvider.materialize via fetchResult)
    const fal = new FalImageProvider({
      apiKey: "test",
      http: {
        async fetch() {
          throw new Error("network_should_not_run");
        },
      },
      fixtureResults: new Map([
        [
          "req-gif",
          {
            images: [
              {
                bytesBase64: gif.toString("base64"),
                width: 8,
                height: 8,
              },
            ],
          },
        ],
      ]),
    });
    const fromPolling = await fal.fetchResult(
      {
        externalId: "req-gif",
        correlationId: uuidv7(),
      },
      new AbortController().signal,
    );
    expect(fromPolling.images[0]!.mime).toBe("image/gif");
  });

  it("3 — Allow + NotAction without excluding reads is public", () => {
    expect(
      policyAllowsPublicRead(
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              NotAction: "s3:PutObject",
              Resource: ["arn:aws:s3:::adloop/*"],
            },
          ],
        }),
      ),
    ).toBe(true);

    // NotAction carves out GetObject → this statement does not grant public read.
    expect(
      policyAllowsPublicRead(
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              NotAction: ["s3:GetObject", "s3:Get*"],
              Resource: ["arn:aws:s3:::adloop/*"],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});
