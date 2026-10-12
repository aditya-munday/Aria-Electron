import type { OrbState, OrbCue } from '../state.js';
import { orbHitTest } from '../hit-test.js';
import { ORB_WINDOW_SIZE } from '../window-options.js';

export interface OrbBridge {
  orbState(): Promise<OrbState>;
  orbSetInteractive(interactive: boolean): Promise<void>;
}

/** The accent hue (degrees) each cue tints the glass and glow with. */
const CUE_HUE: Readonly<Record<OrbCue, number>> = {
  none: 262,
  dot: 262,
  waveform: 188,
  pulse: 270,
  bars: 152,
  halt: 274,
  shield: 198,
  question: 45,
  gear: 34,
  restore: 220,
  alert: 0,
  slash: 220,
};

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
  const hue = CUE_HUE[presence.cue];

  const orb = doc.createElement('div');
  orb.className = `orb orb-${presence.presence}`;
  orb.setAttribute('data-presence', presence.presence);
  orb.setAttribute('data-cue', presence.cue);
  orb.setAttribute('role', 'img');
  orb.setAttribute('aria-label', `${presence.label}. ${presence.detail ?? ''}`.trim());
  orb.style.setProperty('--cue-hue', String(hue));

  const glow = h(doc, 'div', 'glow');
  glow.setAttribute('aria-hidden', 'true');

  const sphere = h(doc, 'div', 'sphere');
  sphere.setAttribute('aria-hidden', 'true');

  const canvas = doc.createElement('canvas');
  canvas.className = 'glass';
  canvas.setAttribute('aria-hidden', 'true');
  sphere.append(canvas);

  // Without a canvas context (jsdom, a blocked GPU) the CSS glass still paints,
  // so the Orb is never a blank circle.
  const ctx = canvasContext(canvas);
  if (ctx !== null) {
    paintGlass(ctx, canvas, presence.cue);
  } else {
    sphere.classList.add('glass-fallback');
  }

  const specular = h(doc, 'span', 'specular');
  specular.setAttribute('aria-hidden', 'true');
  sphere.append(specular);

  const label = h(doc, 'p', 'label');
  label.textContent = presence.label;
  label.setAttribute('data-testid', 'orb-label');

  orb.append(glow, sphere, label);

  if (presence.detail !== undefined) {
    const detail = h(doc, 'p', 'detail');
    detail.textContent = presence.detail;
    detail.setAttribute('data-testid', 'orb-detail');
    orb.append(detail);
  }

  root.replaceChildren(orb);
}

/** The glass is a fixed 256px bitmap scaled to CSS size by the stylesheet. */
const GLASS_PX = 256;

/**
 * A 2D context, or `null` when the environment has none. `getContext` throws in
 * jsdom without the canvas package, so a failed probe is treated as "no canvas"
 * rather than being allowed to escape a render.
 */
function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/**
 * Paint the glass: a dark refracting sphere with a bright prism ribbon sweeping
 * a full spectrum across it, red riding above the ribbon and blue below, plus a
 * specular highlight offset toward the light. Drawn once per render; the motion
 * is CSS.
 */
function paintGlass(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cue: OrbCue,
): void {
  canvas.width = GLASS_PX;
  canvas.height = GLASS_PX;
  const r = GLASS_PX / 2;
  const cx = r;
  const cy = r;

  ctx.clearRect(0, 0, GLASS_PX, GLASS_PX);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
  ctx.clip();

  // The smoked glass body: darker at the rim, lit through the middle.
  const body = ctx.createRadialGradient(cx * 0.62, cy * 0.56, r * 0.1, cx, cy, r);
  body.addColorStop(0, 'rgba(38,44,68,0.92)');
  body.addColorStop(0.55, 'rgba(20,24,40,0.9)');
  body.addColorStop(1, 'rgba(6,8,16,0.98)');
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, GLASS_PX, GLASS_PX);

  const drift = cue === 'gear' ? 0.5 : 0;
  paintRibbon(ctx, cx, cy, r, -0.34 + drift, 1);
  paintRibbon(ctx, cx, cy, r, -0.5 + drift, GLASS_PX / 150);

  // Specular highlight toward the light source.
  const spec = ctx.createRadialGradient(cx * 0.66, cy * 0.6, 0, cx * 0.66, cy * 0.6, r * 0.5);
  spec.addColorStop(0, 'rgba(255,255,255,0.55)');
  spec.addColorStop(0.35, 'rgba(255,255,255,0.06)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(0, 0, GLASS_PX, GLASS_PX);

  ctx.restore();
}

function paintRibbon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  angle: number,
  thickness: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${Math.round(thickness * 2)}px)`;

  const length = r * 2.3;
  const half = r * 0.34;
  const stops = 26;
  const band = length / stops;
  for (let i = 0; i <= stops; i += 1) {
    const t = i / stops;
    const x = (t - 0.5) * length;
    const hue = t * 300;
    const grad = ctx.createLinearGradient(0, -half, 0, half);
    grad.addColorStop(0, `hsla(${hue} 90% 60% / 0)`);
    grad.addColorStop(0.24, `hsl(0 95% 62%)`);
    grad.addColorStop(0.5, `hsl(${hue} 96% 72%)`);
    grad.addColorStop(0.76, `hsl(220 95% 60%)`);
    grad.addColorStop(1, `hsla(240 90% 55% / 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, -half, band + 2, half * 2);
  }

  ctx.restore();
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
