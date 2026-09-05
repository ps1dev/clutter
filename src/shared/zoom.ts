/**
 * The one piece of zoom logic the image viewport and the timeline genuinely
 * share: resolving the new magnitude, and refusing to move anything when it
 * cannot change.
 *
 * They do NOT share a view model, and forcing them to would be worse rather
 * than better. The viewport is (origin, uniform scale) over two axes; the
 * timeline is a (start, length) window over one. What they share is the
 * POLICY, and two bugs have already come out of it being written twice:
 *
 *   - Integer snapping cancelled its own move, so 3x could not zoom out and 1x
 *     could not zoom in (reported 2026-09-04).
 *   - At the zoom limit the timeline still recentred on the cursor, so a wheel
 *     event that could not zoom silently panned instead (reported 2026-09-05).
 *
 * Both are the same mistake: deciding the new magnitude and then moving the
 * view regardless of whether the magnitude actually changed. So the rule lives
 * here once, `resolveMagnitude` returns the current value unchanged when it is
 * stuck, and both callers treat "unchanged" as "do nothing at all".
 */

export interface MagnitudeBounds {
  min: number;
  max: number;
  /** Snap to whole numbers at or above 1. Used by the image viewport only. */
  snapIntegersAboveOne?: boolean;
}

/**
 * The magnitude after applying `factor`, clamped and optionally snapped.
 *
 * Guaranteed: if the result differs from `current`, it moved in the direction
 * `factor` asked for. If it equals `current`, the request could not be
 * honoured and the caller must not move anything else either.
 */
export function resolveMagnitude(current: number, factor: number, b: MagnitudeBounds): number {
  const clamp = (v: number): number => Math.max(b.min, Math.min(b.max, v));
  const snap = (v: number): number =>
    b.snapIntegersAboveOne && v >= 1 ? clamp(Math.round(v)) : clamp(v);

  const target = snap(current * factor);
  if (target !== current || factor === 1) return target;
  if (!b.snapIntegersAboveOne) return current;

  // Snapping ate the move; take a whole step in the direction asked for.
  const stepped = factor > 1 ? Math.floor(current) + 1 : current - 1;
  const out = snap(stepped);
  // Still stuck means a real limit, not a rounding artefact.
  return out === current ? current : out;
}

/** True when a zoom request cannot change anything and should be dropped. */
export function isZoomNoop(current: number, factor: number, b: MagnitudeBounds): boolean {
  return resolveMagnitude(current, factor, b) === current;
}
