import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";

// Stream uploads into a dedicated temp dir so tests can assert that rejected
// requests leave no temp files behind.
vi.mock("node:os", async (importOriginal) => {
  type OsModule = typeof import("node:os");
  const actual = await importOriginal<OsModule & { default: OsModule }>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(actual.tmpdir(), "upload-guards-test-"));
  return { ...actual, default: { ...actual.default, tmpdir: () => dir } };
});

// uploadGuards imports config; mock it so the test doesn't need a full env.
vi.mock("../config.js", () => ({
  config: {
    MAX_FILE_SIZE_MB: 1,
    MAX_CONCURRENT_UPLOADS: 6,
    ALLOWED_UPLOAD_MIME_TYPES: "application/pdf,image/png,text/plain",
  },
}));

vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/logger.js")>()),
  getRequestId: () => "test-request-id",
}));

import {
  singleFileUpload,
  validateUploadContentType,
  __getActiveUploadCount,
  MULTIPART_LIMITS,
} from "./uploadGuards.js";
import { errorHandler } from "./errorHandler.js";
import { openApiSpec } from "../openapi.js";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildApp(): Express {
  const app = express();
  app.post("/upload", singleFileUpload("file"), validateUploadContentType, (req, res) => {
    res.status(201).json({ ok: true, mimetype: req.file?.mimetype ?? null });
  });
  app.use(errorHandler);
  return app;
}

describe("upload guards middleware", () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  it("accepts an allow-listed file whose bytes match", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("rejects a disallowed content type with 415", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", Buffer.from([0x50, 0x4b, 0x03, 0x04]), {
        filename: "a.zip",
        contentType: "application/zip",
      });
    expect(res.status).toBe(415);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("rejects when declared type does not match detected bytes (415)", async () => {
    const res = await request(app)
      .post("/upload")
      .attach("file", PNG, { filename: "fake.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/does not match/i);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("rejects oversized uploads with 413", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2MB > 1MB limit
    const res = await request(app)
      .post("/upload")
      .attach("file", big, { filename: "big.txt", contentType: "text/plain" });
    expect(res.status).toBe(413);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("rejects malformed multipart bodies with 400", async () => {
    const res = await request(app)
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=----broken")
      .send("not a valid multipart body");
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      requestId: "test-request-id",
    });
  });

  it("passes through requests with no file", async () => {
    const res = await request(app).post("/upload").send();
    expect(res.status).toBe(201);
    expect(res.body.mimetype).toBeNull();
  });

  it("streams uploads to disk instead of buffering in memory", async () => {
    let capturedPath: string | undefined;
    let capturedBuffer: unknown;
    const probe = express();
    probe.post(
      "/upload",
      singleFileUpload("file"),
      validateUploadContentType,
      (req, res) => {
        capturedPath = req.file?.path;
        capturedBuffer = (req.file as unknown as { buffer?: unknown })?.buffer;
        res.status(201).json({ ok: true });
      },
    );

    const res = await request(probe)
      .post("/upload")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(capturedBuffer).toBeUndefined();
    expect(typeof capturedPath).toBe("string");
    expect(capturedPath && fs.existsSync(capturedPath)).toBe(true);
  });

  it("keeps concurrent large uploads on disk rather than in memory", async () => {
    // Heap deltas are unreliable here (supertest shares the process and holds
    // the request bodies), so assert the mechanism instead: every concurrent
    // upload is disk-backed and never exposes an in-memory buffer.
    const nearLimit = Buffer.alloc(900 * 1024, 0x41); // just under 1MB limit
    const concurrency = 6;
    const seen: { path?: string; buffer?: unknown }[] = [];
    const probe = express();
    probe.post("/upload", singleFileUpload("file"), validateUploadContentType, (req, res) => {
      seen.push({
        path: req.file?.path,
        buffer: (req.file as unknown as { buffer?: unknown })?.buffer,
      });
      res.status(201).json({ ok: true });
    });
    probe.use(errorHandler);

    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        request(probe)
          .post("/upload")
          .attach("file", nearLimit, { filename: `big-${i}.txt`, contentType: "text/plain" }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(201);
    }
    expect(seen).toHaveLength(concurrency);
    for (const file of seen) {
      expect(file.buffer).toBeUndefined();
      expect(typeof file.path).toBe("string");
    }
  });

  it("caps the number of simultaneous uploads", async () => {
    const nearLimit = Buffer.alloc(900 * 1024, 0x41);
    const concurrency = 8;

    const pending = Array.from({ length: concurrency }, (_, i) =>
      request(app)
        .post("/upload")
        .attach("file", nearLimit, {
          filename: `cap-${i}.txt`,
          contentType: "text/plain",
        }),
    );

    // While requests are in flight the active count must never exceed the cap.
    let maxObserved = 0;
    const poll = setInterval(() => {
      maxObserved = Math.max(maxObserved, __getActiveUploadCount());
    }, 1);

    const responses = await Promise.all(pending);
    clearInterval(poll);

    for (const res of responses) {
      // Either accepted, or rejected with 503 when the limiter is saturated.
      expect([201, 503]).toContain(res.status);
    }
    expect(responses.some((res) => res.status === 503)).toBe(true);
    expect(maxObserved).toBeLessThanOrEqual(6);
    expect(__getActiveUploadCount()).toBe(0);
  });
});

describe("multipart field, part and metadata limits (#231)", () => {
  const uploadDir = os.tmpdir();
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });
  beforeEach(async () => {
    // Start from free upload slots even if an earlier test left requests in flight.
    await vi.waitFor(() => expect(__getActiveUploadCount()).toBe(0), { timeout: 5000 });
  });
  afterAll(() => {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  /** Sends a request and asserts it left no temp files and no held upload slot. */
  async function expectCleanRejection(send: () => request.Test) {
    const before = new Set(fs.readdirSync(uploadDir));
    const res = await send();
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE", requestId: "test-request-id" });
    expect(fs.readdirSync(uploadDir).filter((name) => !before.has(name))).toEqual([]);
    expect(__getActiveUploadCount()).toBe(0);
    return res;
  }

  it("accepts a body exactly at every limit", async () => {
    const req = request(app)
      .post("/upload")
      .field("title", "Dataset")
      .field("description", "d".repeat(MULTIPART_LIMITS.fieldSize))
      .field("price", "0.50")
      .field("n".repeat(MULTIPART_LIMITS.fieldNameSize), "x");
    for (let i = 4; i < MULTIPART_LIMITS.fields; i++) req.field(`f${i}`, "x");
    const res = await req.attach("file", PDF, {
      filename: "doc.pdf",
      contentType: "application/pdf",
    });
    expect(res.status).toBe(201);
    expect(__getActiveUploadCount()).toBe(0);
  });

  it("rejects too many form fields with 413 and removes the already-written file", async () => {
    const res = await expectCleanRejection(() => {
      const req = request(app)
        .post("/upload")
        .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
      for (let i = 0; i <= MULTIPART_LIMITS.fields; i++) req.field(`f${i}`, "x");
      return req;
    });
    expect(res.body.error).toBe(`Too many form fields (maximum ${MULTIPART_LIMITS.fields})`);
  });

  it("rejects too many parts with 413", async () => {
    // Parts without a form-data disposition are skipped by the parser but still
    // count towards the part limit, so they can't hide behind the field limit.
    const boundary = "----upload-guards-parts";
    const junkPart = `--${boundary}\r\nContent-Disposition: attachment\r\n\r\nx\r\n`;
    const body = junkPart.repeat(MULTIPART_LIMITS.parts + 1) + `--${boundary}--\r\n`;
    const res = await expectCleanRejection(() =>
      request(app)
        .post("/upload")
        .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
        .send(body),
    );
    expect(res.body.error).toBe(`Too many multipart parts (maximum ${MULTIPART_LIMITS.parts})`);
  });

  it("rejects an oversized metadata field with 413 and removes the already-written file", async () => {
    const res = await expectCleanRejection(() =>
      request(app)
        .post("/upload")
        .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" })
        .field("title", "Dataset")
        .field("description", "d".repeat(MULTIPART_LIMITS.fieldSize + 1)),
    );
    expect(res.body.error).toBe(
      `Form field "description" exceeds the maximum size of ${MULTIPART_LIMITS.fieldSize} bytes`,
    );
  });

  it("rejects an oversized field name with 413", async () => {
    const res = await expectCleanRejection(() =>
      request(app)
        .post("/upload")
        .field("n".repeat(MULTIPART_LIMITS.fieldNameSize + 1), "x")
        .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" }),
    );
    expect(res.body.error).toBe(
      `Form field name exceeds the maximum length of ${MULTIPART_LIMITS.fieldNameSize} characters`,
    );
  });
});

describe("multipart limits in the OpenAPI spec", () => {
  it("documents the same numbers MULTIPART_LIMITS enforces", () => {
    type Operation = { responses?: Record<string, { description?: string }> };
    const descriptions = Object.values(openApiSpec.paths)
      .flatMap((path) => Object.values(path as Record<string, Operation>))
      .map((op) => op.responses?.["413"]?.description ?? "")
      .filter((description) => description.includes("form fields"));
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(description).toContain(`more than ${MULTIPART_LIMITS.fields} form fields`);
      expect(description).toContain(`${MULTIPART_LIMITS.parts} parts`);
      expect(description).toContain(`${MULTIPART_LIMITS.fieldSize / 1024} KiB`);
      expect(description).toContain(`over ${MULTIPART_LIMITS.fieldNameSize} characters`);
    }
  });
});
