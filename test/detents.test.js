'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDetents,
  detentPositions,
  arcsToFeasiblePieces,
  insideAnyOnCircle,
  betterCandidate,
  nearestForArc,
  analyzeDetents,
  MIN_STEPS,
  MAX_STEPS,
} = require('../src/detents');
const { computeSeamAvoidance } = require('../src/seamMath');
const { computeMultiSpec } = require('../src/multiSpec');

function approx(actual, expected, eps = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !≈ ${expected}`);
}

/* ---------------- 参数解析与校验 ---------------- */

test('parseDetents: 未启用/缺省均为禁用，输入保留由调用方负责', () => {
  assert.deepEqual(parseDetents(undefined), { enabled: false });
  assert.deepEqual(parseDetents(null), { enabled: false });
  assert.deepEqual(parseDetents(false), { enabled: false });
  assert.deepEqual(parseDetents({ enabled: false, steps: 12 }), { enabled: false });
});

test('parseDetents: steps 必须为 2～360 的整数', () => {
  assert.equal(MIN_STEPS, 2);
  assert.equal(MAX_STEPS, 360);
  assert.throws(() => parseDetents({ enabled: true, steps: 1 }), RangeError);
  assert.throws(() => parseDetents({ enabled: true, steps: 361 }), RangeError);
  assert.throws(() => parseDetents({ enabled: true, steps: 11.5 }), RangeError);
  assert.throws(() => parseDetents({ enabled: true, steps: '12' }), RangeError);
  assert.throws(() => parseDetents(true), TypeError);
  assert.throws(() => parseDetents({ enabled: true }), RangeError);
  assert.throws(() => parseDetents({ enabled: true, steps: 12, offsetDeg: 'x' }), TypeError);
});

test('parseDetents: 偏移按整圈归一', () => {
  assert.deepEqual(parseDetents({ enabled: true, steps: 4, offsetDeg: 400 }), {
    enabled: true,
    steps: 4,
    offsetDeg: 40,
  });
  assert.deepEqual(parseDetents({ enabled: true, steps: 4, offsetDeg: -90 }), {
    enabled: true,
    steps: 4,
    offsetDeg: 270,
  });
  assert.deepEqual(parseDetents({ enabled: true, steps: 4 }), {
    enabled: true,
    steps: 4,
    offsetDeg: 0,
  });
});

/* ---------------- 档位生成与几何 ---------------- */

test('detentPositions: 偏移 + n×360/steps，按整圈归一并升序', () => {
  assert.deepEqual(detentPositions({ steps: 4, offsetDeg: 0 }), [0, 90, 180, 270]);
  assert.deepEqual(detentPositions({ steps: 8, offsetDeg: 22.5 }), [
    22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5,
  ]);
  // 偏移恰好使某档落到 0
  assert.deepEqual(detentPositions({ steps: 6, offsetDeg: 60 }), [0, 60, 120, 180, 240, 300]);
  // 最大档位数 360
  assert.equal(detentPositions({ steps: 360, offsetDeg: 0 }).length, 360);
});

test('arcsToFeasiblePieces: 跨零弧拆分，整圈弧归一', () => {
  assert.deepEqual(
    arcsToFeasiblePieces([{ startDeg: 216, endDeg: 36, wraps: true, widthDeg: 180 }]),
    [
      [0, 36],
      [216, 360],
    ]
  );
  assert.deepEqual(arcsToFeasiblePieces([{ startDeg: 30, endDeg: 90, wraps: false }]), [
    [30, 90],
  ]);
  assert.deepEqual(arcsToFeasiblePieces([{ full: true }]), [[0, 360]]);
});

test('insideAnyOnCircle: 含边界，跨零片段以圆上比较', () => {
  const pieces = [
    [0, 36],
    [216, 360],
  ];
  assert.equal(insideAnyOnCircle(pieces, 0), true);
  assert.equal(insideAnyOnCircle(pieces, 36), true);
  assert.equal(insideAnyOnCircle(pieces, 216), true);
  assert.equal(insideAnyOnCircle(pieces, 100), false);
  assert.equal(insideAnyOnCircle([[30, 90]], 30), true);
  assert.equal(insideAnyOnCircle([[30, 90]], 90), true);
  assert.equal(insideAnyOnCircle([[30, 90]], 0), false);
});

test('betterCandidate: 瓶颈间隙越大越优，并列取小角度，null 视为无约束', () => {
  assert.equal(betterCandidate({ deg: 0, minGapDeg: 36 }, { deg: 300, minGapDeg: 66 }), true);
  assert.equal(betterCandidate({ deg: 300, minGapDeg: 66 }, { deg: 330, minGapDeg: 66 }), false);
  assert.equal(betterCandidate({ deg: 330, minGapDeg: 66 }, { deg: 300, minGapDeg: 66 }), true);
  assert.equal(betterCandidate({ deg: 10, minGapDeg: 5 }, { deg: 0, minGapDeg: null }), true);
  assert.equal(betterCandidate({ deg: 0, minGapDeg: null }, { deg: 10, minGapDeg: 5 }), false);
  assert.equal(betterCandidate({ deg: 30, minGapDeg: null }, { deg: 0, minGapDeg: null }), true);
});

test('nearestForArc: 普通弧与跨零弧的前后最近档位', () => {
  const cfg = { steps: 10, offsetDeg: 0 }; // 0,36,...,324
  const positions = detentPositions(cfg);
  // 弧 156.6→167.4：前 144（距 12.6），后 180（距 12.6）
  const n = nearestForArc({ startDeg: 156.6, endDeg: 167.4, wraps: false }, cfg, positions);
  approx(n.before.deg, 144);
  approx(n.before.distanceDeg, 12.6);
  approx(n.after.deg, 180);
  approx(n.after.distanceDeg, 12.6);

  // 跨零弧 350→10（宽 20）：前 324（距 26），后 36（距 26）
  const nw = nearestForArc({ startDeg: 350, endDeg: 10, wraps: true, widthDeg: 20 }, cfg, positions);
  approx(nw.before.deg, 324);
  approx(nw.before.distanceDeg, 26);
  approx(nw.after.deg, 36);
  approx(nw.after.distanceDeg, 26);
});

/* ---------------- analyzeDetents ---------------- */

test('analyzeDetents: 可用档位求交并按瓶颈间隙、小角度选默认', () => {
  // 弧 [120,240]；档位 12 档（间隔 30）；可用 120/150/180/210/240
  // 间隙以到弧两端距离为瓶颈：120→0、150→30、180→60、210→30、240→0 → 默认 180
  const arcs = [{ startDeg: 120, endDeg: 240, wraps: false }];
  const gapAt = (deg) => Math.min(Math.abs(deg - 120), Math.abs(deg - 240));
  const res = analyzeDetents(
    { steps: 12, offsetDeg: 0 },
    arcs,
    gapAt,
    (deg) => ({ x: deg })
  );
  assert.equal(res.noAvailable, false);
  assert.deepEqual(res.available.map((d) => d.deg), [120, 150, 180, 210, 240]);
  assert.equal(res.best.deg, 180);
  approx(res.best.minGapDeg, 60);
  assert.deepEqual(res.best.detail, { x: 180 });
});

test('analyzeDetents: 边界档位算可用（间隙 0）', () => {
  const arcs = [{ startDeg: 30, endDeg: 60, wraps: false }];
  const gapAt = (deg) => Math.min(Math.abs(deg - 30), Math.abs(deg - 60));
  const res = analyzeDetents({ steps: 12, offsetDeg: 0 }, arcs, gapAt, null);
  assert.deepEqual(res.available.map((d) => d.deg), [30, 60]);
  // 并列 0 间隙，取较小角度 30
  assert.equal(res.best.deg, 30);
  assert.equal(res.best.minGapDeg, 0);
});

test('analyzeDetents: 连续有解但无可用档位时给出最近前后档位', () => {
  // 弧 (156.6,167.4)，10 档没有档位落入
  const arcs = [{ startDeg: 156.6, endDeg: 167.4, widthDeg: 10.8, wraps: false }];
  const res = analyzeDetents(
    { steps: 10, offsetDeg: 0 },
    arcs,
    () => 0,
    null
  );
  assert.equal(res.available.length, 0);
  assert.equal(res.best, null);
  assert.equal(res.noAvailable, true);
  assert.equal(res.nearest.length, 1);
  approx(res.nearest[0].before.deg, 144);
  approx(res.nearest[0].after.deg, 180);
});

test('analyzeDetents: 整圈可行时全部档位可用，无约束取最小角度', () => {
  const res = analyzeDetents(
    { steps: 6, offsetDeg: 30 },
    [{ full: true, widthDeg: 360 }],
    () => null,
    null
  );
  assert.equal(res.available.length, 6);
  assert.equal(res.noAvailable, false);
  assert.equal(res.nearest.length, 0);
  assert.equal(res.best.deg, 30);
  assert.equal(res.best.minGapDeg, null);
});

/* ---------------- 单规格集成 ---------------- */

test('computeSeamAvoidance + 档位：默认档位瓶颈间隙最大、并列取小角', () => {
  // C=400 W=20；禁用 [40,120]、[180,260]mm → 角度 [36,108]、[162,234]
  // 12 档（0,30,...,330）：300 与 330 均距边界 66°，取 300
  const r = computeSeamAvoidance(
    400,
    20,
    [
      { start: 60, end: 120 },
      { start: 200, end: 260 },
    ],
    { enabled: true, steps: 12 }
  );
  assert.equal(r.best.deg, 300);
  assert.equal(r.best.mm, 400 / 1.2);
  assert.equal(r.best.detentIndex, 10);
  assert.equal(r.detents.enabled, true);
  assert.equal(r.detents.steps, 12);
  assert.equal(r.detents.available.length, 8);
  const bestItem = r.detents.available.find((d) => d.index === 10);
  approx(bestItem.gapDeg, 66);
  approx(bestItem.mm, r.best.mm);
});

test('computeSeamAvoidance + 档位：零位偏移生效', () => {
  const zones = [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ];
  const r = computeSeamAvoidance(400, 20, zones, {
    enabled: true,
    steps: 12,
    offsetDeg: 15,
  });
  // 档位 15,45,...,345；最优 315，距边界 234° 为 81°（边界 36/108/162/234）
  assert.ok(r.detents.positions.every((d) => Math.abs(((d - 15) % 30)) < 1e-9));
  assert.equal(r.best.deg, 315);
  const best = r.detents.available.find((d) => d.index === r.best.detentIndex);
  approx(best.gapDeg, 81);
});

test('computeSeamAvoidance + 档位：连续有解但无可用档位区别于覆盖整圈', () => {
  // 唯一可行段 156.6°→167.4°（宽 10.8°），10 档无档位落入
  const r = computeSeamAvoidance(400, 0, [
    { start: 0, end: 174 },
    { start: 186, end: 400 },
  ], { enabled: true, steps: 10 });
  assert.equal(r.noSolution, false);
  assert.equal(r.best, null);
  assert.equal(r.detents.noAvailable, true);
  assert.equal(r.detents.available.length, 0);
  assert.equal(r.detents.nearest.length, 1);
  approx(r.detents.nearest[0].before.deg, 144);
  approx(r.detents.nearest[0].after.deg, 180);
  approx(r.detents.nearest[0].before.distanceDeg, 12.6);
  approx(r.detents.nearest[0].after.distanceDeg, 12.6);
});

test('computeSeamAvoidance + 档位：保护区覆盖整圈时不报告“无可用档位”', () => {
  const r = computeSeamAvoidance(400, 50, [
    { start: 0, end: 180 },
    { start: 150, end: 400 },
  ], { enabled: true, steps: 12 });
  assert.equal(r.noSolution, true);
  assert.equal(r.best, null);
  assert.equal(r.detents.enabled, true);
  assert.equal(r.detents.noAvailable, false);
  assert.deepEqual(r.detents.nearest, []);
});

test('computeSeamAvoidance + 档位：无禁用区时全部档位可用，默认偏移后的最小档', () => {
  const r = computeSeamAvoidance(400, 0, [], {
    enabled: true,
    steps: 8,
    offsetDeg: 22.5,
  });
  assert.equal(r.detents.available.length, 8);
  assert.equal(r.best.deg, 22.5);
  assert.equal(r.detents.available[0].gapDeg, null);
});

test('computeSeamAvoidance + 档位：可行段结束在整圈边界时 0° 档位可用（不误报无档位）', () => {
  // C=360、W=0、保护区 [0,90] → 可行段 90°→360°；12 档 0,30,...,330
  // 可用档位为端点 90/0 及段内 120..330，共 10 档
  const r = computeSeamAvoidance(360, 0, [{ start: 0, end: 90 }], {
    enabled: true,
    steps: 12,
  });
  assert.equal(r.noSolution, false);
  assert.equal(r.detents.noAvailable, false);
  assert.deepEqual(
    r.detents.available.map((d) => d.deg),
    [0, 90, 120, 150, 180, 210, 240, 270, 300, 330]
  );
  // 段中点方向：210° 距两端各 120°，为瓶颈间隙最大档位
  assert.equal(r.detents.best.deg, 210);
  assert.equal(r.best.deg, 210);
  assert.equal(r.best.detentIndex, 7);
});

test('computeSeamAvoidance + 档位：可行段从零点开始时只含段内档位', () => {
  // C=360、W=0、保护区 [90,360] → 可行段 0°→90°；12 档中仅 0/30/60/90 可用
  const r = computeSeamAvoidance(360, 0, [{ start: 90, end: 360 }], {
    enabled: true,
    steps: 12,
  });
  assert.equal(r.detents.noAvailable, false);
  assert.deepEqual(
    r.detents.available.map((d) => d.deg),
    [0, 30, 60, 90]
  );
  // 30° 与 60° 间隙均为 30°，取较小角度 30°
  assert.equal(r.detents.best.deg, 30);
});

test('computeSeamAvoidance + 档位：真正跨零可行段的档位求交', () => {
  // C=400、保护区 [100,300]mm（90°→270°）→ 跨零可行段 270°→90°；
  // 12 档中 270/300/330/0/30/60/90 共 7 档可用
  const r = computeSeamAvoidance(400, 0, [{ start: 100, end: 300 }], {
    enabled: true,
    steps: 12,
  });
  assert.equal(r.detents.noAvailable, false);
  assert.deepEqual(
    r.detents.available.map((d) => d.deg),
    [0, 30, 60, 90, 270, 300, 330]
  );
  // 跨零段中点 0° 距两端 90°，为默认档位
  assert.equal(r.detents.best.deg, 0);
});

test('computeSeamAvoidance + 档位：关闭档位时行为与字段保持兼容', () => {
  const r = computeSeamAvoidance(400, 20, [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ]);
  assert.deepEqual(r.detents, { enabled: false });
  assert.equal(r.best.mm, 350);
  assert.equal(r.best.detentIndex, undefined);
  const r2 = computeSeamAvoidance(400, 20, [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ], { enabled: false, steps: 5 });
  assert.equal(r2.best.mm, 350);
  assert.equal(r2.detents.enabled, false);
});

/* ---------------- 多规格集成 ---------------- */

test('computeMultiSpec + 档位：默认档位最大化各规格瓶颈间隙', () => {
  // 公共段 216°→36°（宽 180，跨零），中点 306
  // 12 档：300 处间隙 min(96,84)=84；330 处 min(66,?)：
  //   spec0(C400) 边界 108/216，spec1(C200) 边界 72/216
  //   300: spec0 min(circ(300,216)=84, circ(300,108)=168)=84；spec1 216→84 → 瓶颈 84
  //   330: spec0→66；spec1 circ(330,216)=114, circ(330,72)=102 → 66
  // 默认 300：规格1 距边界 216° 为 84°（瓶颈，规格 2）；规格0 距 36° 为 96°
  const r = computeMultiSpec([400, 200], 20, [{ start: 60, end: 120 }], {
    enabled: true,
    steps: 12,
  });
  assert.equal(r.noSolution, false);
  assert.equal(r.best.deg, 300);
  assert.equal(r.best.detentIndex, 10);
  approx(r.best.minGapDeg, 84);
  assert.equal(r.best.minGapSpecIndex, 1);
  approx(r.best.gaps[0].gapDeg, 96);
  approx(r.best.gaps[1].gapDeg, 84);
  assert.ok(r.detents.available.length > 0);
  // 每个可用档位都带各规格间隙
  for (const d of r.detents.available) {
    assert.equal(d.gaps.length, 2);
    assert.ok(d.gaps.every((g) => typeof g.mm === 'number'));
  }
});

test('computeMultiSpec + 档位：并列瓶颈取较小角度', () => {
  // 两个相同 C=360 规格：禁用 90–180 与 270–360；可行 [0,90]、[180,270]
  // 4 档（0/90/180/270）恰好在边界（间隙 0）；8 档可用 0/45/90/180/225/270，
  // 45 与 225 瓶颈均为 45 → 取 45
  const r = computeMultiSpec(
    [360, 360],
    0,
    [
      { start: 90, end: 180 },
      { start: 270, end: 360 },
    ],
    { enabled: true, steps: 8 }
  );
  assert.equal(r.best.deg, 45);
  approx(r.best.minGapDeg, 45);
});

test('computeMultiSpec + 档位：连续公共段有解但无可用档位', () => {
  // 两相同 C=360 规格，W=0，唯一可行公共段 [30,40]（宽 10°）
  const zones = [{ start: 0, end: 30 }, { start: 40, end: 360 }];

  // 偏移 5°：档位 5,35,65... → 35 落在段内，默认 35
  const some = computeMultiSpec([360, 360], 0, zones, {
    enabled: true,
    steps: 12,
    offsetDeg: 5,
  });
  assert.equal(some.best.deg, 35);
  assert.equal(some.detents.noAvailable, false);

  // 偏移 15°：档位 15,45 → 均不在 [30,40]，连续有解但无可用档位
  const none = computeMultiSpec([360, 360], 0, zones, {
    enabled: true,
    steps: 12,
    offsetDeg: 15,
  });
  assert.equal(none.noSolution, false);
  assert.equal(none.best, null);
  assert.equal(none.detents.noAvailable, true);
  assert.equal(none.detents.nearest.length, 1);
  approx(none.detents.nearest[0].before.deg, 15);
  approx(none.detents.nearest[0].after.deg, 45);
  approx(none.detents.nearest[0].before.distanceDeg, 15);
  approx(none.detents.nearest[0].after.distanceDeg, 5);
});

test('computeMultiSpec + 档位：无共同解（覆盖整圈）时不产出档位默认值', () => {
  const r = computeMultiSpec(
    [360, 180],
    0,
    [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ],
    { enabled: true, steps: 12 }
  );
  assert.equal(r.noSolution, true);
  assert.equal(r.best, null);
  assert.equal(r.detents.enabled, true);
  assert.equal(r.detents.noAvailable, false);
});

test('computeMultiSpec：关闭档位时字段兼容', () => {
  const r = computeMultiSpec([400, 200], 20, [{ start: 60, end: 120 }]);
  assert.deepEqual(r.detents, { enabled: false });
  assert.equal(r.best.deg, 306);
  assert.equal(r.best.detentIndex, undefined);
});
