'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeBatchPlan,
  buildChange,
  MIN_ORDERS,
  MAX_ORDERS,
  BATCH_MIN_STEPS,
  BATCH_MAX_STEPS,
} = require('../src/batchPlan');

const det = (steps = 12, offsetDeg = 0) => ({ enabled: true, steps, offsetDeg });

test('入参校验：工单数量 2～8、档位 2～72、必须启用档位', () => {
  const one = [{ circumference: 360, seamWidth: 0, zones: [] }];
  assert.throws(() => computeBatchPlan(one, det(12), 0), /2～8/);
  const nine = Array.from({ length: 9 }, () => one[0]);
  assert.throws(() => computeBatchPlan(nine, det(12), 0), /2～8/);

  assert.throws(() => computeBatchPlan([one[0], one[0]], { enabled: false, steps: 12 }, 0), /启用/);
  assert.throws(() => computeBatchPlan([one[0], one[0]], det(1), 0), /2～72/);
  assert.throws(() => computeBatchPlan([one[0], one[0]], det(73), 0), /2～72/);
  assert.equal(BATCH_MIN_STEPS, 2);
  assert.equal(BATCH_MAX_STEPS, 72);
  assert.equal(MIN_ORDERS, 2);
  assert.equal(MAX_ORDERS, 8);
});

test('基本计划：全部工单整圈安全时，全部停在最接近初始角度的同一档位', () => {
  const orders = [
    { circumference: 400, seamWidth: 0, zones: [] },
    { circumference: 360, seamWidth: 0, zones: [] },
  ];
  const r = computeBatchPlan(orders, det(12), 350);
  assert.equal(r.feasible, true);
  assert.equal(r.failure, null);
  // 初始 350° 距档位 0° 为 10°（最近），之后同档位换版 0°
  assert.deepEqual(r.plan.detentSequence, [0, 0]);
  assert.equal(Math.round(r.totalRotationDeg), 10);
  assert.equal(r.plan.changes[0].direction, 'cw');
  assert.equal(r.plan.changes[1].samePoint, true);
  assert.equal(Math.round(r.plan.changes[1].sweepDeg), 0);
  assert.equal(r.orders.length, 2);
});

test('总成本 = 初始角到首单 + 相邻单停机档位的圆周最短角距离之和', () => {
  const orders = [
    // 首单仅留可用档位 90°（索引 3）：禁用覆盖其余
    { circumference: 360, seamWidth: 0, zones: [{ start: 100, end: 80 }] },
    // 次单仅留可用档位 270°（索引 9）
    { circumference: 360, seamWidth: 0, zones: [{ start: 280, end: 260 }] },
  ];
  const r = computeBatchPlan(orders, det(12), 0);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.plan.detentSequence, [3, 9]);
  // 0→90 = 90；90→270 = 180（取顺时针）；总 270
  assert.equal(Math.round(r.totalRotationDeg), 270);
  assert.equal(Math.round(r.plan.changes[0].sweepDeg), 90);
  assert.equal(Math.round(r.plan.changes[1].sweepDeg), 180);
  assert.equal(r.plan.changes[1].direction, 'cw');
});

test('并列成本：取档位序号字典序最小；180° 等距取顺时针', () => {
  // 两单均整圈安全：初始 180° 距档位 6(180°) 为 0，全选索引 6
  const orders = [
    { circumference: 360, seamWidth: 0, zones: [] },
    { circumference: 360, seamWidth: 0, zones: [] },
  ];
  const r = computeBatchPlan(orders, det(12), 180);
  assert.deepEqual(r.plan.detentSequence, [6, 6]);

  // 初始 0°、两单整圈安全：所有档位到 0 的距离 d(k)=min(30k,360-30k)，
  // 最近为索引 0（距离 0），唯一最优
  const r0 = computeBatchPlan(orders, det(12), 0);
  assert.deepEqual(r0.plan.detentSequence, [0, 0]);

  // buildChange：180° 等距时顺时针
  const c = buildChange(0, 180);
  assert.equal(c.direction, 'cw');
  assert.equal(c.sweepDeg, 180);
  const c2 = buildChange(0, 0);
  assert.equal(c2.samePoint, true);
  assert.equal(c2.sweepDeg, 0);
});

test('字典序平局：构造首单与次单各自有两个等距候选，选较小序号序列', () => {
  // 8 档（每 45°），初始 22.5°：到档位 0(0°) 与 1(45°) 距离均为 22.5°
  // 两单整圈安全 → 最优序列为 [0,0]（总 22.5），而非 [1,...]
  const orders = [
    { circumference: 360, seamWidth: 0, zones: [] },
    { circumference: 360, seamWidth: 0, zones: [] },
  ];
  const r = computeBatchPlan(orders, det(8), 22.5);
  assert.deepEqual(r.plan.detentSequence, [0, 0]);
  assert.equal(Math.round(r.totalRotationDeg * 10) / 10, 22.5);
});

test('失败区分：首个失败工单 + 整圈无解 / 有安全段但无档位', () => {
  // 首单整圈禁用
  const full = computeBatchPlan(
    [
      { circumference: 360, seamWidth: 0, zones: [{ start: 0, end: 180 }, { start: 180, end: 360 }] },
      { circumference: 360, seamWidth: 0, zones: [] },
    ],
    det(12), 0
  );
  assert.equal(full.feasible, false);
  assert.equal(full.plan, null);
  assert.equal(full.totalRotationDeg, null);
  assert.equal(full.failure.index, 0);
  assert.equal(full.failure.type, 'full-circle-no-solution');
  assert.equal(full.failure.fullCircleNoSolution, true);
  assert.equal(full.failure.detentsNoneAvailable, false);

  // 首单可行，次单安全段 (10°,20°) 内无 12 档（0° 偏移，档位为 30° 倍数）
  const none = computeBatchPlan(
    [
      { circumference: 360, seamWidth: 0, zones: [] },
      { circumference: 360, seamWidth: 0, zones: [{ start: 0, end: 10 }, { start: 20, end: 360 }] },
    ],
    det(12), 0
  );
  assert.equal(none.feasible, false);
  assert.equal(none.failure.index, 1);
  assert.equal(none.failure.type, 'detents-none-available');
  assert.equal(none.failure.fullCircleNoSolution, false);
  assert.equal(none.failure.detentsNoneAvailable, true);
  // 失败响应仍带全部工单结果与共用档位
  assert.equal(none.orders.length, 2);
  assert.equal(none.detents.steps, 12);
});

test('初始角度缺省为 0，任意数值按整圈归一；各单周长独立换算 mm', () => {
  const r = computeBatchPlan(
    [
      { circumference: 400, seamWidth: 0, zones: [] },
      { circumference: 500, seamWidth: 0, zones: [] },
    ],
    det(12)
  );
  assert.equal(r.initialDeg, 0);
  assert.equal(r.plan.stops[0].mm, 0);
  assert.equal(r.plan.stops[1].mm, 0);

  const r2 = computeBatchPlan(
    [
      { circumference: 400, seamWidth: 0, zones: [] },
      { circumference: 500, seamWidth: 0, zones: [] },
    ],
    det(12), 370
  );
  assert.equal(Math.round(r2.initialDeg * 10) / 10, 10);
  // 同档位 0° 在两个周长下 mm 均为 0
  assert.equal(r2.plan.stops[0].mm, 0);
  assert.equal(r2.plan.stops[1].mm, 0);
});
