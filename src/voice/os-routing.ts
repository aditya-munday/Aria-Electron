/**
 * The OS/CLI route surface, client half.
 *
 * The Backend's gateway may attach a `route` hint to a chat reply naming a
 * system or command-line action it proposes. Aria only *surfaces* that hint:
 * it asks the user to confirm, and on an affirmative reply re-sends the same
 * request with `confirm: true` so the Backend — never Aria — executes the
 * operation. Aria has no authority over the operating system.
 *
 * Everything here is pure: recognizing a confirmation and phrasing the prompt
 * are decisions, not side effects, so they are testable without a session.
 */

import type { RouteHint } from '../contract/aria-contract.js';

/** How a user's reply reads against a pending confirmation. */
export type ConfirmationIntent = 'affirm' | 'deny' | 'unclear';

/** A route hint that asks for explicit confirmation before it is executed. */
export function requiresConfirmation(route: RouteHint | null | undefined): route is RouteHint {
  return route !== null && route !== undefined && route.requires_confirmation === true;
}

/**
 * A short spoken/visible prompt for a proposed action. The Backend sends only a
 * capability id, so the prompt names that id rather than inventing a title the
 * Backend never gave.
 */
export function confirmationPrompt(route: RouteHint): string {
  return `Confirm ${humanizeCapability(route.capability)}? Say yes or no.`;
}

function humanizeCapability(capability: string): string {
  const tail = capability.includes('.') ? capability.slice(capability.indexOf('.') + 1) : capability;
  const words = tail.replace(/[_-]+/g, ' ').trim();
  return words === '' ? capability : words;
}

/** The spoken cue that turns a backend question into a yes/no confirmation. */
const CONFIRMATION_CUE = 'Say yes or no.';

/**
 * Turn a reply that proposes a system action into the reply Aria shows and
 * speaks. The Backend's own question is kept verbatim (it knows the operation);
 * Aria only appends the yes/no cue. When the Backend sent no text, the prompt is
 * named from the capability id instead of speaking a bare cue.
 */
export function confirmationReply(
  text: string,
  route: RouteHint,
): { readonly text: string; readonly spoken: string } {
  const base = text.trim();
  if (base === '') {
    const prompt = confirmationPrompt(route);
    return { text: prompt, spoken: prompt };
  }
  if (/(say\s+)?yes\s+or\s+no|yes\s*\/\s*no/i.test(base)) {
    return { text: base, spoken: '' };
  }
  return { text: `${base} ${CONFIRMATION_CUE}`, spoken: CONFIRMATION_CUE };
}

const AFFIRMATIVE: ReadonlySet<string> = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'do it',
  'go ahead',
  'proceed',
  'affirmative',
]);

const NEGATIVE: ReadonlySet<string> = new Set([
  'no',
  'nope',
  'nah',
  'cancel',
  'stop',
  'deny',
  'negative',
  'abort',
  'never mind',
  'nevermind',
]);

/**
 * Read a reply as an affirmation, a denial, or neither. Only a clear yes/no is
 * acted on; anything else is `unclear`, so an ambiguous reply never triggers a
 * system action and never silently cancels one either.
 */
export function interpretConfirmation(text: string): ConfirmationIntent {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ');
  if (normalized === '') return 'unclear';
  if (AFFIRMATIVE.has(normalized)) return 'affirm';
  if (NEGATIVE.has(normalized)) return 'deny';
  return 'unclear';
}
