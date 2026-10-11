import type { RouteHint } from '../contract/aria-contract.js';
import type { OperationDescriptor } from '../supervisor/approval-scope.js';

const MAX_TITLE = 200;

export function shouldSubmit(route: RouteHint | null | undefined): boolean {
  return route !== undefined && route !== null && route.requires_confirmation === true;
}

export function deriveTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return 'Engineering request';
  return collapsed.length > MAX_TITLE ? `${collapsed.slice(0, MAX_TITLE - 1)}…` : collapsed;
}

// The route hint is advisory: it is surfaced, never treated as authorization.
// Only the capability it carries is described; the real scope comes from the
// Backend's approval gate, so Aria never fabricates privileges or resources.
export function operationForRoute(route: RouteHint): OperationDescriptor {
  return {
    capability: route.capability,
    parameters: {},
    privilege: 'user',
    riskTier: 'standard',
    affectedResources: [],
  };
}
