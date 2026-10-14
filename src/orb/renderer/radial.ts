export interface RadialAppearance {
  readonly deepColor: string;
  readonly cobaltColor: string;
  readonly aquaColor: string;
  readonly paleColor: string;
  readonly membraneColor: string;
  readonly seamColor: string;
}

export interface RadialMotion {
  readonly responseExponent: number;
  readonly activityRiseMs: number;
  readonly activityFallMs: number;
  readonly stateTransitionMs: number;
  readonly idleSpeed: number;
  readonly listeningBaseSpeed: number;
  readonly listeningSpeedRange: number;
  readonly speakingBaseSpeed: number;
  readonly speakingSpeedRange: number;
  readonly rotationAmount: number;
}

export interface RadialGeometry {
  readonly diameterRatio: number;
}

export interface RadialConfig {
  readonly appearance: RadialAppearance;
  readonly motion: RadialMotion;
  readonly geometry: RadialGeometry;
}

export const RADIAL_APPEARANCE: RadialAppearance = {
  deepColor: '#011b5e',
  cobaltColor: '#0457c2',
  aquaColor: '#3dc2c9',
  paleColor: '#c4f5f2',
  membraneColor: '#78d6d6',
  seamColor: '#fbfefe',
};

// The stock radial preset is deliberately calm; these values push every knob past
// the upstream "expressive" preset so the presence reads as forceful rather than
// polite. Rotation, listening range and speaking range all move together, which
// is what makes the change legible instead of just faster.
export const RADIAL_ULTRA_MOTION: RadialMotion = {
  responseExponent: 0.72,
  activityRiseMs: 45,
  activityFallMs: 120,
  stateTransitionMs: 220,
  idleSpeed: 0.42,
  listeningBaseSpeed: 0.62,
  listeningSpeedRange: 0.5,
  speakingBaseSpeed: 1.4,
  speakingSpeedRange: 1.8,
  rotationAmount: 1.5,
};

export const RADIAL_ULTRA: RadialConfig = {
  appearance: RADIAL_APPEARANCE,
  motion: RADIAL_ULTRA_MOTION,
  geometry: { diameterRatio: 0.86 },
};

export const RADIAL_VERTEX_SHADER = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const RADIAL_FRAGMENT_SHADER = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_rotation;
uniform float u_listen;
uniform float u_speak;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = (uv - 0.5) * 2.0;
  float radius = length(p);
  float edge = 1.0 - smoothstep(0.993, 1.0, radius);

  if (edge <= 0.0) discard;

  float angle = atan(p.y, p.x);
  float warpStrength = 0.026 + u_speak * 0.105;
  float angularWarp =
    sin(angle * 3.0 - u_time * 0.54 + radius * 2.1) +
    0.48 * sin(angle * 5.0 + u_time * 0.31 - radius * 3.7) +
    0.22 * sin(angle * 8.0 - u_time * 0.19 + radius * 5.2);
  float phase =
    angle - 1.78 - u_rotation + angularWarp * warpStrength * (0.2 + radius * 0.8);

  float lobeField = cos(phase * 2.0);
  float darkMix = smoothstep(-0.04, 0.38, lobeField);

  vec3 deepBlue = vec3(0.004, 0.105, 0.37);
  vec3 cobalt = vec3(0.015, 0.34, 0.76);
  vec3 aqua = vec3(0.24, 0.76, 0.79);
  vec3 paleAqua = vec3(0.77, 0.96, 0.95);

  float radialLight = 0.5 + 0.5 * sin(radius * 3.0 - u_time * 0.16);
  vec3 darkColor = mix(cobalt, deepBlue, 0.42 + 0.38 * radius);
  float darkRay = pow(max(lobeField, 0.0), 11.0);
  darkColor = mix(darkColor, aqua, darkRay * (0.18 + radialLight * 0.16));

  vec3 lightColor = mix(paleAqua, aqua, 0.5 + 0.2 * sin(radius * 3.4 + phase * 2.0));
  float lightRay = pow(max(-lobeField, 0.0), 5.0);
  lightColor = mix(lightColor, vec3(0.04, 0.42, 0.64), lightRay * 0.28);

  vec3 color = mix(lightColor, darkColor, darkMix);

  float secondaryRay = 0.5 + 0.5 * sin(phase * 6.0 + radius * 1.8 - u_time * 0.42);
  float rayStrength = (0.055 + u_speak * 0.045) * (0.25 + radius * 0.75);
  color = mix(color, vec3(0.26, 0.76, 0.8), secondaryRay * rayStrength);

  float rimWave =
    0.063 * sin(angle * 3.0 + u_time * 1.34) +
    0.036 * sin(angle * 5.0 - u_time * 0.91 + 1.4) +
    0.021 * sin(angle * 7.0 + u_time * 0.63 - 0.8) +
    0.012 * sin(angle * 11.0 - u_time * 1.72 + sin(angle * 2.0 + u_time * 0.58));
  rimWave *= 1.0 + u_listen * 0.38;
  float rimInner = 0.82 + rimWave - u_listen * 0.2;
  float rim = smoothstep(rimInner - 0.02, rimInner + 0.015, radius);
  float rimStrength = rim * (0.3 + u_listen * 0.3);
  vec3 membrane = mix(
    vec3(0.47, 0.84, 0.84),
    vec3(0.76, 0.93, 0.92),
    smoothstep(0.78, 1.0, radius)
  );
  color = mix(color, membrane, clamp(rimStrength, 0.0, 0.72));

  float seamDirection = max(0.0, -sin(phase * 2.0));
  float seamExponent = mix(30.0, 3.2, smoothstep(0.05, 1.0, radius));
  float seam = pow(seamDirection, seamExponent) * (0.78 + radius * 0.25);
  color = mix(color, vec3(0.985, 0.995, 0.995), clamp(seam, 0.0, 0.96));

  gl_FragColor = vec4(color * edge, edge);
}
`;

function hexToGlsl(hex: string): string {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000';
  const channels = [1, 3, 5].map((offset) =>
    (parseInt(normalized.slice(offset, offset + 2), 16) / 255).toFixed(6),
  );
  return `vec3(${channels.join(', ')})`;
}

export function radialFragmentShader(appearance: RadialAppearance): string {
  return RADIAL_FRAGMENT_SHADER.replace('vec3(0.004, 0.105, 0.37)', hexToGlsl(appearance.deepColor))
    .replace('vec3(0.015, 0.34, 0.76)', hexToGlsl(appearance.cobaltColor))
    .split('vec3(0.24, 0.76, 0.79)')
    .join(hexToGlsl(appearance.aquaColor))
    .replace('vec3(0.77, 0.96, 0.95)', hexToGlsl(appearance.paleColor))
    .replace('vec3(0.04, 0.42, 0.64)', hexToGlsl(appearance.cobaltColor))
    .replace('vec3(0.26, 0.76, 0.8)', hexToGlsl(appearance.aquaColor))
    .replace('vec3(0.47, 0.84, 0.84)', hexToGlsl(appearance.membraneColor))
    .replace('vec3(0.76, 0.93, 0.92)', hexToGlsl(appearance.paleColor))
    .replace('vec3(0.985, 0.995, 0.995)', hexToGlsl(appearance.seamColor));
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function followDuration(
  current: number,
  target: number,
  riseTimeMs: number,
  fallTimeMs: number,
  deltaSeconds: number,
): number {
  const durationMs = target > current ? riseTimeMs : fallTimeMs;
  if (durationMs <= 0) return target;
  const rate = 1 - Math.pow(0.1, (deltaSeconds * 1000) / durationMs);
  return current + (target - current) * rate;
}

export type RadialState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface RadialMotionTarget {
  readonly motionSpeed: number;
  readonly calmTempo: number;
  readonly calmAmplitude: number;
}

export function radialMotionFor(
  state: RadialState,
  listenEnergy: number,
  speakEnergy: number,
  motion: RadialMotion,
): RadialMotionTarget {
  if (state === 'connecting') {
    return { motionSpeed: motion.idleSpeed * 1.17, calmTempo: 0.68, calmAmplitude: 0.13 };
  }
  if (state === 'listening') {
    return {
      motionSpeed: motion.listeningBaseSpeed + listenEnergy * motion.listeningSpeedRange,
      calmTempo: 0.78 + listenEnergy * 0.18,
      calmAmplitude: 0.18 + listenEnergy * 0.04,
    };
  }
  if (state === 'thinking') {
    return { motionSpeed: motion.idleSpeed * 1.28, calmTempo: 0.72, calmAmplitude: 0.16 };
  }
  if (state === 'speaking') {
    return {
      motionSpeed: motion.speakingBaseSpeed + speakEnergy * motion.speakingSpeedRange,
      calmTempo: 0.62,
      calmAmplitude: 0.15,
    };
  }
  return { motionSpeed: motion.idleSpeed, calmTempo: 0.62, calmAmplitude: 0.15 };
}

export interface RadialRotationInput {
  readonly motionTime: number;
  readonly calmClock: number;
  readonly speakingClock: number;
  readonly speakEnergy: number;
  readonly calmAmplitude: number;
  readonly speakingBlend: number;
  readonly rotationAmount: number;
}

export function radialRotationTarget(input: RadialRotationInput): number {
  const calmTarget =
    Math.sin(input.calmClock) * input.calmAmplitude +
    Math.sin(input.calmClock * 0.47 + 1.1) * 0.032;
  const primarySwing = Math.sin(input.speakingClock * 1.08);
  const secondarySwing = Math.sin(input.speakingClock * 2.47 + 0.9);
  const slowDrift = Math.sin(input.speakingClock * 0.43 - 0.5);
  const swingAmplitude = 0.13 + input.speakEnergy * 0.17;
  const speakingTarget =
    primarySwing * swingAmplitude +
    secondarySwing * (0.035 + input.speakEnergy * 0.035) +
    slowDrift * 0.055;
  return (
    (calmTarget + (speakingTarget - calmTarget) * input.speakingBlend) * input.rotationAmount
  );
}

export function irregularSpeakingTempo(motionTime: number, speakEnergy: number): number {
  return (
    1.2 +
    speakEnergy * 1.35 +
    Math.sin(motionTime * 1.73) * 0.34 +
    Math.sin(motionTime * 0.61 + 0.8) * 0.18
  );
}

export interface RadialRenderer {
  draw(time: number, rotation: number, listenEnergy: number, speakEnergy: number): void;
  destroy(): void;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | undefined {
  const shader = gl.createShader(type);
  if (!shader) return undefined;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return undefined;
  }
  return shader;
}

export function createRadialRenderer(
  canvas: HTMLCanvasElement,
  diameter: number,
  appearance: RadialAppearance,
  pixelRatio = 1,
): RadialRenderer | undefined {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
  }) as WebGLRenderingContext | null;
  if (!gl) return undefined;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, RADIAL_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, radialFragmentShader(appearance));
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return undefined;
  }

  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  if (!program || !buffer) {
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return undefined;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return undefined;
  }

  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
  const timeLocation = gl.getUniformLocation(program, 'u_time');
  const rotationLocation = gl.getUniformLocation(program, 'u_rotation');
  const listenLocation = gl.getUniformLocation(program, 'u_listen');
  const speakLocation = gl.getUniformLocation(program, 'u_speak');

  if (
    positionLocation < 0 ||
    !resolutionLocation ||
    !timeLocation ||
    !rotationLocation ||
    !listenLocation ||
    !speakLocation
  ) {
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return undefined;
  }

  const ratio = Math.min(pixelRatio, 2);
  const pixelSize = Math.max(1, Math.round(diameter * ratio));
  canvas.width = pixelSize;
  canvas.height = pixelSize;

  gl.viewport(0, 0, pixelSize, pixelSize);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(resolutionLocation, pixelSize, pixelSize);

  return {
    draw(time, rotation, listenEnergy, speakEnergy) {
      gl.uniform1f(timeLocation, time);
      gl.uniform1f(rotationLocation, rotation);
      gl.uniform1f(listenLocation, listenEnergy);
      gl.uniform1f(speakLocation, speakEnergy);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    destroy() {
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    },
  };
}
