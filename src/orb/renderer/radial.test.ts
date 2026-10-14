import { describe, expect, it } from 'vitest';

import {
  RADIAL_ULTRA,
  RADIAL_ULTRA_MOTION,
  clamp,
  followDuration,
  irregularSpeakingTempo,
  radialFragmentShader,
  radialMotionFor,
  radialRotationTarget,
} from './radial.js';

describe('radial helpers', () => {
  it('clamps into the unit range by default', () => {
    expect(clamp(-0.4)).toBe(0);
    expect(clamp(0.42)).toBe(0.42);
    expect(clamp(1.7)).toBe(1);
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('follows toward a target at the rise rate and snaps when the time is zero', () => {
    const risen = followDuration(0, 1, 100, 100, 0.1);
    expect(risen).toBeGreaterThan(0.5);
    expect(risen).toBeLessThan(1);
    expect(followDuration(0, 1, 0, 0, 0.1)).toBe(1);
  });

  it('uses the fall rate when the target is below the current value', () => {
    const slowFall = followDuration(1, 0, 50, 400, 0.1);
    const fastRise = followDuration(0, 1, 50, 400, 0.1);
    expect(1 - slowFall).toBeLessThan(fastRise);
  });

  it('gives every state a distinct motion speed', () => {
    const m = RADIAL_ULTRA_MOTION;
    const idle = radialMotionFor('idle', 0, 0, m).motionSpeed;
    const listening = radialMotionFor('listening', 1, 0, m).motionSpeed;
    const speaking = radialMotionFor('speaking', 0, 1, m).motionSpeed;
    const thinking = radialMotionFor('thinking', 0, 0, m).motionSpeed;
    expect(listening).toBeGreaterThan(idle);
    expect(speaking).toBeGreaterThan(listening);
    expect(thinking).toBeGreaterThan(idle);
  });

  it('pushes the ultra preset past the stock expressive preset', () => {
    expect(RADIAL_ULTRA.motion.rotationAmount).toBeGreaterThan(1.35);
    expect(RADIAL_ULTRA.motion.speakingSpeedRange).toBeGreaterThan(1.65);
    expect(RADIAL_ULTRA.motion.activityRiseMs).toBeLessThan(60);
  });

  it('keeps a single rotation trajectory and reshapes it as energy rises', () => {
    const base = {
      motionTime: 1.2,
      calmClock: 0.8,
      speakingClock: 1.4,
      speakEnergy: 0,
      calmAmplitude: 0.15,
      speakingBlend: 0,
      rotationAmount: RADIAL_ULTRA.motion.rotationAmount,
    };
    const calm = radialRotationTarget(base);
    const loud = radialRotationTarget({ ...base, speakEnergy: 1, speakingBlend: 1 });
    expect(calm).not.toBe(loud);
    expect(Number.isFinite(calm)).toBe(true);
    expect(Number.isFinite(loud)).toBe(true);
  });

  it('speeds the speaking tempo up with energy but never stalls', () => {
    expect(irregularSpeakingTempo(0, 0)).toBeGreaterThanOrEqual(0.65);
    expect(irregularSpeakingTempo(0, 1)).toBeGreaterThan(irregularSpeakingTempo(0, 0));
  });

  it('substitutes every appearance color into the shader', () => {
    const shader = radialFragmentShader(RADIAL_ULTRA.appearance);
    expect(shader).not.toContain('vec3(0.004, 0.105, 0.37)');
    expect(shader).not.toContain('vec3(0.015, 0.34, 0.76)');
    expect(shader).not.toContain('vec3(0.24, 0.76, 0.79)');
    expect(shader).toContain('precision highp float');
    expect(shader).toContain('gl_FragColor');
  });

  it('rejects a malformed color rather than injecting it into the shader', () => {
    const shader = radialFragmentShader({ ...RADIAL_ULTRA.appearance, deepColor: 'not-a-color' });
    expect(shader).toContain('vec3(0.000000, 0.000000, 0.000000)');
  });
});
