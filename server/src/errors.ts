export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string): never {
  throw new HttpError(400, 'INVALID_REQUEST', message);
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) badRequest('Expected a JSON object');
  return value as Record<string, unknown>;
}

export function identifier(value: unknown, name = 'id', max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    badRequest(`Invalid ${name}`);
  }
  return value;
}

export function boundedInteger(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    badRequest(`Invalid ${name}`);
  }
  return value;
}
