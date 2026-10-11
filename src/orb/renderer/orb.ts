import type { OrbState } from '../state.js';

export interface OrbBridge {
  orbState(): Promise<OrbState>;
}

type El = HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

export function renderOrb(doc: Document, state: OrbState): void {
  const root = doc.getElementById('orb');
  if (root === null) return;
  const presence = state.presence;

  const wrap = doc.createElement('div');
  wrap.className = 'orb';
  wrap.setAttribute('data-presence', presence.presence);
  wrap.setAttribute('data-cue', presence.cue);
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', `${presence.label}. ${presence.detail ?? ''}`.trim());

  const cue = h(doc, 'div', `cue cue-${presence.cue}`);
  cue.setAttribute('aria-hidden', 'true');

  const label = h(doc, 'p', 'label');
  label.textContent = presence.label;
  label.setAttribute('data-testid', 'orb-label');
  wrap.append(cue, label);

  if (presence.detail !== undefined) {
    const detail = h(doc, 'p', 'detail');
    detail.textContent = presence.detail;
    detail.setAttribute('data-testid', 'orb-detail');
    wrap.append(detail);
  }

  root.replaceChildren(wrap);
}

export function bootstrapOrb(doc: Document, bridge: OrbBridge): void {
  const root = doc.getElementById('orb');
  if (root !== null) {
    const loading = h(doc, 'p', 'label');
    loading.textContent = 'Idle';
    root.replaceChildren(loading);
  }
  void bridge.orbState().then((state) => renderOrb(doc, state));
}

const injected = (globalThis as { aria?: OrbBridge }).aria;

if (typeof document !== 'undefined' && injected !== undefined) {
  bootstrapOrb(document, injected);
}
