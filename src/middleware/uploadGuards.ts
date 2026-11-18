import multer, { MulterError } from "multer";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { parseAllowedMimeTypes, validateUpload } from "../lib/uploadValidation.js";

const allowedMimeTypes = parseAllowedMimeTypes(config.ALLOWED_UPLOAD_MIME_TYPES);

const maxConcurrentUploads = config.MAX_CONCURRENT_UPLOADS ?? 4;
let activeUploads = 0;

/** Test hook: number of uploads currently holding a concurrency slot. */
export function __getActiveUploadCount(): number {
  return activeUploads;
}

/**
 * Bounds for the non-file parts of a multipart body (#231). The publish
 * schemas accept at most five text fields (title, description, price,
 * walletAddress, externalUrl) plus one file, so these leave a little headroom
 * while stopping bodies with thousands of fields or oversized metadata values
 * from being parsed into memory.
 */
export const MULTIPART_LIMITS = {
  /** Max number of non-file fields. */
  fields: 10,
  /** Max number of parts (fields + files). */
  parts: 11,
  /** Max size of a single non-file field value, in bytes. */
  fieldSize: 64 * 1024,
  /** Max length of a field name. */
  fieldNameSize: 100,
} as const;

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: {
    fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024,
    ...MULTIPART_LIMITS,
    // busboy flags a value as truncated once it *reaches* fieldSize, so allow
    // one extra byte to make MULTIPART_LIMITS.fieldSize an inclusive maximum.
    fieldSize: MULTIPART_LIMITS.fieldSize + 1,
  },
});

/** Client-facing messages for multer limits that map to 413 Payload Too Large. */
const PAYLOAD_LIMIT_MESSAGES: Partial<Record<MulterError["code"], (err: MulterError) => string>> = {
  LIMIT_FILE_SIZE: () => `File exceeds the maximum size of ${config.MAX_FILE_SIZE_MB}MB`,
  LIMIT_FIELD_COUNT: () => `Too many form fields (maximum ${MULTIPART_LIMITS.fields})`,
  LIMIT_PART_COUNT: () => `Too many multipart parts (maximum ${MULTIPART_LIMITS.parts})`,
  LIMIT_FIELD_VALUE: (err) =>
    `Form field ${err.field ? `"${err.field}" ` : ""}exceeds the maximum size of ${MULTIPART_LIMITS.fieldSize} bytes`,
  LIMIT_FIELD_KEY: () =>
    `Form field name exceeds the maximum length of ${MULTIPART_LIMITS.fieldNameSize} characters`,
};

/**
 * Wraps `multer().single(field)` and maps multer errors to clear HTTP statuses
 * instead of letting them fall through to the 500 handler. Oversized uploads
 * return 413 before anything is written to storage (#87).
 *
 * Uploads are streamed to a temp file on disk rather than buffered in memory,
 * and at most `MAX_CONCURRENT_UPLOADS` are processed at once; excess requests
 * are rejected with 503 (#90).
 *
 * Bodies exceeding `MULTIPART_LIMITS` (too many fields or parts, or an
 * oversized field name/value) are rejected with 413 (#231). Multer removes any
 * temp file it already wrote before reporting the error, and the concurrency
 * slot is released immediately.
 */
export function singleFileUpload(field = "file"): RequestHandler {
  const handler = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    if (activeUploads >= maxConcurrentUploads) {
      next(new AppError("SERVICE_UNAVAILABLE", "Too many concurrent uploads, please retry shortly"));
      return;
    }
    activeUploads++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeUploads--;
      }
    };
    res.on("finish", release);
    res.on("close", release);

    handler(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        release();
        const payloadLimitMessage = PAYLOAD_LIMIT_MESSAGES[err.code];
        if (payloadLimitMessage) {
          next(new AppError("PAYLOAD_TOO_LARGE", payloadLimitMessage(err)));
          return;
        }
        next(new AppError("VALIDATION_ERROR", `Upload error: ${err.message}`));
        return;
      }
      if (err) {
        release();
        // Busboy parse failures (malformed multipart) are client errors; system
        // errors such as a full temp disk carry an errno `code` and stay 5xx.
        if (err instanceof Error && !(err as NodeJS.ErrnoException).code) {
          next(new AppError("VALIDATION_ERROR", `Malformed multipart body: ${err.message}`));
          return;
        }
        next(err);
        return;
      }
      next();
    });
  };
}

/**
 * Rejects uploads whose content type is not allow-listed, or whose declared
 * type does not match the detected magic bytes, with 415 — before the storage
 * write. No-ops for non-file (e.g. link) requests.
 */
export function validateUploadContentType(req: Request, res: Response, next: NextFunction): void {
  if (!req.file) {
    next();
    return;
  }

  const file = req.file;
  fs.readFile(file.path)
    .then((buffer) => {
      const result = validateUpload(buffer, file.mimetype, allowedMimeTypes);
      if (!result.ok) {
        return fs.unlink(file.path).catch(() => undefined).then(() => {
          next(new AppError("UNSUPPORTED_MEDIA_TYPE", result.error));
        });
      }
      next();
    })
    .catch((err: unknown) => {
      fs.unlink(file.path).catch(() => undefined).finally(() => next(err));
    });
}
