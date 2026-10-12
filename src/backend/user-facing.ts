import type { AriaErrorKind } from './product-errors.js';

const USER_FACING: Readonly<Record<AriaErrorKind, string>> = {
  not_configured: 'Aria is not set up yet.',
  no_token: 'Sign in to continue.',
  unauthenticated: 'Your session has expired. Sign in again.',
  forbidden: 'You do not have access to that.',
  not_found: 'That item no longer exists.',
  validation: 'That request was not valid.',
  unprocessable: 'Aria could not process that request.',
  conflict: 'Something changed while Aria was working. It will re-check.',
  rate_limited: 'Aria is busy right now. Try again in a moment.',
  unavailable: 'Aria is temporarily unavailable.',
  timeout: 'That took too long. Aria will re-check.',
  malformed: 'Aria received an unexpected response.',
  too_large: 'That request was too large.',
  transport: 'Aria could not connect. Check your network and try again.',
};

export function userFacingMessage(kind: AriaErrorKind): string {
  return USER_FACING[kind];
}

export function userFacingMessageForKind(kind: string): string {
  return kind in USER_FACING
    ? USER_FACING[kind as AriaErrorKind]
    : 'Something went wrong. Try again.';
}

export function redactUserDetail(detail: string): string {
  let text = detail;
  text = text.replace(/\bhttps?:\/\/[^\s)]+/gi, 'the service');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'a credential');
  text = text.replace(/\beyJ[A-Za-z0-9._-]{10,}/g, 'a credential');
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, 'the host');
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, 'the account');
  text = text.replace(/\b[\w.-]+\.(?:com|net|org|io|dev|internal|local)(?::\d+)?\b/gi, 'the host');
  text = text.replace(/\s+/g, ' ').trim();
  return text === '' ? 'No further detail is available.' : text;
}
