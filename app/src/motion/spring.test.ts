/*
 * Seek — the spring harness.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This exists because choosing an in-house spring over Motion means the burden
 * of proof is on us. The two properties that justify the decision are
 * INTERRUPTIBILITY (retarget mid-flight without a jump) and VELOCITY HANDOFF
 * (a gesture's release velocity continues into the animation). Both are
 * asserted numerically below, along with the Apple parameter mapping and the
 * momentum projection formula.
 */

import { describe, expect, it } from 'vitest';
import {
  SPRING_DEFAULT, SPRING_MOMENTUM, Spring, VelocityTracker,
  nearestSnap, project, rubberband,
} from './spring.ts';

/** Step a spring at a fixed 60fps for `seconds`, collecting every value. */
function run(s: Spring, seconds: number, dt = 1 / 60): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += dt) out.push(s.advance(dt));
  return out;
}

describe('Spring — settling', () => {
  it('reaches its target', () => {
    const s = new Spring(0, SPRING_DEFAULT);
    s.setTarget(100);
    run(s, 1.5);
    expect(s.value).toBeCloseTo(100, 2);
    expect(s.settled).toBe(true);
  });

  it('critically damped motion NEVER overshoots', () => {
    const s = new Spring(0, { response: 0.35, damping: 1.0 });
    s.setTarget(100);
    const values = run(s, 2);
    expect(Math.max(...values)).toBeLessThanOrEqual(100.0001);
    // …and it is monotonic on the way there, which is what "no bounce" means.
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-9);
    }
  });

  it('damping 0.8 DOES overshoot — reserved for momentum gestures', () => {
    const s = new Spring(0, SPRING_MOMENTUM);
    s.setTarget(100);
    const values = run(s, 2);
    expect(Math.max(...values)).toBeGreaterThan(100);
    // But it is a hint of bounce, not a rubber ball.
    expect(Math.max(...values)).toBeLessThan(112);
  });

  it('response controls speed: a shorter response settles sooner', () => {
    const fast = new Spring(0, { response: 0.2, damping: 1 });
    const slow = new Spring(0, { response: 0.6, damping: 1 });
    fast.setTarget(100);
    slow.setTarget(100);
    run(fast, 0.35);
    run(slow, 0.35);
    expect(fast.value).toBeGreaterThan(slow.value);
  });

  it('is exact regardless of timestep, so a dropped frame changes nothing', () => {
    const smooth = new Spring(0, SPRING_DEFAULT);
    const janky = new Spring(0, SPRING_DEFAULT);
    smooth.setTarget(100);
    janky.setTarget(100);
    run(smooth, 0.5, 1 / 120);
    // Same elapsed time, wildly uneven frames.
    for (const dt of [1 / 30, 1 / 15, 1 / 90, 1 / 20, 1 / 60, 1 / 45]) janky.advance(dt);
    let t = 1 / 30 + 1 / 15 + 1 / 90 + 1 / 20 + 1 / 60 + 1 / 45;
    while (t < 0.5) {
      janky.advance(1 / 60);
      t += 1 / 60;
    }
    expect(janky.value).toBeCloseTo(smooth.value, 1);
  });
});

describe('Spring — interruptibility (the reason this exists)', () => {
  it('retargeting mid-flight does not jump the value', () => {
    const s = new Spring(0, SPRING_DEFAULT);
    s.setTarget(100);
    run(s, 0.15);
    const before = s.value;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(100);

    s.setTarget(-50); // grabbed and thrown the other way
    const after = s.value;
    // Position is continuous across the retarget. This is the whole game.
    expect(after).toBe(before);
  });

  it('retargeting preserves velocity — no brick wall on reversal', () => {
    const s = new Spring(0, SPRING_DEFAULT);
    s.setTarget(100);
    run(s, 0.12);
    const v = s.velocity;
    expect(v).toBeGreaterThan(0);

    s.setTarget(0);
    expect(s.velocity).toBe(v);

    // Still travelling in the original direction for at least one frame,
    // because real momentum cannot reverse instantaneously.
    const next = s.advance(1 / 60);
    expect(next).toBeGreaterThan(0);
  });

  it('a reversed spring comes back and settles at the new target', () => {
    const s = new Spring(0, SPRING_DEFAULT);
    s.setTarget(100);
    run(s, 0.12);
    s.setTarget(0);
    run(s, 2);
    expect(s.value).toBeCloseTo(0, 2);
  });

  it('survives being retargeted every single frame', () => {
    const s = new Spring(0, SPRING_DEFAULT);
    for (let i = 0; i < 120; i++) {
      s.setTarget(Math.sin(i / 10) * 100);
      s.advance(1 / 60);
      expect(Number.isFinite(s.value)).toBe(true);
      expect(Math.abs(s.value)).toBeLessThan(300);
    }
  });
});

describe('Spring — velocity handoff', () => {
  it('an injected release velocity carries into the animation', () => {
    const lazy = new Spring(0, SPRING_DEFAULT);
    const thrown = new Spring(0, SPRING_DEFAULT);
    lazy.setTarget(100);
    thrown.setTarget(100, 1200); // released at 1200 px/s

    lazy.advance(1 / 60);
    thrown.advance(1 / 60);
    expect(thrown.value).toBeGreaterThan(lazy.value);
  });

  it('a throw AWAY from the target still returns to it', () => {
    const s = new Spring(0, SPRING_DEFAULT);
    s.setTarget(100, -800);
    const values = run(s, 2);
    expect(Math.min(...values)).toBeLessThan(0); // it genuinely went backwards
    expect(s.value).toBeCloseTo(100, 2);
  });

  it('VelocityTracker measures px/sec from a pointer history', () => {
    const t = new VelocityTracker();
    t.add(0, 1000);
    t.add(10, 1016);
    t.add(20, 1032);
    t.add(30, 1048);
    // 30px over 48ms ≈ 625 px/s
    expect(t.velocity).toBeGreaterThan(500);
    expect(t.velocity).toBeLessThan(750);
  });

  it('reports zero velocity rather than guessing from one sample', () => {
    const t = new VelocityTracker();
    t.add(0, 1000);
    expect(t.velocity).toBe(0);
  });
});

describe('momentum projection', () => {
  it('matches Apple’s exponential-decay formula, not v²/2a', () => {
    // (v/1000)·d/(1−d) with d = 0.998 → v × 0.499
    expect(project(1000)).toBeCloseTo(0.998 / 0.002, 3);
    expect(project(2000, 0.998)).toBeCloseTo(2 * (0.998 / 0.002), 3);
  });

  it('projects further for a faster flick, and reverses sign', () => {
    expect(project(2000)).toBeGreaterThan(project(500));
    expect(project(-800)).toBeLessThan(0);
  });

  it('snaps to the point nearest where the gesture was going, not where it stopped', () => {
    const snaps = [0, 200, 400];
    // Released at 20px but moving fast: the projection lands it well past 200.
    expect(nearestSnap(20 + project(700), snaps)).toBe(400);
    // Released at the same place, barely moving: it stays home.
    expect(nearestSnap(20 + project(10), snaps)).toBe(0);
  });
});

describe('rubberband', () => {
  it('resists progressively instead of stopping hard', () => {
    const a = rubberband(50, 800);
    const b = rubberband(200, 800);
    expect(a).toBeLessThan(50);
    expect(b).toBeLessThan(200);
    // Further past the edge means proportionally less movement.
    expect(b / 200).toBeLessThan(a / 50);
  });

  it('is symmetric', () => {
    expect(rubberband(-60, 800)).toBeCloseTo(-rubberband(60, 800), 6);
  });
});
