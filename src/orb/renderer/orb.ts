import type { OrbState, OrbCue, OrbPresence } from '../state.js';
import { orbHitTest } from '../hit-test.js';
import { ORB_WINDOW_SIZE } from '../window-options.js';
import {
  RADIAL_ULTRA,
  clamp,
  createRadialRenderer,
  followDuration,
  irregularSpeakingTempo,
  radialMotionFor,
  radialRotationTarget,
  type RadialConfig,
  type RadialRenderer,
  type RadialState,
} from './radial.js';

export interface OrbBridge {
  orbState(): Promise<OrbState>;
  orbSetInteractive(interactive: boolean): Promise<void>;
  /** Optional: the Orb opens the chat window when tapped. */
  openChat?: () => Promise<void>;
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

/** A short, human hint shown under the label for each presence. */
const PRESENCE_HINT: Readonly<Record<OrbPresence, string>> = {
  hidden: '',
  idle: 'Tap to open chat',
  listening: 'Speak now',
  thinking: 'Working on it',
  speaking: 'Tap to interrupt',
  interrupted: 'Tap to continue',
  awaiting_approval: 'Tap to review',
  awaiting_input: 'Tap to answer',
  task_running: 'Tap to watch',
  recovering: 'Reconciling',
  error: 'Tap for details',
  muted: 'Tap to unmute',
};

// Aria has more presences than the upstream radial theme has states; each one
// folds into the nearest radial state so the motion never falls back to a blank
// idle when the app is actually busy.
const RADIAL_STATE: Readonly<Record<OrbPresence, RadialState>> = {
  hidden: 'idle',
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  interrupted: 'idle',
  awaiting_approval: 'thinking',
  awaiting_input: 'thinking',
  task_running: 'thinking',
  recovering: 'connecting',
  error: 'error',
  muted: 'idle',
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

function conicSurface(appearance: RadialConfig['appearance'], from = 12): string {
  return `conic-gradient(from ${from}deg, ${appearance.deepColor} 0deg, ${appearance.cobaltColor} 72deg, ${appearance.paleColor} 92deg, ${appearance.aquaColor} 172deg, ${appearance.deepColor} 196deg, ${appearance.cobaltColor} 254deg, ${appearance.paleColor} 278deg, ${appearance.aquaColor} 360deg)`;
}

let stopMotion: (() => void) | undefined;

function stopActiveMotion(): void {
  stopMotion?.();
  stopMotion = undefined;
}

function themeName(config: RadialConfig): string {
  return config === RADIAL_ULTRA ? 'radial-ultra' : 'radial';
}

/**
 * Paint a new presence onto an existing Orb without rebuilding it. The canvas
 * and its WebGL context stay alive for the window's lifetime; the motion loop
 * reads the new `data-orb-ui-state` through its MutationObserver and reshapes
 * the trajectory in place. Rebuilding here would strand the old WebGL context
 * and burn a fresh one on every state change, which is what made the presence
 * stutter and eventually crash once the browser's context budget ran out.
 */
function applyPresence(
  orb: HTMLElement,
  presence: OrbState['presence'],
  config: RadialConfig,
): void {
  const hue = CUE_HUE[presence.cue];
  orb.className = `orb orb-${presence.presence}`;
  orb.setAttribute('data-presence', presence.presence);
  orb.setAttribute('data-cue', presence.cue);
  orb.setAttribute('data-orb-ui-state', RADIAL_STATE[presence.presence]);
  orb.setAttribute('aria-label', `${presence.label}. ${presence.detail ?? ''}`.trim());
  orb.style.setProperty('--cue-hue', String(hue));
  orb.style.setProperty('--radial-deep', config.appearance.deepColor);
  orb.style.setProperty('--radial-cobalt', config.appearance.cobaltColor);
  orb.style.setProperty('--radial-aqua', config.appearance.aquaColor);
  orb.style.setProperty('--radial-pale', config.appearance.paleColor);
  orb.style.setProperty('--radial-seam', config.appearance.seamColor);
  orb.style.setProperty('--radial-surface', conicSurface(config.appearance));
  const label = orb.querySelector('[data-testid="orb-label"]');
  if (label !== null) label.textContent = presence.label;
  const detail = orb.querySelector('[data-testid="orb-detail"]');
  if (detail !== null) detail.textContent = presence.detail ?? PRESENCE_HINT[presence.presence];
}

export function renderOrb(doc: Document, state: OrbState, config: RadialConfig = RADIAL_ULTRA): void {
  const root = doc.getElementById('orb');
  if (root === null) return;

  const presence = state.presence;

  // A hidden presence paints nothing and stops the shader, so a dismissed Orb
  // costs no frames and holds no GPU context.
  if (presence.presence === 'hidden') {
    stopActiveMotion();
    if (root.childElementCount > 0) root.replaceChildren();
    return;
  }

  // A presence change on an Orb of the same theme updates it in place.
  const existing = root.querySelector('.orb');
  if (existing instanceof HTMLElement && existing.getAttribute('data-orb-ui-theme') === themeName(config)) {
    applyPresence(existing, presence, config);
    return;
  }

  stopActiveMotion();

  const hue = CUE_HUE[presence.cue];

  const orb = h(doc, 'div', `orb orb-${presence.presence}`);
  orb.setAttribute('data-presence', presence.presence);
  orb.setAttribute('data-cue', presence.cue);
  orb.setAttribute('data-orb-ui-theme', themeName(config));
  orb.setAttribute('data-orb-ui-state', RADIAL_STATE[presence.presence]);
  orb.setAttribute('role', 'button');
  orb.setAttribute('tabindex', '0');
  orb.setAttribute('aria-label', `${presence.label}. ${presence.detail ?? ''}`.trim());
  orb.style.setProperty('--cue-hue', String(hue));
  orb.style.setProperty('--radial-deep', config.appearance.deepColor);
  orb.style.setProperty('--radial-cobalt', config.appearance.cobaltColor);
  orb.style.setProperty('--radial-aqua', config.appearance.aquaColor);
  orb.style.setProperty('--radial-pale', config.appearance.paleColor);
  orb.style.setProperty('--radial-seam', config.appearance.seamColor);
  orb.style.setProperty('--radial-surface', conicSurface(config.appearance));

  const glow = h(doc, 'div', 'glow');
  glow.setAttribute('aria-hidden', 'true');

  const ring = h(doc, 'div', 'ring');
  ring.setAttribute('aria-hidden', 'true');

  const sphere = h(doc, 'div', 'sphere');
  sphere.setAttribute('aria-hidden', 'true');

  const canvas = doc.createElement('canvas');
  canvas.className = 'radial-surface';
  canvas.setAttribute('aria-hidden', 'true');
  sphere.append(canvas);

  const core = h(doc, 'span', 'core');
  core.setAttribute('aria-hidden', 'true');
  const specular = h(doc, 'span', 'specular');
  specular.setAttribute('aria-hidden', 'true');
  const sheen = h(doc, 'span', 'sheen');
  sheen.setAttribute('aria-hidden', 'true');
  sphere.append(core, specular, sheen);

  const orbit = h(doc, 'span', 'orbit');
  orbit.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) orbit.append(h(doc, 'i', 'mote'));

  const label = h(doc, 'p', 'label');
  label.textContent = presence.label;
  label.setAttribute('data-testid', 'orb-label');

  orb.append(glow, ring, orbit, sphere, label);

  const detail = h(doc, 'p', 'detail');
  detail.textContent = presence.detail ?? PRESENCE_HINT[presence.presence];
  detail.setAttribute('data-testid', 'orb-detail');
  orb.append(detail);

  root.replaceChildren(orb);

  const renderer = radialRendererFor(canvas, config);
  if (renderer === undefined) sphere.classList.add('radial-fallback');
  else stopMotion = startMotion(orb, renderer, RADIAL_STATE[presence.presence], config, currentReducedMotion);
}

/** Fixed pixel size used only when there is no layout to measure (jsdom). */
const GLASS_PX = 256;

/**
 * The diameter is read from the rendered sphere so the shader's drawing buffer
 * matches the CSS size; without a layout (jsdom) it falls back to the fixed
 * bitmap size. `getContext('webgl')` throws in jsdom without a GL backend, so a
 * failed probe is treated as "no WebGL" rather than allowed to escape a render.
 */
function radialRendererFor(
  canvas: HTMLCanvasElement,
  config: RadialConfig,
): RadialRenderer | undefined {
  const diameter = canvas.clientWidth > 0 ? canvas.clientWidth : GLASS_PX;
  const ratio = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  try {
    return createRadialRenderer(
      canvas,
      diameter * config.geometry.diameterRatio,
      config.appearance,
      ratio,
    );
  } catch {
    return undefined;
  }
}

function currentReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Drive the radial shader from the presence: energy follows the state (listening
 * and speaking reach full strength, everything else rests), the motion speed and
 * calm oscillators ease toward their state targets, and a spring carries one
 * rotation position and velocity across every state change so the trajectory is
 * reshaped rather than restarted.
 */
function startMotion(
  orb: HTMLElement,
  renderer: RadialRenderer,
  state: RadialState,
  config: RadialConfig,
  reducedMotion: () => boolean,
): () => void {
  const motion = config.motion;
  let stateRef = state;
  const observer = new MutationObserver(() => {
    const next = orb.getAttribute('data-orb-ui-state');
    if (next !== null) stateRef = next as RadialState;
  });
  observer.observe(orb, { attributes: true, attributeFilter: ['data-orb-ui-state'] });

  let frame = 0;
  let previousTime = performance.now();
  let motionTime = 0;
  let currentMotionSpeed = motion.idleSpeed;
  let currentCalmTempo = 0.62;
  let currentCalmAmplitude = 0.15;
  let rotation = 0;
  let rotationVelocity = 0;
  let calmClock = 0;
  let speakingClock = 0;
  let speakingBlend = stateRef === 'speaking' ? 1 : 0;
  let listenEnergy = stateRef === 'listening' ? 1 : 0;
  let speakEnergy = stateRef === 'speaking' ? 1 : 0;

  const render = (now: number): void => {
    const deltaSeconds = Math.min((now - previousTime) / 1000, 0.05);
    previousTime = now;

    const reduced = reducedMotion();
    const nextState = stateRef;

    const listenTarget = nextState === 'listening' ? 1 : 0;
    const speakTarget = nextState === 'speaking' ? 1 : 0;
    listenEnergy = reduced
      ? 0
      : followDuration(
          listenEnergy,
          listenTarget,
          motion.activityRiseMs,
          motion.activityFallMs,
          deltaSeconds,
        );
    speakEnergy = reduced
      ? 0
      : followDuration(
          speakEnergy,
          speakTarget,
          motion.activityRiseMs,
          motion.activityFallMs,
          deltaSeconds,
        );

    const target = radialMotionFor(nextState, listenEnergy, speakEnergy, motion);

    if (!reduced) {
      currentMotionSpeed = followDuration(
        currentMotionSpeed,
        target.motionSpeed,
        motion.stateTransitionMs,
        motion.stateTransitionMs,
        deltaSeconds,
      );
      currentCalmTempo = followDuration(
        currentCalmTempo,
        target.calmTempo,
        motion.stateTransitionMs,
        motion.stateTransitionMs,
        deltaSeconds,
      );
      currentCalmAmplitude = followDuration(
        currentCalmAmplitude,
        target.calmAmplitude,
        motion.stateTransitionMs,
        motion.stateTransitionMs,
        deltaSeconds,
      );
      speakingBlend = followDuration(
        speakingBlend,
        nextState === 'speaking' ? 1 : 0,
        motion.stateTransitionMs,
        motion.stateTransitionMs,
        deltaSeconds,
      );

      motionTime += deltaSeconds * currentMotionSpeed;
      calmClock += deltaSeconds * currentCalmTempo;
      speakingClock +=
        deltaSeconds * Math.max(0.65, irregularSpeakingTempo(motionTime, speakEnergy));

      const rotationTarget = radialRotationTarget({
        motionTime,
        calmClock,
        speakingClock,
        speakEnergy,
        calmAmplitude: currentCalmAmplitude,
        speakingBlend,
        rotationAmount: motion.rotationAmount,
      });

      const responsiveness = 4.2 + speakingBlend * 3;
      const stiffness = responsiveness * responsiveness;
      const drag = 2 * responsiveness;
      rotationVelocity +=
        ((rotationTarget - rotation) * stiffness - rotationVelocity * drag) * deltaSeconds;
      rotation += rotationVelocity * deltaSeconds;
    }

    renderer.draw(motionTime, rotation, clamp(listenEnergy), clamp(speakEnergy));
    frame = requestAnimationFrame(render);
  };

  frame = requestAnimationFrame(render);

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    renderer.destroy();
  };
}

/**
 * Click-through except on the circle. The host keeps the window ignoring the
 * mouse and forwarding events; on every forwarded move we re-evaluate whether
 * the pointer is inside the painted circle and flip interactivity only when it
 * changes. A tap on the circle opens the chat window, so the Orb is a usable
 * entry point rather than a decoration.
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
  doc.addEventListener('mouseleave', () => apply(false));

  const openChat = (): void => {
    void bridge.openChat?.();
  };
  doc.addEventListener('click', (event) => {
    if (orbHitTest(event.clientX, event.clientY, { windowSize })) openChat();
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openChat();
    }
  });
}

export function bootstrapOrb(doc: Document, bridge: OrbBridge, intervalMs = 600): () => void {
  const root = doc.getElementById('orb');
  if (root !== null) {
    const loading = h(doc, 'p', 'label');
    loading.textContent = 'Idle';
    root.replaceChildren(loading);
  }

  let lastPresence: string | undefined;
  const refresh = (): void => {
    void bridge.orbState().then((state) => {
      // The presence carries everything that is drawn; skip the rebuild when it
      // has not changed rather than restarting the shader several times a second.
      // `updatedAt` is a fresh timestamp on every poll, so it must be excluded or
      // the key never matches and the Orb repaints — and leaks a WebGL context —
      // on every tick. This is the same reason the chat surface strips its
      // `generatedAt`.
      const key = JSON.stringify({ ...state.presence, updatedAt: undefined });
      if (key === lastPresence) return;
      lastPresence = key;
      renderOrb(doc, state);
    });
  };

  // The Orb is a live presence: it must follow the voice runtime without the
  // user reopening it, so it re-reads its state on a short interval instead of
  // rendering once and freezing.
  refresh();
  const timer = setInterval(refresh, intervalMs);
  wirePointerInteractivity(doc, bridge);

  return () => {
    clearInterval(timer);
    stopActiveMotion();
  };
}

const injected = (globalThis as { aria?: OrbBridge }).aria;

if (typeof document !== 'undefined' && injected !== undefined) {
  bootstrapOrb(document, injected);
}
