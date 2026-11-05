/** Error carrying an HTTP status and a message that is safe to show clients. */
export class AppError extends Error {
  readonly status: number;
  readonly expose: boolean;

  constructor(status: number, publicMessage: string, expose = status < 500) {
    super(publicMessage);
    this.name = "AppError";
    this.status = status;
    this.expose = expose;
  }
}

/** Raised by the CORS origin callback for origins outside the allow-list. */
export class CorsOriginError extends AppError {
  constructor() {
    super(403, "Origin not allowed");
    this.name = "CorsOriginError";
  }
}
