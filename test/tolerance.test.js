'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTolerance,
  computeReliableArcs,
  degInReliable,
} = require('../src/tolerance');
const { computeSeamAvoidance } = require('../src/seamMath');
const { computeMultiSpec } = require('../src/multiSpec');
const { app } = require('../server');

function approx(actual, expected, eps = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !≈ ${expected}`);
}

/* ---------------- parseTolerance ---------------- */

test('parseTolerance: 未传/null/false → 禁用；合法对象 → 启用', () => {
  for (const v of [undefined, null, false]) {
    assert.deepEqual(parseTolerance(v), { enabled: false });
  }
  assert.deepEqual(parseTolerance({ ccwDeg: 0, cwDeg: 0 }), {
    enabled: true,
    ccwDeg: 0,
    cwDeg: 0,
  });
  assert.deepEqual(parseTolerance({ ccwDeg: 2.5, cwDeg: 3 }), {
    enabled: true,
    ccwDeg: 2.5,
    cwDeg: 3,
  });
});

test('parseTolerance: 非对象/缺失/负数/非有限数 → 抛错', () => {
  for (const bad of [
    'on',
    42,
    [],
    {},
    { ccwDeg: 1 },
    { cwDeg: 1 },
    { ccwDeg: -1, cwDeg: 0 },
    { ccwDeg: 0, cwDeg: -0.5 },
    { ccwDeg: NaN, cwDeg: 0 },
    { ccwDeg: 0, cwDeg: Infinity },
    { ccwDeg: '2', cwDeg: 0 },
  ]) {
    assert.throws(() => parseTolerance(bad), undefined, JSON.stringify(bad));
  }
});

/* ---------------- computeReliableArcs ---------------- */

test('computeReliableArcs: 安全弧按两侧误差收缩', () => {
  // [100,200] 宽 100，ccw=10、cw=20 → [110,180] 宽 70
  const r = computeReliableArcs(
    [{ startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 }],
    10,
    20
  );
  assert.equal(r.empty, false);
  assert.equal(r.arcs.length, 1);
  approx(r.arcs[0].startDeg, 110);
  approx(r.arcs[0].endDeg, 180);
  approx(r.arcs[0].widthDeg, 70);
  assert.equal(r.arcs[0].wraps, false);
});

test('computeReliableArcs: 跨零安全弧收缩后仍跨零；零误差不改变安全段', () => {
  const wrap = [{ startDeg: 350, endDeg: 10, wraps: true, widthDeg: 20 }];
  const r = computeReliableArcs(wrap, 5, 5);
  assert.equal(r.arcs.length, 1);
  approx(r.arcs[0].startDeg, 355);
  approx(r.arcs[0].endDeg, 5);
  assert.equal(r.arcs[0].wraps, true);
  approx(r.arcs[0].widthDeg, 10);

  // 零误差：可靠段即安全段（跨零保持）
  const same = computeReliableArcs(wrap, 0, 0);
  assert.equal(same.arcs.length, 1);
  approx(same.arcs[0].startDeg, 350);
  approx(same.arcs[0].endDeg, 10);
  assert.equal(same.arcs[0].wraps, true);
  approx(same.arcs[0].widthDeg, 20);
});

test('computeReliableArcs: 逆时针误差较大时可靠段整体越过零点', () => {
  // 跨零弧 350→10 宽 20，ccw=15、cw=2 → [365, 368] ≡ [5, 8]，不跨零
  const r = computeReliableArcs(
    [{ startDeg: 350, endDeg: 10, wraps: true, widthDeg: 20 }],
    15,
    2
  );
  assert.equal(r.arcs.length, 1);
  approx(r.arcs[0].startDeg, 5);
  approx(r.arcs[0].endDeg, 8);
  assert.equal(r.arcs[0].wraps, false);
});

test('computeReliableArcs: 收缩后仅剩一个点', () => {
  // 宽 100，T=100 → 单点 θ = 100+30 = 130
  const r = computeReliableArcs(
    [{ startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 }],
    30,
    70
  );
  assert.equal(r.empty, false);
  assert.equal(r.arcs.length, 1);
  assert.equal(r.arcs[0].point, true);
  approx(r.arcs[0].startDeg, 130);
  approx(r.arcs[0].endDeg, 130);
  approx(r.arcs[0].widthDeg, 0);
  // 单点恰在零点
  const atZero = computeReliableArcs(
    [{ startDeg: 350, endDeg: 10, wraps: true, widthDeg: 20 }],
    10,
    10
  );
  assert.equal(atZero.arcs.length, 1);
  assert.equal(atZero.arcs[0].point, true);
  approx(atZero.arcs[0].startDeg, 0);
});

test('computeReliableArcs: 收缩后为空与无安全段', () => {
  const r = computeReliableArcs(
    [{ startDeg: 100, endDeg: 150, wraps: false, widthDeg: 50 }],
    30,
    30
  );
  assert.equal(r.empty, true);
  assert.deepEqual(r.arcs, []);
  assert.equal(computeReliableArcs([], 5, 5).empty, true);
});

test('computeReliableArcs: 整圈安全任意误差均可靠；误差总宽≥360° 仅整圈安全有解', () => {
  const full = [{ startDeg: 0, endDeg: 0, wraps: false, widthDeg: 360, full: true }];
  // 整圈安全 + 误差总宽 400° → 仍整圈可靠
  const r = computeReliableArcs(full, 200, 200);
  assert.equal(r.full, true);
  assert.equal(r.empty, false);
  assert.equal(r.arcs[0].full, true);

  // 非整圈安全 + 误差总宽恰 360° → 空
  const nonFull = [{ startDeg: 10, endDeg: 20, wraps: false, widthDeg: 10 }];
  assert.equal(computeReliableArcs(nonFull, 180, 180).empty, true);
  assert.equal(computeReliableArcs(nonFull, 0, 360).empty, true);
  assert.equal(computeReliableArcs(nonFull, 200, 200).empty, true);
});

test('computeReliableArcs: 多条安全弧分别收缩，结束在 360° 的弧保持边界表示', () => {
  const r = computeReliableArcs(
    [
      { startDeg: 90, endDeg: 360, wraps: false, widthDeg: 270 },
      { startDeg: 30, endDeg: 60, wraps: false, widthDeg: 30 },
    ],
    10,
    10
  );
  assert.equal(r.arcs.length, 2);
  // 按起点排序：[40,50] 与 [100,350]
  approx(r.arcs[0].startDeg, 40);
  approx(r.arcs[0].endDeg, 50);
  approx(r.arcs[1].startDeg, 100);
  approx(r.arcs[1].endDeg, 350);
});

/* ---------------- degInReliable ---------------- */

test('degInReliable: 弧内/边界/弧外/单点/整圈', () => {
  const arcs = [
    { startDeg: 100, endDeg: 200, wraps: false, widthDeg: 100 },
    { startDeg: 300, endDeg: 300, wraps: false, widthDeg: 0, point: true },
  ];
  assert.equal(degInReliable(arcs, 150), true);
  assert.equal(degInReliable(arcs, 100), true); // 含边界
  assert.equal(degInReliable(arcs, 200), true);
  assert.equal(degInReliable(arcs, 250), false);
  assert.equal(degInReliable(arcs, 300), true); // 单点命中
  assert.equal(degInReliable(arcs, 301), false);
  assert.equal(degInReliable(arcs, 460), true); // 任意数值按整圈归一（460≡100）
  assert.equal(degInReliable([{ full: true, widthDeg: 360 }], 77), true);
  assert.equal(degInReliable([], 77), false);
});

/* ---------------- 单规格集成 ---------------- */

test('单规格：tolerance 基于可行段输出可靠段（跨零、mm 换算）', () => {
  // C=360、W=0、保护区 [90,180] → 可行跨零弧 180°→90° 宽 270°
  // ±30° → 可靠 210°→60° 宽 210°
  const r = computeSeamAvoidance(360, 0, [{ start: 90, end: 180 }], undefined, undefined, {
    ccwDeg: 30,
    cwDeg: 30,
  });
  assert.ok(r.tolerance);
  assert.equal(r.tolerance.ccwDeg, 30);
  assert.equal(r.tolerance.cwDeg, 30);
  approx(r.tolerance.totalDeg, 60);
  assert.equal(r.tolerance.empty, false);
  assert.equal(r.tolerance.arcs.length, 1);
  const a = r.tolerance.arcs[0];
  approx(a.startDeg, 210);
  approx(a.endDeg, 60);
  assert.equal(a.wraps, true);
  approx(a.widthDeg, 210);
  approx(a.startMm, 210); // C=360 时 1° = 1mm
  approx(a.endMm, 60);
  // 未启用档位 → detents 为 null
  assert.equal(r.tolerance.detents, null);
});

test('单规格：未传 tolerance 时响应不含 tolerance 字段', () => {
  const r = computeSeamAvoidance(360, 0, [{ start: 90, end: 180 }]);
  assert.equal('tolerance' in r, false);
  const r2 = computeSeamAvoidance(360, 0, [{ start: 90, end: 180 }], undefined, null, null);
  assert.equal('tolerance' in r2, false);
});

test('单规格：无解（保护区覆盖整圈）时可靠段为空', () => {
  const r = computeSeamAvoidance(
    400,
    50,
    [
      { start: 0, end: 180 },
      { start: 150, end: 400 },
    ],
    undefined,
    undefined,
    { ccwDeg: 5, cwDeg: 5 }
  );
  assert.equal(r.noSolution, true);
  assert.equal(r.tolerance.empty, true);
  assert.deepEqual(r.tolerance.arcs, []);
});

test('单规格：启用档位时列出落在可靠段内的全部档位', () => {
  // 可靠段 210°→60°（跨零，宽 210°）；12 档（每 30°）落在内：0,30,60,210,240,270,300,330
  const r = computeSeamAvoidance(
    360,
    0,
    [{ start: 90, end: 180 }],
    { enabled: true, steps: 12 },
    undefined,
    { ccwDeg: 30, cwDeg: 30 }
  );
  assert.ok(r.tolerance.detents);
  assert.equal(r.tolerance.detents.noAvailable, false);
  assert.deepEqual(
    r.tolerance.detents.available.map((d) => d.deg),
    [0, 30, 60, 210, 240, 270, 300, 330]
  );
  // 可用档位结构与 detents.available 一致（含 mm 与 gapDeg）
  for (const d of r.tolerance.detents.available) {
    assert.equal(typeof d.mm, 'number');
    assert.equal(typeof d.gapDeg, 'number');
  }
});

test('单规格：区分“可靠段为空”与“有段无档位”', () => {
  // 有段无档位：可靠段 [180,181] 宽 1°，档位 15+30k 均不在内
  const segNoDetent = computeSeamAvoidance(
    360,
    0,
    [{ start: 90, end: 180 }],
    { enabled: true, steps: 12, offsetDeg: 15 },
    undefined,
    { ccwDeg: 0, cwDeg: 269 }
  );
  assert.equal(segNoDetent.tolerance.empty, false);
  assert.equal(segNoDetent.tolerance.detents.available.length, 0);
  assert.equal(segNoDetent.tolerance.detents.noAvailable, true);

  // 可靠段为空：noAvailable 保持 false（与“有段无档位”区分）
  const empty = computeSeamAvoidance(
    360,
    0,
    [{ start: 90, end: 180 }],
    { enabled: true, steps: 12 },
    undefined,
    { ccwDeg: 200, cwDeg: 200 }
  );
  assert.equal(empty.tolerance.empty, true);
  assert.equal(empty.tolerance.detents.available.length, 0);
  assert.equal(empty.tolerance.detents.noAvailable, false);
});

test('单规格：误差总宽≥360° 时仅整圈安全有解', () => {
  // 非整圈安全 + T=360 → 空
  const nonFull = computeSeamAvoidance(360, 0, [{ start: 90, end: 180 }], undefined, undefined, {
    ccwDeg: 180,
    cwDeg: 180,
  });
  assert.equal(nonFull.tolerance.empty, true);
  // 整圈安全（无保护区）+ T=400 → 整圈可靠
  const full = computeSeamAvoidance(360, 0, [], undefined, undefined, {
    ccwDeg: 200,
    cwDeg: 200,
  });
  assert.equal(full.tolerance.full, true);
  assert.equal(full.tolerance.empty, false);
  assert.equal(full.tolerance.arcs[0].full, true);
});

/* ---------------- 多规格集成 ---------------- */

test('多规格：tolerance 基于共用安全段收缩', () => {
  // 共用段 216°→36°（跨零，宽 180°）；±30° → 246°→6° 宽 120°
  const r = computeMultiSpec([400, 200], 20, [{ start: 60, end: 120 }], undefined, undefined, {
    ccwDeg: 30,
    cwDeg: 30,
  });
  assert.ok(r.tolerance);
  assert.equal(r.tolerance.empty, false);
  assert.equal(r.tolerance.arcs.length, 1);
  approx(r.tolerance.arcs[0].startDeg, 246);
  approx(r.tolerance.arcs[0].endDeg, 6);
  assert.equal(r.tolerance.arcs[0].wraps, true);
  approx(r.tolerance.arcs[0].widthDeg, 120);
  assert.equal(r.tolerance.detents, null);

  // 未传 tolerance → 无该字段
  const plain = computeMultiSpec([400, 200], 20, [{ start: 60, end: 120 }]);
  assert.equal('tolerance' in plain, false);
});

test('多规格：无共同解时可靠段为空；整圈共用安全时可靠段为整圈', () => {
  const noSol = computeMultiSpec(
    [360, 180],
    0,
    [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ],
    undefined,
    undefined,
    { ccwDeg: 5, cwDeg: 5 }
  );
  assert.equal(noSol.noSolution, true);
  assert.equal(noSol.tolerance.empty, true);

  const full = computeMultiSpec([400, 200], 0, [], undefined, undefined, {
    ccwDeg: 10,
    cwDeg: 10,
  });
  assert.equal(full.fullCircle, true);
  assert.equal(full.tolerance.full, true);
  assert.equal(full.tolerance.arcs[0].full, true);
});

test('多规格：启用档位时列出落在可靠段内的档位并区分有段无档位', () => {
  // 共用段 216°→36° ±30° → 可靠 246°→6°；8 档（每 45°）：0,45,90,...,315
  // 落在内：0, 270, 315（246≤270,315≤366；0≤6+360）
  const r = computeMultiSpec(
    [400, 200],
    20,
    [{ start: 60, end: 120 }],
    { enabled: true, steps: 8 },
    undefined,
    { ccwDeg: 30, cwDeg: 30 }
  );
  assert.ok(r.tolerance.detents);
  assert.deepEqual(
    r.tolerance.detents.available.map((d) => d.deg),
    [0, 270, 315]
  );
  assert.equal(r.tolerance.detents.noAvailable, false);
  // 可用档位带逐规格间隙
  for (const d of r.tolerance.detents.available) {
    assert.equal(d.gaps.length, 2);
  }

  // 有段无档位：可靠段缩至极窄且避开档位
  const none = computeMultiSpec(
    [400, 200],
    20,
    [{ start: 60, end: 120 }],
    { enabled: true, steps: 8, offsetDeg: 22.5 },
    undefined,
    { ccwDeg: 89.5, cwDeg: 89.5 }
  );
  // 可靠段宽 180-179=1°，位于 [216+89.5, 36+360-89.5] = [305.5, 306.5]，档位 22.5+45k 不在内
  assert.equal(none.tolerance.empty, false);
  assert.equal(none.tolerance.detents.available.length, 0);
  assert.equal(none.tolerance.detents.noAvailable, true);
});

/* ---------------- API ---------------- */

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postJson(p, body) {
  const res = await fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

const baseSingle = { circumference: 360, seamWidth: 0, zones: [{ start: 90, end: 180 }] };
const baseMulti = { circumferences: [400, 200], seamWidth: 20, zones: [{ start: 60, end: 120 }] };

test('API 单规格：合法 tolerance 返回分析；未传时响应保持原样', async () => {
  const withTol = await postJson('/api/compute', {
    ...baseSingle,
    tolerance: { ccwDeg: 30, cwDeg: 30 },
  });
  assert.equal(withTol.status, 200);
  assert.ok(withTol.json.tolerance);
  assert.equal(withTol.json.tolerance.empty, false);
  assert.equal(withTol.json.tolerance.arcs.length, 1);

  const plain = await postJson('/api/compute', baseSingle);
  assert.equal(plain.status, 200);
  assert.equal('tolerance' in plain.json, false);
});

test('API 单规格：非法 tolerance → 400', async () => {
  for (const bad of [
    'on',
    42,
    [],
    {},
    { ccwDeg: 1 },
    { ccwDeg: -1, cwDeg: 0 },
    { ccwDeg: 0, cwDeg: -3 },
    { ccwDeg: NaN, cwDeg: 0 },
    { ccwDeg: 0, cwDeg: Infinity },
    { ccwDeg: '2', cwDeg: 0 },
  ]) {
    const r = await postJson('/api/compute', { ...baseSingle, tolerance: bad });
    assert.equal(r.status, 400, `tolerance=${JSON.stringify(bad)} 应 400`);
    assert.match(r.json.error, /tolerance/);
  }
});

test('API 多规格：合法 tolerance 返回分析；非法 → 400；未传时响应保持原样', async () => {
  const ok = await postJson('/api/compute-multi', {
    ...baseMulti,
    tolerance: { ccwDeg: 30, cwDeg: 30 },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.tolerance);
  assert.equal(ok.json.tolerance.empty, false);

  const plain = await postJson('/api/compute-multi', baseMulti);
  assert.equal(plain.status, 200);
  assert.equal('tolerance' in plain.json, false);

  for (const bad of [{ ccwDeg: -1, cwDeg: 0 }, { cwDeg: 'x', ccwDeg: 0 }, 'on', {}]) {
    const r = await postJson('/api/compute-multi', { ...baseMulti, tolerance: bad });
    assert.equal(r.status, 400, `tolerance=${JSON.stringify(bad)} 应 400`);
    assert.match(r.json.error, /tolerance/);
  }
});

test('API：tolerance 与 detents 同时启用时返回可靠档位列表', async () => {
  const r = await postJson('/api/compute', {
    ...baseSingle,
    detents: { enabled: true, steps: 12 },
    tolerance: { ccwDeg: 30, cwDeg: 30 },
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.tolerance.detents);
  assert.deepEqual(
    r.json.tolerance.detents.available.map((d) => d.deg),
    [0, 30, 60, 210, 240, 270, 300, 330]
  );

  const m = await postJson('/api/compute-multi', {
    ...baseMulti,
    detents: { enabled: true, steps: 8 },
    tolerance: { ccwDeg: 30, cwDeg: 30 },
  });
  assert.equal(m.status, 200);
  assert.deepEqual(
    m.json.tolerance.detents.available.map((d) => d.deg),
    [0, 270, 315]
  );
});
