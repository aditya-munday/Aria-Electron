import type { AriaBackendError } from './product-errors.js';

/**
 * The outcome of a client operation. A failure is always a classified
 * `AriaBackendError`, never a thrown string and never a silent success — the
 * caller can always tell whether an operation happened.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AriaBackendError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(error: AriaBackendError): Result<T> {
  return { ok: false, error };
}
