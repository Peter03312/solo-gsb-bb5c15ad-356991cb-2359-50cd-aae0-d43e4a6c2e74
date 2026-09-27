'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planRoute, degInArc } = require('../src/routePlan');
const { computeSeamAvoidance } = require('../src/seamMath');
const { computeMultiSpec } = require('../src/multiSpec');

function approx(actual, expected, eps = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !≈ ${expected}`);
}

// 单段弧 [100°, 200°]，宽 100°
const ARC = [{ startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 }];

test('degInArc: 普通弧、跨零弧、整圈与末端 360', () => {
  assert.equal(degInArc(100, ARC[0]), true);
  assert.equal(degInArc(200, ARC[0]), true);
  assert.equal(degInArc(99.9, ARC[0]), false);
  assert.equal(degInArc(0, { startDeg: 350, endDeg: 20, wraps: true, widthDeg: 30 }), true);
  assert.equal(degInArc(30, { startDeg: 350, endDeg: 20, wraps: true, widthDeg: 30 }), false);
  assert.equal(degInArc(359, { startDeg: 300, endDeg: 360, wraps: false, widthDeg: 60 }), true);
  assert.equal(degInArc(123, { full: true, widthDeg: 360 }), true);
});

test('planRoute: 同弧内沿唯一安全方向到达', () => {
  // 120→180：顺时针 60°（段内），逆时针 300° 越界
  const r = planRoute(120, 180, ARC, null);
  assert.equal(r.status, 'ok');
  assert.equal(r.best.direction, 'cw');
  approx(r.best.sweepDeg, 60);
  assert.equal(r.cw.reachable, true);
  assert.equal(r.ccw.reachable, false);

  // 180→120：只能逆时针 60°
  const r2 = planRoute(180, 120, ARC, null);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.best.direction, 'ccw');
  approx(r2.best.sweepDeg, 60);
});

test('planRoute: 跨零弧上的顺时针路径', () => {
  const wrap = [{ startDeg: 350, endDeg: 20, wraps: true, widthDeg: 30 }];
  const r = planRoute(355, 15, wrap, null);
  assert.equal(r.status, 'ok');
  assert.equal(r.best.direction, 'cw');
  approx(r.best.sweepDeg, 20);
  // 反向只能逆时针
  const r2 = planRoute(15, 355, wrap, null);
  assert.equal(r2.best.direction, 'ccw');
  approx(r2.best.sweepDeg, 20);
});

test('单规格集成：可行段结束在整圈边界时调机路径与可用档位一致', () => {
  // 题设：C=360、W=0、保护区 [0,90]，可行 90°→360°，12 档
  const r = computeSeamAvoidance(
    360,
    0,
    [{ start: 0, end: 90 }],
    { enabled: true, steps: 12 },
    { fromDeg: 330, toDeg: 0 }
  );
  assert.equal(r.route.status, 'ok');
  assert.equal(r.route.best.direction, 'cw');
  approx(r.route.best.sweepDeg, 30);
  assert.equal(r.route.from.safe, true);
  assert.equal(r.route.to.safe, true);
  assert.equal(r.route.from.onDetent, true);
  assert.equal(r.route.to.onDetent, true);

  // 0° 为端点档位；30° 在禁用段内，端点不安全
  const r2 = computeSeamAvoidance(
    360,
    0,
    [{ start: 0, end: 90 }],
    { enabled: true, steps: 12 },
    { fromDeg: 0, toDeg: 30 }
  );
  assert.equal(r2.route.status, 'unsafe-endpoint');
});

test('planRoute: 末端 360° 的弧上，0° 视为该段端点且路径可达', () => {
  // 90°→360° 不跨零：0° 与 360° 为同一圆周点
  const arc = { startDeg: 90, endDeg: 360, wraps: false, widthDeg: 270 };
  const arcs = [arc];
  assert.equal(degInArc(0, arc), true);
  // 330→0：顺时针 30°（段内），逆时针 330° 越界
  const r = planRoute(330, 0, arcs, null);
  assert.equal(r.status, 'ok');
  assert.equal(r.best.direction, 'cw');
  approx(r.best.sweepDeg, 30);
  assert.equal(r.cw.reachable, true);
  assert.equal(r.ccw.reachable, false);
  // 0→330：只能逆时针 30°
  const r2 = planRoute(0, 330, arcs, null);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.best.direction, 'ccw');
  approx(r2.best.sweepDeg, 30);
  // 禁用段内的 45° 不安全
  const r3 = planRoute(90, 45, arcs, null);
  assert.equal(r3.status, 'unsafe-endpoint');
});

test('planRoute: 整圈可行时两方向均可达，选较短者', () => {
  const full = [{ startDeg: 0, endDeg: 0, wraps: false, widthDeg: 360, full: true }];
  const r = planRoute(10, 100, full, null); // 顺 90 / 逆 270
  assert.equal(r.cw.reachable, true);
  assert.equal(r.ccw.reachable, true);
  assert.equal(r.best.direction, 'cw');
  approx(r.best.sweepDeg, 90);

  const r2 = planRoute(100, 10, full, null); // 顺 270 / 逆 90
  assert.equal(r2.best.direction, 'ccw');
  approx(r2.best.sweepDeg, 90);
});

test('planRoute: 两方向等长（180°）取顺时针', () => {
  const full = [{ full: true, widthDeg: 360 }];
  const r = planRoute(0, 180, full, null);
  approx(r.cw.sweepDeg, 180);
  approx(r.ccw.sweepDeg, 180);
  assert.equal(r.best.direction, 'cw');
  approx(r.best.sweepDeg, 180);
});

test('planRoute: 起终点相同（含归一化后相同）转角为 0 且取顺时针', () => {
  const r = planRoute(150, 150, ARC, null);
  assert.equal(r.status, 'ok');
  assert.equal(r.samePoint, true);
  assert.equal(r.best.direction, 'cw');
  approx(r.best.sweepDeg, 0);
  assert.match(r.reason, /无需旋转/);

  const r2 = planRoute(-210, 510, ARC, null); // -210 ≡ 510 ≡ 150
  assert.equal(r2.samePoint, true);
  approx(r2.fromDeg, 150);
  approx(r2.toDeg, 150);
});

test('planRoute: 任意输入角度按整圈归一', () => {
  const wrap = [{ startDeg: 300, endDeg: 30, wraps: true, widthDeg: 90 }];
  const r = planRoute(-10, 370, wrap, null); // 350 → 10
  approx(r.fromDeg, 350);
  approx(r.toDeg, 10);
  assert.equal(r.status, 'ok');
  assert.equal(r.best.direction, 'cw');
  approx(r.best.sweepDeg, 20);
});

test('planRoute: 两端各自安全但被禁用段隔开 → 不可达', () => {
  const arcs = [
    { startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 },
    { startDeg: 250, endDeg: 350, wraps: false, widthDeg: 100 },
  ];
  const r = planRoute(150, 300, arcs, null);
  assert.equal(r.status, 'unreachable');
  assert.equal(r.from.safe, true);
  assert.equal(r.to.safe, true);
  assert.equal(r.best, null);
  assert.equal(r.cw.reachable, false);
  assert.equal(r.ccw.reachable, false);
  assert.match(r.reason, /隔开/);
});

test('planRoute: 端点不安全分别指出；无可行段时两端均不安全', () => {
  const r = planRoute(50, 150, ARC, null);
  assert.equal(r.status, 'unsafe-endpoint');
  assert.equal(r.from.safe, false);
  assert.equal(r.to.safe, true);
  assert.match(r.reason, /当前角度/);
  assert.ok(!/目标角度/.test(r.reason));

  const r2 = planRoute(150, 300, ARC, null);
  assert.equal(r2.status, 'unsafe-endpoint');
  assert.equal(r2.from.safe, true);
  assert.equal(r2.to.safe, false);
  assert.match(r2.reason, /目标角度/);

  const r3 = planRoute(50, 300, ARC, null);
  assert.match(r3.reason, /当前角度/);
  assert.match(r3.reason, /目标角度/);

  const r4 = planRoute(10, 20, [], null); // 整圈禁用
  assert.equal(r4.status, 'unsafe-endpoint');
  assert.equal(r4.from.safe, false);
  assert.equal(r4.to.safe, false);
});

test('planRoute: 启用档位时两端须落在可用档位上', () => {
  const det = {
    available: [
      { index: 0, deg: 100 },
      { index: 1, deg: 150 },
      { index: 2, deg: 200 },
    ],
  };
  const ok = planRoute(100, 200, ARC, det);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.detentsConstrained, true);
  assert.equal(ok.from.detentIndex, 0);
  assert.equal(ok.to.detentIndex, 2);

  const badTo = planRoute(100, 180, ARC, det);
  assert.equal(badTo.status, 'off-detent');
  assert.equal(badTo.to.onDetent, false);
  assert.match(badTo.reason, /目标角度.*不在可用档位/);

  const badFrom = planRoute(120, 200, ARC, det);
  assert.equal(badFrom.status, 'off-detent');
  assert.match(badFrom.reason, /当前角度.*不在可用档位/);

  // 端点不安全优先于档位问题报告
  const unsafe = planRoute(50, 200, ARC, det);
  assert.equal(unsafe.status, 'unsafe-endpoint');
});

test('planRoute: 非法角度输入抛 TypeError', () => {
  assert.throws(() => planRoute('x', 10, ARC, null), TypeError);
  assert.throws(() => planRoute(10, NaN, ARC, null), TypeError);
});

/* ---------------- 经 computeSeamAvoidance / computeMultiSpec 集成 ---------------- */

test('computeSeamAvoidance + route: 基于可行段规划，未传 route 时为 null', () => {
  // C=360 W=0，保护区 [90,180]mm → 禁用 90°–180°，可行跨零弧 180°→90°
  const zones = [{ start: 90, end: 180 }];
  const r = computeSeamAvoidance(360, 0, zones, undefined, { fromDeg: 300, toDeg: 30 });
  assert.ok(r.route);
  assert.equal(r.route.status, 'ok');
  assert.equal(r.route.best.direction, 'cw');
  approx(r.route.best.sweepDeg, 90);
  assert.equal(r.route.detentsConstrained, false);

  // 目标落在禁用区 → 端点不安全
  const r2 = computeSeamAvoidance(360, 0, zones, undefined, { fromDeg: 300, toDeg: 100 });
  assert.equal(r2.route.status, 'unsafe-endpoint');
  assert.equal(r2.route.to.safe, false);

  // 不传 route：结果不含路径
  const r3 = computeSeamAvoidance(360, 0, zones);
  assert.equal(r3.route, null);
});

test('computeSeamAvoidance + route + 档位：两端须为可用档位', () => {
  const zones = [{ start: 90, end: 180 }];
  const det = { enabled: true, steps: 12 }; // 档位 0,30,…,330
  const r = computeSeamAvoidance(360, 0, zones, det, { fromDeg: 210, toDeg: 30 });
  assert.equal(r.route.status, 'ok');
  assert.equal(r.route.detentsConstrained, true);
  assert.equal(r.route.from.detentIndex, 7);
  assert.equal(r.route.to.detentIndex, 1);

  // 35° 不是档位 → off-detent
  const r2 = computeSeamAvoidance(360, 0, zones, det, { fromDeg: 210, toDeg: 35 });
  assert.equal(r2.route.status, 'off-detent');
});

test('computeMultiSpec + route: 基于共用段，与单规格返回结构一致', () => {
  // 两个相同 C=360 规格：共用段 = 跨零弧 180°→90°
  const zones = [{ start: 90, end: 180 }];
  const r = computeMultiSpec([360, 360], 0, zones, undefined, { fromDeg: 300, toDeg: 30 });
  assert.ok(r.route);
  assert.equal(r.route.status, 'ok');
  assert.equal(r.route.best.direction, 'cw');
  approx(r.route.best.sweepDeg, 90);
  assert.equal(typeof r.route.from.safe, 'boolean');
  assert.equal(typeof r.route.reason, 'string');

  // 共用段被禁用隔成两段：两端各自安全但不可达
  const r2 = computeMultiSpec(
    [360, 360],
    0,
    [
      { start: 0, end: 90 },
      { start: 180, end: 270 },
    ],
    undefined,
    { fromDeg: 120, toDeg: 300 }
  );
  assert.equal(r2.route.status, 'unreachable');
  assert.equal(r2.route.from.safe, true);
  assert.equal(r2.route.to.safe, true);

  // 无共同解：任何端点都不安全
  const r3 = computeMultiSpec(
    [360, 180],
    0,
    [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ],
    undefined,
    { fromDeg: 10, toDeg: 20 }
  );
  assert.equal(r3.noSolution, true);
  assert.equal(r3.route.status, 'unsafe-endpoint');

  // 不传 route：route 为 null
  const r4 = computeMultiSpec([360, 360], 0, zones);
  assert.equal(r4.route, null);
});

test('computeMultiSpec + route + 档位：两端须落在可用档位', () => {
  const zones = [{ start: 90, end: 180 }];
  const det = { enabled: true, steps: 12 };
  const ok = computeMultiSpec([360, 360], 0, zones, det, { fromDeg: 210, toDeg: 30 });
  assert.equal(ok.route.status, 'ok');
  const off = computeMultiSpec([360, 360], 0, zones, det, { fromDeg: 210, toDeg: 45.5 });
  assert.equal(off.route.status, 'off-detent');
});
