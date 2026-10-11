import type { WindowOptions } from '../shell/window.js';

/**
 * The Orb is a presence, not a window: a single transparent circle drawn over
 * the desktop with no frame, no title bar, no shadow box and no rectangular
 * background. Only the circle is painted; everywhere else is fully transparent.
 */
export const ORB_DIAMETER = 96;
export const ORB_WINDOW_PADDING = 12;
export const ORB_WINDOW_SIZE = ORB_DIAMETER + ORB_WINDOW_PADDING * 2;

export const ORB_WINDOW_OPTIONS: WindowOptions = {
  startHidden: true,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  clickThrough: true,
  focusable: false,
  hasShadow: false,
  skipTaskbar: true,
  title: 'Aria',
  panel: true,
  alwaysOnTopLevel: 'screen-saver',
};
