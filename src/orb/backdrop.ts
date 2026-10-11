import type { Rect } from '../shell/geometry.js';
import type { WindowOptions } from '../shell/window.js';

export type OrbBackdropMaterial = 'vibrancy' | 'acrylic' | 'blur' | 'none';

export interface OrbBackdropPlan {
  readonly supported: boolean;
  readonly material: OrbBackdropMaterial;
  readonly options?: WindowOptions;
  readonly reason?: string;
}

/**
 * Linux has no supported native material for Electron here, so the Backdrop is
 * reported unsupported rather than silently drawing a plain rectangle the user
 * would read as a broken blur. This mirrors the honesty rule the rest of the
 * shell follows for unavailable capabilities.
 */
export function planOrbBackdrop(platform: NodeJS.Platform, displayBounds: Rect): OrbBackdropPlan {
  switch (platform) {
    case 'darwin':
      return {
        supported: true,
        material: 'vibrancy',
        options: backdropOptions(displayBounds, 'under-window'),
      };
    case 'win32':
      return {
        supported: true,
        material: 'acrylic',
        options: backdropOptions(displayBounds, 'acrylic'),
      };
    default:
      return {
        supported: false,
        material: 'none',
        reason: 'A blurred backdrop is not available on this platform.',
      };
  }
}

function backdropOptions(bounds: Rect, vibrancy: string): WindowOptions {
  return {
    startHidden: true,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    clickThrough: true,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    panel: true,
    alwaysOnTopLevel: 'screen-saver',
    vibrancy,
    bounds,
  };
}
