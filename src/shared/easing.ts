/**
 * Easing curves, shared by every tool that walks a parameter from A to B.
 *
 * There are two of those now - the HSB ramp across generated or existing
 * frames, and the interpolate tool that tweens between adjacent frames - and
 * spicyjpeg asked for the curve to be selectable in both. Keeping one table
 * means the two dropdowns cannot offer different sets, and a curve added here
 * appears in both without either tool being touched.
 *
 * Every function maps [0, 1] to [0, 1] with f(0) = 0 and f(1) = 1. That is the
 * contract the tests assert, because a curve that misses its endpoints shows up
 * as a frame that does not quite reach the colour you asked for, which is
 * indistinguishable from a rounding problem somewhere else.
 *
 * Inputs are NOT clamped here on purpose: a caller passing t outside [0, 1] has
 * a bug in its own parameterisation, and silently clamping it would hide that
 * behind a curve that looks nearly right.
 */

export type EasingId =
  | 'linear'
  | 'quad-in'
  | 'quad-out'
  | 'quad-in-out'
  | 'cubic-in'
  | 'cubic-out'
  | 'cubic-in-out'
  | 'sine-in'
  | 'sine-out'
  | 'sine-in-out'
  | 'expo-in'
  | 'expo-out'
  | 'expo-in-out';

export interface Easing {
  id: EasingId;
  /** What the dropdown says. */
  label: string;
  fn: (t: number) => number;
}

const pow = (n: number) => ({
  in: (t: number) => Math.pow(t, n),
  out: (t: number) => 1 - Math.pow(1 - t, n),
  inOut: (t: number) => (t < 0.5 ? Math.pow(2 * t, n) / 2 : 1 - Math.pow(2 - 2 * t, n) / 2),
});

const quad = pow(2);
const cubic = pow(3);

/**
 * Exponential is the one that needs its endpoints written out. 2^(10t-10) is
 * 2^-10, not 0, at t = 0, so the curve would start a thousandth of the way up
 * and never actually reach its own start colour.
 */
const expoIn = (t: number): number => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10));
const expoOut = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

export const EASINGS: Record<EasingId, Easing> = {
  linear: { id: 'linear', label: 'linear', fn: (t) => t },
  'quad-in': { id: 'quad-in', label: 'quadratic in', fn: quad.in },
  'quad-out': { id: 'quad-out', label: 'quadratic out', fn: quad.out },
  'quad-in-out': { id: 'quad-in-out', label: 'quadratic in-out', fn: quad.inOut },
  'cubic-in': { id: 'cubic-in', label: 'cubic in', fn: cubic.in },
  'cubic-out': { id: 'cubic-out', label: 'cubic out', fn: cubic.out },
  'cubic-in-out': { id: 'cubic-in-out', label: 'cubic in-out', fn: cubic.inOut },
  'sine-in': { id: 'sine-in', label: 'sine in', fn: (t) => 1 - Math.cos((t * Math.PI) / 2) },
  'sine-out': { id: 'sine-out', label: 'sine out', fn: (t) => Math.sin((t * Math.PI) / 2) },
  'sine-in-out': { id: 'sine-in-out', label: 'sine in-out', fn: (t) => -(Math.cos(Math.PI * t) - 1) / 2 },
  'expo-in': { id: 'expo-in', label: 'exponential in', fn: expoIn },
  'expo-out': { id: 'expo-out', label: 'exponential out', fn: expoOut },
  'expo-in-out': {
    id: 'expo-in-out',
    label: 'exponential in-out',
    fn: (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
    },
  },
};

export const EASING_IDS = Object.keys(EASINGS) as EasingId[];

export const isEasingId = (v: unknown): v is EasingId => typeof v === 'string' && v in EASINGS;

/** Apply a curve by id. An unknown id is linear rather than a crash. */
export function ease(id: EasingId | undefined, t: number): number {
  return (id ? EASINGS[id] : undefined)?.fn(t) ?? t;
}
