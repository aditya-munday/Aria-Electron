import type { OrbState } from '../state.js';
import { orbHitTest } from '../hit-test.js';
import { ORB_WINDOW_SIZE } from '../window-options.js';

export interface OrbBridge {
  orbState(): Promise<OrbState>;
  orbSetInteractive(interactive: boolean): Promise<void>;
}

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

  const orb = doc.createElement('div');
  orb.className = `orb orb-${presence.presence}`;
  orb.setAttribute('data-presence', presence.presence);
  orb.setAttribute('data-cue', presence.cue);
  orb.setAttribute('role', 'img');
  orb.setAttribute('aria-label', `${presence.label}. ${presence.detail ?? ''}`.trim());

  const halo = h(doc, 'div', 'halo');
  halo.setAttribute('aria-hidden', 'true');

  const glow = h(doc, 'div', 'glow');
  glow.setAttribute('aria-hidden', 'true');

  const core = h(doc, 'div', `core core-${presence.cue}`);
  core.setAttribute('aria-hidden', 'true');

  const ring = h(doc, 'div', 'ring');
  ring.setAttribute('aria-hidden', 'true');

  const label = h(doc, 'p', 'label');
  label.textContent = presence.label;
  label.setAttribute('data-testid', 'orb-label');

  orb.append(halo, glow, core, ring, label);

  if (presence.detail !== undefined) {
    const detail = h(doc, 'p', 'detail');
    detail.textContent = presence.detail;
    detail.setAttribute('data-testid', 'orb-detail');
    orb.append(detail);
  }

  root.replaceChildren(orb);
}

/**
 * Click-through except on the circle. The host keeps the window ignoring the
 * mouse and forwarding events; on every forwarded move we re-evaluate whether
 * the pointer is inside the painted circle and flip interactivity only when it
 * changes. Without a circle the Orb stays fully click-through.
 */
export function wirePointerInteractivity(
  doc: Document,
  bridge: OrbBridge,
  windowSize: number = ORB_WINDOW_SIZE,
): void {
  let interactive = false;
  const apply = (next: boolean): void => {
    if (next === interactive) return;
    interactive = next;
    void bridge.orbSetInteractive(next);
  };
  doc.addEventListener('mousemove', (event) => {
    apply(orbHitTest(event.clientX, event.clientY, { windowSize }));
  });
  doc.addEventListener('mouseleave', () => {
    apply(false);
  });
}

export function bootstrapOrb(
  doc: Document,
  bridge: OrbBridge,
  intervalMs = 600,
): () => void {
  const root = doc.getElementById('orb');
  if (root !== null) {
    const loading = h(doc, 'p', 'label');
    loading.textContent = 'Idle';
    root.replaceChildren(loading);
  }

  const refresh = (): void => {
    void bridge.orbState().then((state) => {
      renderOrb(doc, state);
    });
  };

  // The Orb is a live presence: it must follow the voice runtime without the
  // user reopening it, so it re-reads its state on a short interval instead of
  // rendering once and freezing.
  refresh();
  const timer = setInterval(refresh, intervalMs);
  wirePointerInteractivity(doc, bridge);

  return () => clearInterval(timer);
}

const injected = (globalThis as { aria?: OrbBridge }).aria;

if (typeof document !== 'undefined' && injected !== undefined) {
  bootstrapOrb(document, injected);
}
