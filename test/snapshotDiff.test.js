'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSeamAvoidance } = require('../src/seamMath');
const {
  normalizeDegSegments,
  signedDegDelta,
  compareSets,
  diffSnapshots,
} = require('../src/snapshotDiff');

function degSegs(segs) {
  return normalizeDegSegments(segs).segs;
}

function makeSnap(name, C, W, zones) {
  return {
    id: name,
    name,
    createdAt: '2026-09-20T00:00:00.000Z',
    input: { circumference: C, seamWidth: W, zones },
    result: computeSeamAvoidance(C, W, zones),
  };
}

test('normalizeDegSegments: 跨零点段拆到 [0,360]', () => {
  // 起始 315° 宽 90°（跨零点）
  assert.deepEqual(degSegs([{ startDeg: 315, endDeg: 45, wraps: true }]), [
    [0, 45],
    [315, 360],
  ]);
});

test('normalizeDegSegments: 整圈识别', () => {
  const realFull = normalizeDegSegments([{ startDeg: 0, endDeg: 0, widthDeg: 360 }]);
  assert.equal(realFull.full, true);
  assert.deepEqual(realFull.segs, [[0, 360]]);
  // 零长度段忽略
  const empty = normalizeDegSegments([{ startDeg: 10, endDeg: 10 }]);
  assert.equal(empty.full, false);
  assert.deepEqual(empty.segs, []);
});

test('signedDegDelta: 取最短圆弧有向位移', () => {
  assert.equal(signedDegDelta(10, 20), 10);
  assert.equal(signedDegDelta(10, 350), -20);
  assert.equal(signedDegDelta(350, 10), 20);
});

test('compareSets: 完全相同 → 无差异', () => {
  const A = normalizeDegSegments([{ startDeg: 30, endDeg: 90 }]);
  const d = compareSets(A, A);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.moves, []);
  assert.deepEqual(d.common, [[30, 90]]);
});

test('compareSets: 纯新增与纯移除', () => {
  const A = normalizeDegSegments([{ startDeg: 30, endDeg: 90 }]);
  const B = normalizeDegSegments([{ startDeg: 30, endDeg: 150 }]);
  const d = compareSets(A, B);
  assert.deepEqual(d.added, [[90, 150]]);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.common, [[30, 90]]);

  const d2 = compareSets(B, A);
  assert.deepEqual(d2.added, []);
  assert.deepEqual(d2.removed, [[90, 150]]);
});

test('compareSets: 重叠段边界移动（端点位移按最短圆弧）', () => {
  const A = normalizeDegSegments([{ startDeg: 40, endDeg: 120 }]);
  const B = normalizeDegSegments([{ startDeg: 50, endDeg: 110 }]);
  const d = compareSets(A, B);
  assert.equal(d.moves.length, 1);
  assert.equal(d.moves[0].startDelta, 10);
  assert.equal(d.moves[0].endDelta, -10);
  // B 在两侧收缩：两部分都是移除
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, [
    [40, 50],
    [110, 120],
  ]);
});

test('compareSets: 跨零点段在零点两侧的边界移动按片段配对', () => {
  const A = normalizeDegSegments([{ startDeg: 350, endDeg: 10, wraps: true }]);
  const B = normalizeDegSegments([{ startDeg: 355, endDeg: 5, wraps: true }]);
  const d = compareSets(A, B);
  // [350,360] 与 [0,10] 分别配对
  assert.equal(d.moves.length, 2);
  const startMove = d.moves.find((m) => m.aSeg[0] === 350);
  const endMove = d.moves.find((m) => m.aSeg[1] === 10);
  assert.equal(startMove.startDelta, 5);
  assert.equal(startMove.endDelta, null);
  assert.equal(endMove.startDelta, null);
  assert.equal(endMove.endDelta, -5);
});

test('compareSets: 无配对关系判为新增/移除', () => {
  const A = normalizeDegSegments([{ startDeg: 0, endDeg: 60 }]);
  const B = normalizeDegSegments([{ startDeg: 180, endDeg: 240 }]);
  const d = compareSets(A, B);
  assert.deepEqual(d.added, [[180, 240]]);
  assert.deepEqual(d.removed, [[0, 60]]);
  assert.deepEqual(d.moves, []);
});

test('compareSets: 整圈与空集互判', () => {
  const full = normalizeDegSegments([{ startDeg: 0, endDeg: 360 }]);
  const empty = normalizeDegSegments([]);
  const d = compareSets(empty, full);
  assert.deepEqual(d.added, [[0, 360]]);
  assert.deepEqual(d.removed, []);
  const d2 = compareSets(full, empty);
  assert.deepEqual(d2.added, []);
  assert.deepEqual(d2.removed, [[0, 360]]);
});

test('diffSnapshots: 相同方案各类差异均为空', () => {
  const s = makeSnap('s', 400, 20, [
    { start: 60, end: 120 },
    { start: 200, end: 260 },
  ]);
  const d = diffSnapshots(s, s);
  for (const key of ['zones', 'forbidden', 'feasible']) {
    assert.deepEqual(d[key].added, [], key);
    assert.deepEqual(d[key].removed, [], key);
    assert.deepEqual(d[key].moves, [], key);
  }
  assert.equal(d.a.circumference, 400);
  assert.equal(d.b.seamWidth, 20);
});

test('diffSnapshots: 接缝加宽使禁用段扩张、可行段收缩', () => {
  // C=400：保护区 [60,120]mm = 54°–108°
  const a = makeSnap('a', 400, 20, [{ start: 60, end: 120 }]); // 禁用 36°–108°
  const b = makeSnap('b', 400, 40, [{ start: 60, end: 120 }]); // 禁用 18°–108°
  const d = diffSnapshots(a, b);
  // 保护区不变
  assert.deepEqual(d.zones.added, []);
  assert.deepEqual(d.zones.removed, []);
  // 禁用段向左扩张 18°：新增 [18,36]
  assert.deepEqual(d.forbidden.added, [[18, 36]]);
  // 可行段边界移动记录存在
  assert.ok(d.feasible.moves.length >= 1);
});

test('diffSnapshots: 完全不同的保护区判为新增与移除', () => {
  const a = makeSnap('a', 400, 0, [{ start: 0, end: 100 }]); // 0°–90°
  const b = makeSnap('b', 400, 0, [{ start: 200, end: 300 }]); // 180°–270°
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.zones.added, [[180, 270]]);
  assert.deepEqual(d.zones.removed, [[0, 90]]);
  assert.deepEqual(d.zones.moves, []);
});

test('diffSnapshots: 周长不同也可按角度比较', () => {
  const a = makeSnap('a', 400, 0, [{ start: 0, end: 100 }]); // 0°–90°
  const b = makeSnap('b', 800, 0, [{ start: 0, end: 200 }]); // 同样 0°–90°
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.zones.added, []);
  assert.deepEqual(d.zones.removed, []);
  assert.equal(d.a.circumference, 400);
  assert.equal(d.b.circumference, 800);
});

test('diffSnapshots: 无解快照（无可行段）与有解快照互比', () => {
  const a = makeSnap('a', 400, 50, [
    { start: 0, end: 180 },
    { start: 150, end: 400 },
  ]);
  const b = makeSnap('b', 400, 20, [{ start: 60, end: 120 }]);
  assert.equal(a.result.noSolution, true);
  const d = diffSnapshots(a, b);
  // A 可行为空、B 有可行（禁用 36°–108°）→ 新增的可行段为禁用之外的整圈余部
  assert.deepEqual(d.feasible.added, [
    [0, 36],
    [108, 360],
  ]);
  assert.deepEqual(d.feasible.removed, []);
});
