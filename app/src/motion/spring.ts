/*
 * Seek — springs, in Apple's two-parameter model.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SwiftUI's `Spring(response:dampingFraction:)` maps to a unit-mass damped
 * harmonic oscillator as:
 *
 *     ω (natural frequency) = 2π / response
 *     ζ (damping ratio)     = dampingFraction
 *
 * so `response` is "how quickly it gets there" in seconds and `damping` is
 * "how much it overshoots", which is what a designer actually reasons about.
 * Per the apple-design skill the house default is ζ = 1.0 (critically damped,
 * no overshoot) with response 0.3–0.4, and ζ ≈ 0.8 is reserved for motion that
 * followed a real momentum gesture.
 *
 * `advance()` uses the CLOSED-FORM solution rather than numeric integration.
 * That matters for two reasons: it is exact at any timestep, so a dropped frame
 * cannot change the trajectory or add energy; and it makes interruption free —
 * retargeting is just resetting x0 and v0 to the live values, which is precisely
 * the "animate from the presentation value, never the target" rule.
 */

export interface SpringConfig {
  /** Seconds. Lower is snappier. Not a duration — a spring has no fixed end. */
  response: number;
  /** Damping ratio. 1 = critically damped. Below 1 overshoots. */
  damping: number;
}

/** Anything that merely appeared must not overshoot. */
export const SPRING_DEFAULT: SpringConfig = { response: 0.35, damping: 1.0 };
/** Only after a flick, a throw, or a drag release. */
export const SPRING_MOMENTUM: SpringConfig = { response: 0.4, damping: 0.8 };
/** Snappier, for small chrome like a segmented-control indicator. */
export const SPRING_SNAPPY: SpringConfig = { response: 0.28, damping: 1.0 };

const EPS_VALUE = 0.001;
const EPS_VELOCITY = 0.01;

export class Spring {
  value: number;
  velocity: number;
  target: number;
  config: SpringConfig;

  constructor(initial = 0, config: SpringConfig = SPRING_DEFAULT) {
    this.value = initial;
    this.target = initial;
    this.velocity = 0;
    this.config = config;
  }

  /** Jump with no animation. */
  set(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /**
   * Retarget mid-flight. The current value and velocity are KEPT, which is what
   * makes a grabbed, reversed, or re-thrown animation continuous instead of
   * restarting from zero and producing a visible brick wall.
   */
  setTarget(target: number, velocity?: number): void {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
  }

  get settled(): boolean {
    return (
      Math.abs(this.value - this.target) < EPS_VALUE &&
      Math.abs(this.velocity) < EPS_VELOCITY
    );
  }

  /** Advance by `dt` seconds. Exact for any dt. */
  advance(dt: number): number {
    if (dt <= 0) return this.value;
    const { response, damping: z } = this.config;
    const w = (2 * Math.PI) / response;

    // Solve in displacement-from-target space; the target is the origin.
    const x0 = this.value - this.target;
    const v0 = this.velocity;

    let x: number;
    let v: number;

    if (Math.abs(z - 1) < 1e-6) {
      // Critically damped: x(t) = (x0 + (v0 + ω·x0)·t)·e^(−ωt)
      const c = v0 + w * x0;
      const e = Math.exp(-w * dt);
      x = (x0 + c * dt) * e;
      v = (c - w * (x0 + c * dt)) * e;
    } else if (z < 1) {
      // Under-damped: oscillates inside a decaying envelope.
      const wd = w * Math.sqrt(1 - z * z);
      const e = Math.exp(-z * w * dt);
      const cos = Math.cos(wd * dt);
      const sin = Math.sin(wd * dt);
      const a = x0;
      const b = (v0 + z * w * x0) / wd;
      x = e * (a * cos + b * sin);
      v = e * (-z * w * (a * cos + b * sin) + wd * (b * cos - a * sin));
    } else {
      // Over-damped: two real roots, no oscillation at all.
      const s = w * Math.sqrt(z * z - 1);
      const r1 = -z * w + s;
      const r2 = -z * w - s;
      const c2 = (v0 - r1 * x0) / (r2 - r1);
      const c1 = x0 - c2;
      const e1 = Math.exp(r1 * dt);
      const e2 = Math.exp(r2 * dt);
      x = c1 * e1 + c2 * e2;
      v = c1 * r1 * e1 + c2 * r2 * e2;
    }

    this.value = this.target + x;
    this.velocity = v;

    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}

/**
 * Apple's momentum projection, from the Designing Fluid Interfaces sample code.
 * Deliberately NOT the textbook v²/2a — this is the exponential-decay form that
 * matches how scrolling actually decelerates, and using the other one is why
 * hand-rolled flick gestures usually feel wrong.
 *
 * @param velocity px/sec at release
 * @param decelerationRate 0.998 for normal scroll feel, 0.99 for snappier
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Pick the snap point nearest where the gesture is actually going. */
export function nearestSnap(projected: number, snapPoints: number[]): number {
  let best = snapPoints[0];
  let bestD = Infinity;
  for (const p of snapPoints) {
    const d = Math.abs(p - projected);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * Progressive resistance past a boundary. A hard stop reads as frozen; this
 * reads as "responsive, but there is nothing more here".
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/* ------------------------------------------------------------------ driver */

export interface SpringHandle {
  /** Retarget without restarting. Safe to call every frame. */
  to(target: number, velocity?: number): void;
  set(value: number): void;
  stop(): void;
  readonly spring: Spring;
}

/**
 * Drive a spring on rAF, calling `apply` with each value. One rAF loop per
 * animated element; the loop parks itself the moment the spring settles so an
 * idle screen costs nothing.
 */
export function driveSpring(
  apply: (value: number) => void,
  initial = 0,
  config: SpringConfig = SPRING_DEFAULT,
): SpringHandle {
  const spring = new Spring(initial, config);
  let raf = 0;
  let last = 0;

  function frame(now: number): void {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    apply(spring.advance(dt));
    if (!spring.settled) {
      raf = requestAnimationFrame(frame);
    } else {
      raf = 0;
      last = 0;
    }
  }

  function kick(): void {
    if (!raf && !spring.settled) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  return {
    spring,
    to(target, velocity) {
      spring.setTarget(target, velocity);
      kick();
    },
    set(value) {
      spring.set(value);
      apply(value);
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      }
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    },
  };
}

/** Track pointer velocity over a short history — needed for a real handoff. */
export class VelocityTracker {
  private samples: Array<{ t: number; v: number }> = [];

  add(value: number, time = performance.now()): void {
    this.samples.push({ t: time, v: value });
    // ~100ms of history: long enough to be stable, short enough to be current.
    while (this.samples.length > 2 && time - this.samples[0].t > 100) this.samples.shift();
  }

  /** px/sec. Zero when there is not enough history to be honest about it. */
  get velocity(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.v - first.v) / dt;
  }

  reset(): void {
    this.samples = [];
  }
}
