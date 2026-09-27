'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSeamAvoidance } = require('../src/seamMath');
const {
  feasibleDegPieces,
  forbiddenDegPieces,
  intersectPieces,
  toCircularArcs,
  circDistDeg,
  gapForSpec,
  intrusionForSpec,
  computeMinViolationFallback,
  computeMultiSpec,
  MIN_SPECS,
  MAX_SPECS,
} = require('../src/multiSpec');

function approx(actual, expected, eps = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !≈ ${expected}`);
}

function arcsToPairs(arcs) {
  return arcs.map((a) => [a.startDeg, a.endDeg]);
}

test('feasibleDegPieces: 可行段结束在整圈边界时保持 360° 表示（不归零）', () => {
  // 周长 360、W=0、保护区 [0,90] → 可行段 90°→360°（不跨零）
  const r = computeSeamAvoidance(360, 0, [{ start: 0, end: 90 }]);
  assert.deepEqual(feasibleDegPieces(r), [[90, 360]]);
  // 反向边界：可行段从零点开始 0°→90°
  const r2 = computeSeamAvoidance(360, 0, [{ start: 90, end: 360 }]);
  assert.deepEqual(feasibleDegPieces(r2), [[0, 90]]);
});

test('feasibleDegPieces: 跨零可行段拆为两段，整圈/无解正确', () => {
  // C=400 W=20 保护区 [60,120] → 禁用 36°–108°，可行段跨零（108°→36°）
  const r = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  assert.deepEqual(feasibleDegPieces(r), [
    [0, 36],
    [108, 360],
  ]);
  assert.deepEqual(forbiddenDegPieces(r), [[36, 108]]);

  const none = computeSeamAvoidance(400, 50, [
    { start: 0, end: 180 },
    { start: 150, end: 400 },
  ]);
  assert.equal(none.noSolution, true);
  assert.deepEqual(feasibleDegPieces(none), []);
  assert.deepEqual(forbiddenDegPieces(none), [[0, 360]]);

  const all = computeSeamAvoidance(400, 20, []);
  assert.deepEqual(feasibleDegPieces(all), [[0, 360]]);
  assert.deepEqual(forbiddenDegPieces(all), []);
});

test('intersectPieces: 普通、跨零与零交集', () => {
  // [0,90]∪[180,360] ∩ [0,45]∪[270,360] = [0,45]∪[270,360]
  assert.deepEqual(
    intersectPieces([
      [
        [0, 90],
        [180, 360],
      ],
      [
        [0, 45],
        [270, 360],
      ],
    ]),
    [
      [0, 45],
      [270, 360],
    ]
  );
  // 仅在一点相接不算共同解
  assert.deepEqual(intersectPieces([[[0, 90]], [[90, 180]]]), []);
  // 与整圈相交保持不变
  assert.deepEqual(intersectPieces([[[0, 360]], [[30, 60]]]), [[30, 60]]);
});

test('toCircularArcs: 零点两侧合并为跨零弧', () => {
  const { arcs } = toCircularArcs([
    [0, 36],
    [108, 360],
  ]);
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0].startDeg, 108);
  assert.equal(arcs[0].endDeg, 36);
  assert.equal(arcs[0].wraps, true);
  approx(arcs[0].widthDeg, 288);

  const inner = toCircularArcs([
    [30, 90],
    [200, 260],
  ]).arcs;
  assert.deepEqual(arcsToPairs(inner), [
    [30, 90],
    [200, 260],
  ]);
  assert.equal(inner.every((a) => !a.wraps), true);

  assert.equal(toCircularArcs([[0, 360]]).full, true);
  assert.deepEqual(toCircularArcs([]).arcs, []);
});

test('circDistDeg: 最短圆周角距离', () => {
  approx(circDistDeg(10, 20), 10);
  approx(circDistDeg(350, 10), 20);
  approx(circDistDeg(0, 180), 180);
});

test('gapForSpec: 到最近禁用边界；无禁用区为 Infinity', () => {
  // 禁用 36°–108°
  const r = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  approx(gapForSpec(306, r), 90); // 距 36° 边界走短弧 90°
  approx(gapForSpec(72, r), 36);
  const empty = computeSeamAvoidance(400, 20, []);
  assert.equal(gapForSpec(123, empty), Infinity);
});

test('computeMultiSpec: 参数数量限制 2～8', () => {
  assert.equal(MIN_SPECS, 2);
  assert.equal(MAX_SPECS, 8);
  assert.throws(() => computeMultiSpec([400], 0, []), RangeError);
  assert.throws(
    () => computeMultiSpec([100, 200, 300, 400, 500, 600, 700, 800, 900], 0, []),
    RangeError
  );
});

test('computeMultiSpec: 两规格公共可行段为角度域交集，默认点最大化最小间隙', () => {
  // 共用 W=20、保护区 [60,120]mm：
  //  C=400：禁用 36°–108°，可行 108°→36°（跨零）
  //  C=200：禁用 72°–216°，可行 216°→72°（跨零）
  //  公共可行：216°→36°，宽 180°，中点 306°
  const r = computeMultiSpec([400, 200], 20, [{ start: 60, end: 120 }]);
  assert.equal(r.noSolution, false);
  assert.equal(r.fullCircle, false);
  assert.equal(r.common.length, 1);
  assert.equal(r.common[0].startDeg, 216);
  assert.equal(r.common[0].endDeg, 36);
  assert.equal(r.common[0].wraps, true);
  approx(r.common[0].widthDeg, 180);

  assert.equal(r.best.deg, 306);
  approx(r.best.minGapDeg, 90);
  // 两规格在 306° 处距各自禁用边界均为 90°
  approx(r.best.gaps[0].gapDeg, 90);
  approx(r.best.gaps[1].gapDeg, 90);
  assert.equal(r.best.gaps[0].mm, 340); // 306° 对应 C=400 规格的 340mm
  assert.equal(r.best.gaps[1].mm, 170); // C=200 规格的 170mm
  assert.equal(r.specs.length, 2);
});

test('computeMultiSpec: 公共段等宽并列时默认点取较小角度', () => {
  // 两个相同 C=360 规格：禁用 90°–180° 与 270°–360°
  // 可行段 [0,90]、[180,270] 等宽 → 中点 45° 与 225°，取 45°
  const r = computeMultiSpec(
    [360, 360],
    0,
    [
      { start: 90, end: 180 },
      { start: 270, end: 360 },
    ]
  );
  assert.equal(r.common.length, 2);
  assert.equal(r.best.deg, 45);
  approx(r.best.minGapDeg, 45);
});

test('computeMultiSpec: 所有规格均无禁用区时整圈公共、默认 0°', () => {
  const r = computeMultiSpec([400, 200], 0, []);
  assert.equal(r.fullCircle, true);
  assert.equal(r.best.deg, 0);
  assert.equal(r.best.minGapDeg, null);
  assert.deepEqual(
    r.best.gaps.map((g) => g.gapDeg),
    [null, null]
  );
});

test('computeMultiSpec: 公共安全段结束在整圈边界时与单规格表示一致', () => {
  // 两相同 C=360 规格，W=0，保护区 [0,90] → 共用段 90°→360°，不跨零
  const r = computeMultiSpec(
    [360, 360],
    0,
    [{ start: 0, end: 90 }],
    { enabled: true, steps: 12 },
    { fromDeg: 330, toDeg: 0 }
  );
  assert.equal(r.noSolution, false);
  assert.equal(r.common.length, 1);
  assert.deepEqual(
    r.common.map((a) => [a.startDeg, a.endDeg, a.wraps]),
    [[90, 360, false]]
  );
  // 与单规格接口一致：0° 档位可用（端点），不误报无可用档位
  assert.equal(r.detents.noAvailable, false);
  assert.deepEqual(
    r.detents.available.map((d) => d.deg),
    [0, 90, 120, 150, 180, 210, 240, 270, 300, 330]
  );
  assert.equal(r.detents.best.deg, 210);
  assert.equal(r.best.deg, 210);
  // 调机路径：330°→0° 顺时针 30° 全程安全且两端在可用档位上
  assert.equal(r.route.status, 'ok');
  assert.equal(r.route.best.direction, 'cw');
  approx(r.route.best.sweepDeg, 30);
});

test('computeMultiSpec: 无共同解时报告首次归零的规格与冲突区间', () => {
  // C=360：保护区 [90,180]、[180,360]，W=0 → 禁用 90°–360°，公共候选剩 [0,90]
  // C=180：两保护区在小周长上覆盖整圈 → 该规格本身无解，交集归零
  const r = computeMultiSpec(
    [360, 180],
    0,
    [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ]
  );
  assert.equal(r.noSolution, true);
  assert.equal(r.best, null);
  assert.deepEqual(r.common, []);
  assert.ok(r.blocker);
  assert.equal(r.blocker.index, 1);
  assert.equal(r.blocker.circumference, 180);
  // 冲突区间 = 此前公共段 [0,90] ∩ 该规格禁用（整圈）= [0,90]
  assert.deepEqual(arcsToPairs(r.blocker.conflictSegments), [[0, 90]]);
  assert.deepEqual(arcsToPairs(r.blocker.priorCommon), [[0, 90]]);
  assert.deepEqual(arcsToPairs(r.blocker.blockingForbidden), [[0, 360]]);
});

test('computeMultiSpec: 首个规格自身无解时立即归零并标 0', () => {
  const r = computeMultiSpec(
    [400, 300],
    50,
    [
      { start: 0, end: 180 },
      { start: 150, end: 400 },
    ]
  );
  assert.equal(r.noSolution, true);
  assert.equal(r.blocker.index, 0);
  assert.equal(r.blocker.conflictSegments.length, 1);
  assert.equal(r.blocker.conflictSegments[0].full, true);
});

test('computeMultiSpec: 按输入顺序定位首个使交集归零的规格', () => {
  // 前两个 C=360 规格公共段 [0,90]，第三个 C=180 覆盖整圈 → blocker.index=2
  const r = computeMultiSpec(
    [360, 360, 180],
    0,
    [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ]
  );
  assert.equal(r.noSolution, true);
  assert.equal(r.blocker.index, 2);
  assert.deepEqual(arcsToPairs(r.blocker.conflictSegments), [[0, 90]]);
});

test('computeMultiSpec: 8 个规格可正常求交，接缝加宽会缩小公共段', () => {
  const Cs = [300, 320, 340, 360, 380, 400, 420, 440];
  const zones = [{ start: 90, end: 150 }];
  const thin = computeMultiSpec(Cs, 0, zones);
  const wide = computeMultiSpec(Cs, 40, zones);
  assert.equal(thin.noSolution, false);
  assert.equal(wide.noSolution, false);
  const thinWidth = Math.max(...thin.common.map((a) => a.widthDeg));
  const wideWidth = Math.max(...wide.common.map((a) => a.widthDeg));
  assert.ok(wideWidth < thinWidth);
});

/* ---------------- 最小违约备选 ---------------- */

test('intrusionForSpec: 落在禁用弧内/外、跨零弧与整圈的侵入深度', () => {
  const normal = [{ startDeg: 36, endDeg: 108, wraps: false, widthDeg: 72 }];
  approx(intrusionForSpec(72, normal), 36); // 弧中点
  approx(intrusionForSpec(36, normal), 0); // 出口边界
  approx(intrusionForSpec(200, normal), 0); // 弧外
  // 跨零弧 350°→10°：零点在弧内部，出口在 350°/10°
  const wrap = [{ startDeg: 350, endDeg: 10, wraps: true, widthDeg: 20 }];
  approx(intrusionForSpec(0, wrap), 10);
  approx(intrusionForSpec(355, wrap), 5);
  approx(intrusionForSpec(5, wrap), 5);
  approx(intrusionForSpec(180, wrap), 0);
  approx(intrusionForSpec(10, wrap), 0);
  // 整圈禁用
  const full = [{ full: true, widthDeg: 360 }];
  approx(intrusionForSpec(123, full), 180);
});

test('computeMinViolationFallback: 最大侵入最小，内部交点优于边界', () => {
  // 规格 0 禁用 [8,205]，规格 1 禁用跨零 [200,360]∪[0,10]
  // 公共交集为空；重叠区 [200,205] 与 [8,10]
  // 交点 202.5° 处 max=2.5；9° 处 max=1 → 全局最优 9°
  const specs = [0, 1].map((i) => ({ index: i, circumference: 360, result: {} }));
  const sets = [
    [[8, 205]],
    [
      [200, 360],
      [0, 10],
    ],
  ];
  const fb = computeMinViolationFallback(specs, sets, { enabled: false }, {
    index: 1,
    blockingForbidden: [],
  });
  approx(fb.deg, 9);
  approx(fb.maxIntrusionDeg, 1);
  approx(fb.totalIntrusionDeg, 2);
  assert.deepEqual(
    fb.intrusions.map((x) => x.intrusionDeg),
    [1, 1]
  );
});

test('computeMinViolationFallback: 最大侵入并列时比总侵入，再并列取较小角度', () => {
  // 三段宽 140 的禁用弧依次重叠 20°（10–150 / 130–270 / 250→30 跨零）
  // 三处交点 20°/140°/260° 最大侵入均为 10°；总侵入均为 20° → 取 20°
  const specs = [0, 1, 2].map((i) => ({ index: i, circumference: 360, result: {} }));
  const sets = [
    [[10, 150]],
    [[130, 270]],
    [
      [250, 360],
      [0, 30],
    ],
  ];
  const fb = computeMinViolationFallback(specs, sets, { enabled: false }, {
    index: 2,
    blockingForbidden: [],
  });
  approx(fb.deg, 20);
  approx(fb.maxIntrusionDeg, 10);
  approx(fb.totalIntrusionDeg, 20);
});

test('computeMinViolationFallback: 启用档位时只在档位角度中求解', () => {
  const specs = [0, 1].map((i) => ({ index: i, circumference: 360, result: {} }));
  const sets = [
    [[8, 205]],
    [
      [200, 360],
      [0, 10],
    ],
  ];
  // 10° 网格：10° 档处侵入 [2,0]（连续最优 9° 不可选）
  const fb = computeMinViolationFallback(specs, sets, {
    enabled: true,
    steps: 36,
    offsetDeg: 0,
  }, { index: 1, blockingForbidden: [] });
  approx(fb.deg, 10);
  assert.equal(fb.detentIndex, 1);
  approx(fb.maxIntrusionDeg, 2);
  // 偏移使某档恰好落在 9°
  const fb2 = computeMinViolationFallback(specs, sets, {
    enabled: true,
    steps: 40,
    offsetDeg: 9,
  }, { index: 1, blockingForbidden: [] });
  approx(fb2.deg, 9);
  approx(fb2.maxIntrusionDeg, 1);
});

test('computeMultiSpec: 无共同解时返回 fallback；有共同解时 fallback=null', () => {
  const r = computeMultiSpec(
    [360, 180],
    0,
    [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ]
  );
  assert.equal(r.noSolution, true);
  assert.ok(r.fallback);
  assert.equal(typeof r.fallback.deg, 'number');
  assert.equal(r.fallback.intrusions.length, 2);
  // 规格 2 整圈禁用 → 该规格侵入恒为 180°
  approx(r.fallback.intrusions[1].intrusionDeg, 180);
  assert.match(r.fallback.reason, /覆盖整圈/);
  // 各规格侵入明细带规格序号、周长与接缝毫米位置
  for (const x of r.fallback.intrusions) {
    assert.equal(typeof x.mm, 'number');
    assert.equal(typeof x.circumference, 'number');
  }

  const ok = computeMultiSpec([400, 200], 20, [{ start: 60, end: 120 }]);
  assert.equal(ok.noSolution, false);
  assert.equal(ok.fallback, null);
});

test('computeMultiSpec + 档位：无共同解时 fallback 仅取档位角度并带 detentIndex', () => {
  const r = computeMultiSpec(
    [360, 180],
    0,
    [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ],
    { enabled: true, steps: 12, offsetDeg: 0 }
  );
  assert.equal(r.noSolution, true);
  assert.ok(r.fallback);
  assert.ok(Number.isInteger(r.fallback.detentIndex));
  // 备选角度必须是档位之一
  const k = r.fallback.detentIndex;
  approx(r.fallback.deg, (k * 360) / 12);
  assert.match(r.fallback.reason, /档位/);
});
