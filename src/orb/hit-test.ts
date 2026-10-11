import { orbCircle } from '../shell/placement.js';
import { ORB_DIAMETER, ORB_WINDOW_SIZE } from './window-options.js';

/**
 * The click-through policy for a point in the Orb window's local coordinates.
 * Only the painted circle is interactive; every pixel around it falls through
 * to the window beneath. This is pure so the policy can be asserted without a
 * display or a real compositor hit test.
 */
export function orbHitTest(
  x: number,
  y: number,
  options: { readonly windowSize?: number; readonly diameter?: number } = {},
): boolean {
  const windowSize = options.windowSize ?? ORB_WINDOW_SIZE;
  const diameter = options.diameter ?? ORB_DIAMETER;
  const circle = orbCircle({ x: 0, y: 0, width: windowSize, height: windowSize }, diameter);
  const dx = x - (circle.x + circle.width / 2);
  const dy = y - (circle.y + circle.height / 2);
  return dx * dx + dy * dy <= (circle.width / 2) * (circle.width / 2);
}
