/** Error safe to surface through REST/GraphQL with an HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "BAD_REQUEST",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A pagination cursor was malformed or was issued for a different sort order. */
export class CursorError extends ApiError {
  constructor(message = "Invalid pagination cursor") {
    super(message, 400, "INVALID_CURSOR");
  }
}

/** A requested resource does not exist in the indexed data. */
export class NotFoundError extends ApiError {
  constructor(message: string) {
    super(message, 404, "NOT_FOUND");
  }
}
