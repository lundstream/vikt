/**
 * Service-layer errors. Services throw these; the Fastify error handler in
 * `src/app.ts` turns them into a `{ error, message }` body with the right
 * status. Services never import Fastify.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /**
   * Extra fields merged into the response body.
   *
   * Used by the 409 a queued write gets when its day was already written
   * elsewhere (D41): the client needs to *show* both readings for the user to
   * choose between, so the one it lost to travels with the refusal rather than
   * requiring a second round trip to a device that may be offline again by then.
   */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (message = "Not signed in") =>
  new AppError(401, "unauthorized", message);
export const forbidden = (message = "Not allowed") => new AppError(403, "forbidden", message);
export const notFound = (message = "Not found") => new AppError(404, "not_found", message);
export const conflict = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new AppError(409, code, message, details);
/** Guardrail rejections (CLAUDE.md §3) use 422 with a readable message. */
/**
 * Refused on volume, not on content (D88, D89).
 *
 * The retry time is in the message rather than only in a header, because the
 * two public endpoints are used by a form and the person filling it in is the
 * one who needs to know.
 */
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(
    429,
    "rate_limited",
    `För många försök. Försök igen om ${Math.ceil(retryAfterSeconds / 60)} minuter.`,
  );

export const unprocessable = (code: string, message: string) =>
  new AppError(422, code, message);
