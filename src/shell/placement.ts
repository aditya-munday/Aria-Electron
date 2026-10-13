import { clamp, type Point, type Rect, type Size } from './geometry.js';

/**
 * The Orb is a presence in the upper-right of the work area, not the centre.
 *
 * Only the painted circle must stay on screen; the transparent padding around it
 * may extend past the edge, so the clamp is against the circle, not the window.
 */
export const ORB_RIGHT_MARGIN = 48;
/** The Orb centre sits at this fraction of the work-area height (0 = top). */
export const ORB_VERTICAL_CENTER_FRACTION = 0.25;
/** Nudge right, as a fraction of the Orb size, past the plain right margin. */
export const ORB_RIGHT_SHIFT_FRACTION = 0.2;

export function placeOrb(
  workArea: Rect,
  size: Size,
  paintedDiameter = Math.min(size.width, size.height),
): Rect {
  const shift = size.width * ORB_RIGHT_SHIFT_FRACTION;
  const x = workArea.x + workArea.width - size.width - ORB_RIGHT_MARGIN + shift;
  const y = workArea.y + workArea.height * ORB_VERTICAL_CENTER_FRACTION - size.height / 2;
  const insetX = Math.max(0, (size.width - paintedDiameter) / 2);
  const insetY = Math.max(0, (size.height - paintedDiameter) / 2);
  const minX = workArea.x - insetX;
  const maxX = workArea.x + Math.max(0, workArea.width - size.width) + insetX;
  const minY = workArea.y - insetY;
  const maxY = workArea.y + Math.max(0, workArea.height - size.height) + insetY;
  return {
    x: clamp(x, minX, maxX),
    y: clamp(y, minY, maxY),
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
