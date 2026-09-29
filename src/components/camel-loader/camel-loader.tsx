/**
 * CamelLoader — animated geometric morph loading indicator for camelAI.
 *
 * Cycles through 5 keyframes (camel → flower → J → hour-glass → starburst →
 * loop) and back. Every frame is a real geometric in-between of the SVG path
 * — no opacity tricks, no masks, no crossfade. The morph is produced by
 * flubber, which builds path-interpolation functions for arbitrary shapes.
 *
 * Drop into any React 18+ project. Runs client-side only (the path morph
 * needs requestAnimationFrame); the initial render is SSR-safe and shows the
 * resolved camel statically until hydration.
 */

import { useEffect, useState } from "react";

// ============================================================================
// Path constants — all in a 1000×1000 viewBox, centered around (500, 500),
// rescaled so each shape's longest dimension is ~600 units.
// ============================================================================

/** camelAI camel-blob-v1 silhouette. The "resolved" / home state. */
const CAMEL =
  "M 332.62 196.25 c -8.85 1.04 -15.71 2.95 -22.97 6.30 -8.37 3.91 -12.92 7.02 -19.86 13.72 l -5.58 5.42 -4.39 -3.75 c -2.39 -1.99 -7.02 -4.94 -10.29 -6.54 -5.82 -2.79 -6.30 -2.87 -15.15 -2.87 -8.29 0.00 -9.65 0.24 -13.72 2.15 -18.10 8.45 -24.56 28.79 -14.91 46.97 3.11 5.82 10.21 12.60 16.27 15.47 4.63 2.15 13.32 4.39 17.46 4.39 1.75 0.00 2.15 0.32 1.83 1.36 -0.24 0.80 -2.63 7.74 -5.34 15.39 -9.01 25.76 -13.88 44.34 -17.94 69.46 -6.86 42.34 -6.78 90.99 0.08 125.52 5.98 30.14 18.74 58.61 35.96 80.38 13.40 16.91 27.43 31.82 41.31 43.70 27.11 23.37 43.70 47.53 52.55 76.71 4.39 14.27 6.54 30.22 9.65 69.14 1.83 22.17 3.67 28.55 10.37 35.41 4.15 4.31 9.65 7.18 16.91 9.01 7.18 1.75 41.95 1.99 49.28 0.32 11.16 -2.47 16.67 -5.66 22.01 -12.84 4.23 -5.58 6.06 -12.12 7.50 -25.92 8.69 -84.29 14.83 -106.86 34.29 -126.00 28.23 -27.67 75.04 -24.00 98.88 7.81 13.08 17.30 17.46 39.07 20.73 102.63 0.80 14.43 1.75 26.24 2.47 29.11 3.43 13.80 11.72 21.53 26.63 24.88 8.61 1.91 38.60 1.91 47.05 0.00 12.44 -2.79 20.18 -8.53 24.80 -18.34 2.71 -5.98 3.43 -10.29 5.58 -35.65 3.51 -42.19 12.84 -105.90 21.37 -146.73 5.10 -24.40 5.98 -32.78 5.98 -56.22 0.00 -18.98 -0.16 -22.73 -1.75 -31.74 -4.55 -25.36 -13.88 -49.52 -26.40 -68.42 -3.03 -4.55 -10.77 -14.19 -17.22 -21.45 -6.46 -7.26 -17.22 -19.78 -23.92 -27.91 -15.55 -18.82 -21.13 -24.16 -34.93 -33.01 -19.78 -12.92 -38.52 -18.66 -63.16 -19.38 -12.28 -0.40 -15.79 -0.16 -24.24 1.28 -18.90 3.19 -37.80 11.08 -53.51 22.17 -9.57 6.86 -26.32 23.44 -39.15 38.92 -12.36 14.99 -24.88 27.67 -32.46 32.93 -9.97 6.86 -20.81 10.53 -31.74 10.53 -5.18 0.00 -14.91 -2.47 -20.41 -5.26 -5.58 -2.79 -14.04 -11.48 -16.83 -17.30 -7.42 -15.23 -7.10 -34.29 0.72 -50.72 3.99 -8.37 7.02 -11.72 30.22 -32.85 l 12.76 -11.64 9.73 3.43 c 18.26 6.46 33.41 7.26 47.13 2.47 21.21 -7.42 33.33 -28.95 30.38 -54.39 -2.55 -23.13 -16.99 -42.42 -38.28 -51.28 -12.28 -5.10 -18.82 -5.90 -49.12 -6.30 l -27.27 -0.40 -1.36 -2.07 c -4.55 -6.94 -15.47 -16.11 -24.64 -20.65 -12.52 -6.22 -29.35 -9.09 -43.38 -7.34 z";

/** Flower — abstract shape with multiple sweeping lobes. */
const FLOWER =
  "M 449.66 208.78 c -10.73 2.28 -26.51 9.76 -33.51 15.78 -7.32 6.34 -14.15 17.57 -17.57 28.63 -5.53 17.89 -3.90 59.85 3.25 84.09 7.32 25.05 11.39 37.41 19.03 56.93 9.27 23.91 29.60 66.52 43.26 90.76 4.39 7.81 7.81 14.48 7.48 14.80 -0.33 0.33 -4.72 -2.44 -9.60 -6.34 -12.04 -9.43 -47.17 -33.18 -59.69 -40.34 -28.46 -16.43 -62.29 -29.76 -90.43 -36.11 -9.60 -2.11 -17.89 -2.60 -36.43 -2.11 -22.28 0.49 -24.88 0.98 -35.94 5.53 -30.25 12.36 -44.08 41.64 -39.52 83.44 5.37 50.09 24.56 76.93 62.13 87.34 14.80 4.23 50.42 3.90 71.40 -0.49 33.99 -7.32 66.03 -18.87 104.74 -38.22 12.52 -6.02 23.26 -10.90 24.07 -10.73 0.81 0.33 -4.39 6.67 -11.39 14.31 -6.99 7.64 -17.40 19.68 -23.10 26.84 -5.69 7.16 -10.90 13.34 -11.39 13.82 -1.30 1.14 -14.80 20.49 -24.40 34.97 -15.78 23.91 -29.93 53.19 -34.81 72.38 -3.42 12.85 -3.42 36.11 -0.16 45.87 1.46 4.07 6.18 11.39 10.57 16.26 9.92 11.06 28.79 20.98 47.98 25.05 16.75 3.42 45.38 3.58 58.88 0.00 27.65 -7.32 46.68 -29.11 56.11 -64.41 3.42 -12.69 3.74 -17.08 3.58 -52.86 -0.16 -22.61 -0.98 -43.43 -2.11 -49.61 -2.44 -13.34 -5.20 -33.02 -4.55 -33.51 0.16 -0.33 3.25 4.07 6.83 9.43 30.09 46.03 87.50 80.35 150.45 89.94 23.10 3.58 56.28 3.09 73.19 -0.81 15.94 -3.90 34.16 -12.52 41.96 -20.01 23.58 -22.45 22.77 -61.97 -1.63 -86.20 -13.17 -13.01 -38.06 -24.88 -65.22 -31.23 -26.02 -6.02 -53.19 -8.13 -101.17 -7.97 -25.86 0.00 -45.22 -0.49 -43.10 -1.14 52.21 -15.13 87.50 -31.55 118.08 -54.49 33.34 -25.21 59.37 -60.18 65.71 -88.97 1.14 -5.04 1.79 -15.13 1.30 -23.42 -0.49 -12.52 -1.46 -16.10 -6.02 -25.54 -16.75 -33.51 -65.55 -47.00 -104.42 -28.63 -35.94 16.92 -68.31 48.96 -106.37 105.23 -6.18 9.11 -11.55 16.43 -11.71 16.10 -0.33 -0.33 1.63 -8.78 4.23 -19.03 7.97 -30.74 10.25 -47.00 10.25 -76.28 0.00 -27.65 -2.28 -45.87 -8.46 -65.87 -17.08 -56.28 -54.97 -83.44 -101.82 -73.19 z";

/** J-shape — abstract upright form with a tucked tail. */
const J_SHAPE =
  "M 627.10 209.44 c -37.94 11.78 -62.80 36.64 -77.57 77.38 -5.98 16.45 -7.29 57.01 -2.80 93.27 2.24 18.13 2.99 32.90 2.24 44.49 -1.50 22.24 -4.86 46.54 -6.73 49.16 -0.93 0.93 -2.24 4.86 -2.99 8.41 -0.75 3.55 -2.06 7.66 -2.80 9.35 -0.93 1.50 -4.49 9.16 -8.22 16.82 -3.74 7.85 -8.97 17.01 -11.78 20.56 -7.48 9.72 -26.92 28.04 -29.53 28.04 -1.31 0.00 -3.36 1.12 -4.49 2.62 -3.55 4.11 -29.35 11.03 -36.07 9.53 -21.68 -4.67 -33.64 -19.81 -36.82 -46.73 -2.80 -22.43 -5.98 -40.93 -7.66 -42.99 -0.75 -1.12 -1.87 -4.30 -2.62 -7.10 -3.93 -16.45 -21.50 -45.42 -36.26 -59.81 -14.95 -14.77 -19.44 -18.13 -34.95 -25.61 -25.23 -12.34 -55.89 -14.21 -75.70 -4.49 -8.04 3.93 -20.37 13.27 -24.86 18.88 -1.87 2.43 -4.67 5.61 -6.17 7.10 -4.11 3.93 -13.27 24.67 -17.76 39.44 -4.86 16.26 -7.10 72.15 -3.55 94.21 1.12 7.66 2.99 19.07 3.93 25.23 2.62 17.57 13.46 55.70 17.01 59.63 0.75 1.12 1.50 2.99 1.50 4.49 0.00 6.36 21.12 44.49 33.27 60.19 11.03 14.02 36.07 38.13 49.91 48.22 27.66 19.81 66.92 36.64 100.93 43.36 6.17 1.31 14.58 2.99 18.69 3.74 4.11 0.93 20.75 2.62 36.82 3.93 30.09 2.24 74.58 0.37 92.34 -4.11 3.93 -1.12 10.65 -2.62 14.77 -3.74 4.11 -0.93 9.16 -2.43 11.21 -3.36 2.06 -0.93 9.16 -3.55 15.89 -5.98 6.73 -2.24 17.57 -7.10 24.30 -10.65 6.73 -3.74 14.77 -7.85 17.76 -9.35 6.17 -3.18 19.44 -12.34 32.71 -22.24 13.27 -10.28 29.91 -26.54 51.40 -51.03 6.17 -6.92 17.76 -23.93 17.76 -25.98 0.00 -0.93 0.75 -2.06 1.50 -2.43 3.74 -1.50 26.54 -45.79 33.08 -64.11 1.68 -5.23 3.93 -11.03 4.67 -13.08 4.30 -10.28 13.83 -47.66 17.57 -69.16 6.73 -37.57 8.22 -114.39 2.99 -151.40 -2.43 -16.45 -7.10 -38.50 -9.53 -43.93 -1.12 -2.62 -3.18 -7.29 -4.49 -10.28 -10.65 -24.67 -20.00 -38.88 -36.26 -55.33 -17.76 -17.94 -34.21 -27.85 -58.13 -35.33 -16.26 -5.05 -48.22 -5.05 -64.49 0.19 z";

/** Hour-glass — abstract pinched-waist form. */
const HOURGLASS =
  "M 382.50 226.77 c -44.64 4.45 -75.09 13.34 -102.62 29.76 -23.43 13.85 -39.17 32.50 -48.23 56.96 -4.45 12.14 -5.30 16.76 -5.47 31.30 -0.17 16.42 0.00 17.45 5.47 26.85 13.85 23.95 41.22 34.21 110.66 41.56 53.71 5.64 75.60 12.14 82.10 24.29 6.67 12.14 2.74 27.37 -8.89 35.06 -12.83 8.55 -24.63 10.78 -80.05 15.05 -54.39 4.28 -84.32 14.54 -105.36 36.09 -22.23 22.58 -32.50 56.44 -30.10 100.57 1.20 23.43 5.64 37.29 18.30 56.27 35.58 54.05 121.61 85.69 251.43 92.70 32.16 1.71 85.01 0.51 112.03 -2.57 49.77 -5.82 64.65 -8.38 98.35 -17.10 24.97 -6.33 49.09 -17.10 63.11 -28.22 26.85 -21.21 49.60 -50.80 56.78 -73.55 10.78 -34.04 3.08 -62.77 -23.43 -88.26 -5.99 -5.64 -13.00 -11.46 -15.56 -12.83 -2.74 -1.20 -8.38 -4.62 -12.83 -7.18 -20.70 -12.31 -56.61 -23.60 -96.29 -30.27 -49.09 -8.21 -75.43 -14.37 -96.47 -22.92 -28.56 -11.46 -37.97 -23.09 -29.93 -36.77 2.91 -4.96 20.35 -14.20 33.18 -17.45 4.28 -1.03 29.25 -2.57 55.59 -3.25 49.77 -1.54 64.31 -3.25 88.94 -10.78 26.17 -8.04 44.64 -21.55 56.10 -41.05 8.21 -14.03 9.41 -45.32 2.05 -59.18 -6.67 -13.17 -24.46 -27.37 -49.77 -40.02 -25.83 -13.00 -80.90 -29.42 -132.04 -39.51 -84.15 -16.59 -141.45 -21.21 -197.04 -15.56 z";

/** Starburst — soft 14-pointed gear/star generated procedurally. */
const STARBURST = polarShape(500, 500, [
  300, 190, 310, 200, 290, 200, 310, 190, 300, 210, 290, 200, 320, 200,
]);

const KEYFRAMES: readonly string[] = [
  CAMEL,
  FLOWER,
  J_SHAPE,
  HOURGLASS,
  STARBURST,
];

// ============================================================================
// Helpers
// ============================================================================

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Smooth closed cubic-bezier path through N points (Catmull-Rom interpolation).
 * Used to procedurally generate the starburst keyframe.
 */
function smoothPath(points: [number, number][]): string {
  const n = points.length;
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d +=
      ` C${c1x.toFixed(2)},${c1y.toFixed(2)}` +
      ` ${c2x.toFixed(2)},${c2y.toFixed(2)}` +
      ` ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return `${d} Z`;
}

/**
 * Polar shape: N evenly-spaced points around (cx, cy) with the given radii.
 * Index 0 = 3 o'clock, going clockwise. Pass radii in clockwise order starting
 * at the right.
 */
function polarShape(cx: number, cy: number, radii: number[]): string {
  const n = radii.length;
  const points: [number, number][] = radii.map((r, i) => {
    const angle = (i * 2 * Math.PI) / n;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  });
  return smoothPath(points);
}

// ============================================================================
// Component
// ============================================================================

export type CamelLoaderProps = {
  /** Pixel size of the rendered SVG (square). Default: 200. */
  size?: number;
  /** Full cycle duration in milliseconds. Default: 6800. */
  duration?: number;
  /** Optional className applied to the root SVG element. */
  className?: string;
  /** ARIA label for assistive tech. Default: "Loading". */
  ariaLabel?: string;
};

type Interpolator = (t: number) => string;
type FlubberInterpolate = (
  fromShape: string,
  toShape: string,
  options?: { maxSegmentLength?: number },
) => Interpolator;
type FlubberModuleShape = {
  interpolate?: unknown;
  default?: unknown;
  "module.exports"?: { interpolate?: unknown };
};

const DEFAULT_DURATION = 6800;
let interpolatorsPromise: Promise<Interpolator[] | null> | null = null;

function prefersReducedMotion(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}

function loadInterpolators(): Promise<Interpolator[] | null> {
  if (typeof window === "undefined" || prefersReducedMotion()) {
    return Promise.resolve(null);
  }

  interpolatorsPromise ??= import("./flubber.client")
    .then(({ default: flubber }) => {
      const interpolate = getFlubberInterpolate(flubber);
      const segCount = KEYFRAMES.length;
      const interpolators = KEYFRAMES.map((from, i) =>
        interpolate(from, KEYFRAMES[(i + 1) % segCount], {
          maxSegmentLength: 8,
        }),
      );
      if (!isInterpolatorArray(interpolators)) {
        throw new TypeError("flubber.interpolate returned a non-function interpolator");
      }
      return interpolators;
    })
    .catch((error) => {
      console.error("CamelLoader animation failed", error);
      return null;
    });

  return interpolatorsPromise;
}

function getFlubberInterpolate(module: FlubberModuleShape): FlubberInterpolate {
  const moduleRecord = module as Record<string, unknown>;
  const candidateModules = [
    moduleRecord.default,
    moduleRecord,
    moduleRecord["module.exports"],
  ];
  const interpolate = candidateModules
    .map((candidate) => getObjectProperty(candidate, "interpolate"))
    .find((candidate) => typeof candidate === "function");

  if (typeof interpolate !== "function") {
    throw new TypeError("flubber.interpolate is not available");
  }

  return interpolate as FlubberInterpolate;
}

function getObjectProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[property];
}

function isInterpolatorArray(value: unknown): value is Interpolator[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((interpolator) => typeof interpolator === "function")
  );
}

function getPathForTime(
  interpolators: readonly Interpolator[],
  startedAt: number,
  now: number,
  duration: number,
): string {
  const durationMs = normalizeDuration(duration);
  const elapsed = Number.isFinite(now - startedAt) ? now - startedAt : 0;
  const phase = (((elapsed % durationMs) + durationMs) % durationMs) / durationMs;
  const scaled = phase * interpolators.length;
  const segIdx = Math.min(
    interpolators.length - 1,
    Math.max(0, Math.floor(scaled)),
  );
  const localT = scaled - segIdx;
  return interpolators[segIdx](easeInOutCubic(localT));
}

function normalizeDuration(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_DURATION;
}

/**
 * Animated camelAI loading indicator. Renders an SVG that geometrically morphs
 * through 5 keyframes and loops continuously. Uses `currentColor` for fill, so
 * `color: black` (or any color) on the parent controls the silhouette color.
 */
export function CamelLoader({
  size = 200,
  duration = DEFAULT_DURATION,
  className,
  ariaLabel = "Loading",
}: CamelLoaderProps) {
  // Initial render = camel statically. Matches SSR output and is also the
  // fallback shown if `prefers-reduced-motion: reduce` is set.
  const [pathD, setPathD] = useState<string>(CAMEL);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function" ||
      prefersReducedMotion()
    ) {
      return;
    }

    let raf = 0;
    let cancelled = false;
    const durationMs = normalizeDuration(duration);

    void loadInterpolators().then((interpolators) => {
      if (cancelled || !isInterpolatorArray(interpolators)) return;

      const startedAt = performance.now();
      const tick = (now: number) => {
        if (cancelled) return;
        setPathD(getPathForTime(interpolators, startedAt, now, durationMs));
        raf = window.requestAnimationFrame(tick);
      };

      tick(performance.now());
    });

    return () => {
      cancelled = true;
      if (raf !== 0) window.cancelAnimationFrame(raf);
    };
  }, [duration]);

  return (
    <svg
      viewBox="0 0 1000 1000"
      width={size}
      height={size}
      className={className}
      style={{ display: "block", color: "currentColor" }}
      role="status"
      aria-label={ariaLabel}
    >
      <path d={pathD} fill="currentColor" />
    </svg>
  );
}

export default CamelLoader;
