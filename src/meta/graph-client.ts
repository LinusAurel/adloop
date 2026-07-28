import { z } from "zod";

const MetaErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.number().int(),
    error_subcode: z.number().int().optional(),
    error_user_msg: z.string().optional(),
    fbtrace_id: z.string().optional(),
    is_transient: z.boolean().optional(),
  }),
});

const RateUsageSchema = z.record(
  z.array(
    z.object({
      type: z.string().optional(),
      call_count: z.number().optional(),
      total_cputime: z.number().optional(),
      total_time: z.number().optional(),
      estimated_time_to_regain_access: z.number().nonnegative().optional(),
    }).passthrough(),
  ),
);

const AsyncStartSchema = z
  .object({
    report_run_id: z.string().optional(),
    async_job_id: z.string().optional(),
  })
  .refine((value) => Boolean(value.report_run_id ?? value.async_job_id));

export const AsyncReportStatusSchema = z.object({
  id: z.string(),
  async_status: z.enum([
    "Job Not Started",
    "Job Started",
    "Job Running",
    "Job Completed",
    "Job Failed",
    "Job Skipped",
  ]),
  async_percent_completion: z.number().int().min(0).max(100),
  error_code: z.number().int().optional(),
  error_message: z.string().optional(),
});

export class MetaGraphError extends Error {
  readonly code: number;
  readonly errorSubcode?: number;
  readonly errorUserMessage?: string;
  readonly fbtraceId?: string;
  readonly retryable: boolean;

  constructor(details: z.infer<typeof MetaErrorSchema>["error"]) {
    super("Meta Graph request failed");
    this.name = "MetaGraphError";
    this.code = details.code;
    this.errorSubcode = details.error_subcode;
    this.errorUserMessage = details.error_user_msg;
    this.fbtraceId = details.fbtrace_id;
    this.retryable = details.is_transient === true || details.code === 17 || details.code === 613;
  }
}

export class MetaResponseValidationError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super("Meta response failed schema validation");
    this.name = "MetaResponseValidationError";
  }
}

export interface PageResult<T> {
  data: T[];
  paging?: {
    next?: string;
    cursors?: { after?: string };
  };
}

export interface PaginateOptions<T> {
  path: string;
  pageSchema: z.ZodType<PageResult<T>, z.ZodTypeDef, unknown>;
  resumeCursor?: string | null;
  signal?: AbortSignal;
  onPage(page: {
    data: T[];
    pageNumber: number;
    requestCursor: string | null;
    nextCursor: string | null;
    raw: unknown;
  }): Promise<void>;
}

export interface GraphClientOptions {
  accessToken: string;
  apiVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxRateLimitRetries?: number;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function rateLimitDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;

  const usageHeader = response.headers.get("x-business-use-case-usage");
  if (usageHeader) {
    try {
      const parsed = RateUsageSchema.safeParse(JSON.parse(usageHeader));
      if (parsed.success) {
        const regainMinutes = Object.values(parsed.data)
          .flat()
          .map((entry) => entry.estimated_time_to_regain_access ?? 0)
          .reduce((max, value) => Math.max(max, value), 0);
        if (regainMinutes > 0) return regainMinutes * 60_000;
      }
    } catch {
      // A malformed advisory header must not mask a valid Graph error body.
    }
  }

  return Math.min(1_000 * 2 ** attempt, 60_000);
}

export class MetaGraphClient {
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: NonNullable<GraphClientOptions["sleep"]>;
  private readonly maxRateLimitRetries: number;

  constructor(options: GraphClientOptions) {
    this.accessToken = options.accessToken;
    this.apiVersion = options.apiVersion;
    this.baseUrl = new URL(options.baseUrl ?? "https://graph.facebook.com");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
  }

  private url(path: string): URL {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const versioned = normalized.startsWith(`/${this.apiVersion}/`)
      ? normalized
      : `/${this.apiVersion}${normalized}`;
    const url = new URL(versioned, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new Error("invalid Meta continuation origin");
    url.searchParams.set("access_token", this.accessToken);
    return url;
  }

  private continuation(next: string | undefined): string | null {
    if (!next) return null;
    const nextUrl = new URL(next, this.baseUrl);
    if (nextUrl.origin !== this.baseUrl.origin) throw new Error("invalid Meta paging.next origin");
    nextUrl.searchParams.delete("access_token");
    return `${nextUrl.pathname}${nextUrl.search}`;
  }

  async request<T>(
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    init: RequestInit = {},
  ): Promise<{ data: T; raw: unknown }> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(this.url(path), init);
      const raw: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const parsedError = MetaErrorSchema.safeParse(raw);
        if (!parsedError.success) throw new MetaResponseValidationError(parsedError.error.issues);
        const error = new MetaGraphError(parsedError.data.error);
        if (error.retryable && attempt < this.maxRateLimitRetries) {
          await this.sleep(rateLimitDelay(response, attempt), init.signal ?? undefined);
          continue;
        }
        throw error;
      }

      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new MetaResponseValidationError(parsed.error.issues);
      return { data: parsed.data, raw };
    }
  }

  async paginate<T>(options: PaginateOptions<T>): Promise<number> {
    let cursor = options.resumeCursor ?? options.path;
    let pageNumber = 0;
    while (cursor) {
      const requestCursor: string | null = cursor === options.path ? null : cursor;
      const response = await this.request(cursor, options.pageSchema, { signal: options.signal });
      pageNumber += 1;
      const nextCursor = this.continuation(response.data.paging?.next);
      await options.onPage({
        data: response.data.data,
        pageNumber,
        requestCursor,
        nextCursor,
        raw: response.raw,
      });
      cursor = nextCursor ?? "";
    }
    return pageNumber;
  }

  async startAsyncInsights(
    path: string,
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const body = new URLSearchParams({ ...params, async: "true" });
    const response = await this.request(path, AsyncStartSchema, {
      method: "POST",
      body,
      signal,
    });
    return response.data.report_run_id ?? response.data.async_job_id!;
  }

  async waitForAsyncReport(
    jobId: string,
    options: {
      signal?: AbortSignal;
      pollIntervalMs?: number;
      onProgress?: (percent: number) => Promise<void>;
    } = {},
  ): Promise<void> {
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    for (;;) {
      const response = await this.request(`/${jobId}`, AsyncReportStatusSchema, {
        signal: options.signal,
      });
      await options.onProgress?.(response.data.async_percent_completion);
      if (response.data.async_status === "Job Completed") return;
      if (
        response.data.async_status === "Job Failed" ||
        response.data.async_status === "Job Skipped"
      ) {
        throw new MetaGraphError({
          message: response.data.error_message ?? "async report failed",
          code: response.data.error_code ?? -1,
        });
      }
      await this.sleep(pollIntervalMs, options.signal);
    }
  }
}
