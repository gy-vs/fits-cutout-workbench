// Typed, distinguishable server errors. Each code maps to a specific HTTP status
// and a specific message on the page, so the user can tell failures apart.

export const ERROR_CODES = Object.freeze({
  EMPTY_UPLOAD: { status: 400, code: 'EMPTY_UPLOAD' },
  PAYLOAD_TOO_LARGE: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
  UNSUPPORTED_MEDIA: { status: 415, code: 'UNSUPPORTED_MEDIA' },
  MALFORMED_HEADER: { status: 422, code: 'MALFORMED_HEADER' },
  NOT_PRIMARY_IMAGE: { status: 422, code: 'NOT_PRIMARY_IMAGE' },
  UNSUPPORTED_BITPIX: { status: 422, code: 'UNSUPPORTED_BITPIX' },
  UNSUPPORTED_NAXIS: { status: 422, code: 'UNSUPPORTED_NAXIS' },
  MISSING_WCS: { status: 422, code: 'MISSING_WCS' },
  UNSUPPORTED_WCS_CONVENTION: { status: 422, code: 'UNSUPPORTED_WCS_CONVENTION' },
  UNSUPPORTED_PROJECTION: { status: 422, code: 'UNSUPPORTED_PROJECTION' },
  SINGULAR_CD_MATRIX: { status: 422, code: 'SINGULAR_CD_MATRIX' },
  INVALID_WCS_VALUE: { status: 422, code: 'INVALID_WCS_VALUE' },
  DIMENSION_PRODUCT_OVERFLOW: { status: 422, code: 'DIMENSION_PRODUCT_OVERFLOW' },
  TRUNCATED_DATA: { status: 422, code: 'TRUNCATED_DATA' },
  SESSION_NOT_FOUND: { status: 404, code: 'SESSION_NOT_FOUND' },
  BAD_REQUEST: { status: 400, code: 'BAD_REQUEST' },
  OUTPUT_TOO_LARGE: { status: 400, code: 'OUTPUT_TOO_LARGE' },
  REGION_OUTSIDE_HEMISPHERE: { status: 422, code: 'REGION_OUTSIDE_HEMISPHERE' },
  STALE_RESPONSE: { status: 409, code: 'STALE_RESPONSE' },
  INTERNAL: { status: 500, code: 'INTERNAL' }
});

export class FitsError extends Error {
  constructor(kind, message) {
    const spec = ERROR_CODES[kind] || ERROR_CODES.INTERNAL;
    super(message || spec.code);
    this.name = 'FitsError';
    this.status = spec.status;
    this.code = spec.code;
  }
}

export function fail(kind, message) {
  return new FitsError(kind, message);
}

export function errorBody(err) {
  if (err instanceof FitsError) {
    return { status: err.status, body: { error: err.code, message: err.message } };
  }
  return { status: 500, body: { error: 'INTERNAL', message: String(err && err.message || err) } };
}
