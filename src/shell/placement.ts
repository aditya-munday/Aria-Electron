import { clamp, type Point, type Rect, type Size } from './geometry.js';

/**
 * The Siri-like placement for the Orb: anchored to the right edge of a work
 * area, vertically at two sixths of its height. This is pure so it can be
 * asserted without a display.
 */
export const ORB_RIGHT_MARGIN = 32;
export const ORB_VERTICAL_SIXTHS = 2;
export const ORB_VERTICAL_DENOMINATOR = 6;

export function placeOrb(workArea: Rect, size: Size): Rect {
  const x = workArea.x + workArea.width - size.width - ORB_RIGHT_MARGIN;
  const y = workArea.y + (workArea.height * ORB_VERTICAL_SIXTHS) / ORB_VERTICAL_DENOMINATOR;
  const maxX = workArea.x + Math.max(0, workArea.width - size.width);
  const maxY = workArea.y + Math.max(0, workArea.height - size.height);
  return {
    x: clamp(x, workArea.x, maxX),
    y: clamp(y, workArea.y, maxY),
    width: size.width,
    height: size.height,
  };
}

/** The circle the user can perceive and, therefore, click on. */
export function orbCircle(bounds: Rect, diameter: number): Rect {
  const clamped = clamp(diameter, 0, Math.min(bounds.width, bounds.height));
  return {
    x: bounds.x + (bounds.width - clamped) / 2,
    y: bounds.y + (bounds.height - clamped) / 2,
    width: clamped,
    height: clamped,
  };
}

export interface ScreenInfo {
  readonly workArea: Rect;
  readonly bounds: Rect;
  readonly primary: boolean;
}

export interface ScreenProvider {
  primary(): ScreenInfo;
  displayNearestPoint(point: Point): ScreenInfo;
}
