'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
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

const baseSingle = { circumference: 400, seamWidth: 20, zones: [{ start: 60, end: 120 }] };
const baseMulti = {
  circumferences: [400, 200],
  seamWidth: 20,
  zones: [{ start: 60, end: 120 }],
};

test('GET /api/health 正常', async () => {
  const res = await fetch(baseUrl + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('单规格：缺省/禁用档位返回禁用结构且结果不变', async () => {
  const a = await postJson('/api/compute', baseSingle);
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.detents, { enabled: false });

  const b = await postJson('/api/compute', { ...baseSingle, detents: { enabled: false, steps: 3 } });
  assert.equal(b.status, 200);
  assert.equal(b.json.detents.enabled, false);
  assert.equal(b.json.best.mm, a.json.best.mm);
});

test('单规格：合法档位参数返回档位结果', async () => {
  const r = await postJson('/api/compute', {
    ...baseSingle,
    detents: { enabled: true, steps: 12, offsetDeg: 0 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.detents.enabled, true);
  assert.equal(r.json.detents.steps, 12);
  assert.ok(Array.isArray(r.json.detents.available));
  assert.ok(typeof r.json.best.detentIndex === 'number');
});

test('单规格：可行段结束在整圈边界时 endDeg=360 且不误报无可用档位', async () => {
  // 题设：周长 360、接缝宽 0、保护区 [0,90] → 安全段 90°→360°
  const r = await postJson('/api/compute', {
    circumference: 360,
    seamWidth: 0,
    zones: [{ start: 0, end: 90 }],
    detents: { enabled: true, steps: 12 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.noSolution, false);
  assert.equal(r.json.feasible.length, 1);
  assert.deepEqual(
    [r.json.feasible[0].startDeg, r.json.feasible[0].endDeg, r.json.feasible[0].wraps],
    [90, 360, false]
  );
  assert.equal(r.json.detents.noAvailable, false);
  assert.deepEqual(
    r.json.detents.available.map((d) => d.deg),
    [0, 90, 120, 150, 180, 210, 240, 270, 300, 330]
  );
  assert.equal(r.json.best.deg, 210);
});

test('单规格：steps 越界/非整数/非数字 → 400', async () => {
  for (const steps of [1, 361, 12.5, '12', NaN]) {
    const r = await postJson('/api/compute', {
      ...baseSingle,
      detents: { enabled: true, steps },
    });
    assert.equal(r.status, 400, `steps=${steps} 应 400`);
    assert.match(r.json.error, /steps/);
  }
});

test('单规格：offsetDeg 非数值 → 400；detents 非对象 → 400', async () => {
  const r1 = await postJson('/api/compute', {
    ...baseSingle,
    detents: { enabled: true, steps: 12, offsetDeg: 'x' },
  });
  assert.equal(r1.status, 400);
  assert.match(r1.json.error, /offsetDeg/);

  for (const bad of [null, [], 'on', 42]) {
    const r = await postJson('/api/compute', { ...baseSingle, detents: bad });
    assert.equal(r.status, 400, `detents=${JSON.stringify(bad)} 应 400`);
  }
});

test('单规格：偏移超出 ±360° 自动按整圈归一，不报错', async () => {
  const r = await postJson('/api/compute', {
    ...baseSingle,
    detents: { enabled: true, steps: 12, offsetDeg: 375 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.detents.offsetDeg, 15);
});

test('多规格：合法档位返回逐规格间隙；非法参数 → 400', async () => {
  const ok = await postJson('/api/compute-multi', {
    ...baseMulti,
    detents: { enabled: true, steps: 8 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.detents.enabled, true);
  for (const d of ok.json.detents.available) {
    assert.equal(d.gaps.length, 2);
  }

  const bad = await postJson('/api/compute-multi', {
    ...baseMulti,
    detents: { enabled: true, steps: 0 },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /steps/);

  const badType = await postJson('/api/compute-multi', {
    ...baseMulti,
    detents: 'yes',
  });
  assert.equal(badType.status, 400);
});

test('多规格：连续公共段有解但无可用档位时 noAvailable=true 且 best=null', async () => {
  const r = await postJson('/api/compute-multi', {
    circumferences: [360, 360],
    seamWidth: 0,
    zones: [
      { start: 0, end: 30 },
      { start: 40, end: 360 },
    ],
    detents: { enabled: true, steps: 12, offsetDeg: 15 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.noSolution, false);
  assert.equal(r.json.best, null);
  assert.equal(r.json.detents.noAvailable, true);
  assert.equal(r.json.detents.nearest.length, 1);
});

test('多规格：无共同解时返回最小违约备选 fallback（关闭/启用档位）', async () => {
  const body = {
    circumferences: [360, 180],
    seamWidth: 0,
    zones: [
      { start: 90, end: 180 },
      { start: 180, end: 360 },
    ],
  };
  const r = await postJson('/api/compute-multi', body);
  assert.equal(r.status, 200);
  assert.equal(r.json.noSolution, true);
  assert.equal(r.json.best, null);
  assert.ok(r.json.fallback);
  assert.equal(typeof r.json.fallback.deg, 'number');
  assert.equal(typeof r.json.fallback.maxIntrusionDeg, 'number');
  assert.equal(typeof r.json.fallback.totalIntrusionDeg, 'number');
  assert.equal(r.json.fallback.intrusions.length, 2);
  assert.equal(typeof r.json.fallback.reason, 'string');
  assert.equal(r.json.fallback.detentIndex, null);
  assert.equal(r.json.fallback.positions, null);
  // 有共同解时不返回 fallback
  const ok = await postJson('/api/compute-multi', baseMulti);
  assert.equal(ok.json.fallback, null);

  const rd = await postJson('/api/compute-multi', {
    ...body,
    detents: { enabled: true, steps: 8, offsetDeg: 0 },
  });
  assert.equal(rd.status, 200);
  assert.equal(rd.json.noSolution, true);
  assert.ok(Number.isInteger(rd.json.fallback.detentIndex));
  // 备选角度必须在档位集合中
  assert.ok(
    rd.json.detents.positions.some((d) => Math.abs(d - rd.json.fallback.deg) < 1e-9)
  );
  assert.match(rd.json.fallback.reason, /档位/);
});

/* ---------------- 调机旋转路径 route ---------------- */

test('单规格：route 返回路径规划结果；缺省 route 时为 null', async () => {
  const r = await postJson('/api/compute', {
    circumference: 360,
    seamWidth: 0,
    zones: [{ start: 90, end: 180 }],
    route: { fromDeg: 300, toDeg: 30 },
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.route);
  assert.equal(r.json.route.status, 'ok');
  assert.equal(r.json.route.best.direction, 'cw');
  assert.equal(Math.round(r.json.route.best.sweepDeg), 90);
  assert.equal(r.json.route.from.safe, true);
  assert.equal(r.json.route.to.safe, true);
  assert.equal(r.json.route.detentsConstrained, false);

  const noRoute = await postJson('/api/compute', baseSingle);
  assert.equal(noRoute.status, 200);
  assert.equal(noRoute.json.route, null);
});

test('单规格：route 参数非法 → 400', async () => {
  for (const bad of [
    { fromDeg: 'x', toDeg: 10 },
    { fromDeg: 10 },
    { toDeg: 10 },
    'on',
    42,
    [10, 20],
  ]) {
    const r = await postJson('/api/compute', { ...baseSingle, route: bad });
    assert.equal(r.status, 400, `route=${JSON.stringify(bad)} 应 400`);
    assert.match(r.json.error, /route/);
  }
});

test('单规格：启用档位时 route 两端须落在可用档位上', async () => {
  const base = {
    circumference: 360,
    seamWidth: 0,
    zones: [{ start: 90, end: 180 }],
    detents: { enabled: true, steps: 12 },
  };
  const ok = await postJson('/api/compute', {
    ...base,
    route: { fromDeg: 210, toDeg: 30 },
  });
  assert.equal(ok.json.route.status, 'ok');
  assert.equal(ok.json.route.detentsConstrained, true);
  assert.equal(ok.json.route.from.detentIndex, 7);

  const off = await postJson('/api/compute', {
    ...base,
    route: { fromDeg: 210, toDeg: 35 },
  });
  assert.equal(off.json.route.status, 'off-detent');
  assert.equal(off.json.route.to.onDetent, false);
});

test('多规格：route 返回与单规格一致的结构；隔开时报不可达', async () => {
  const r = await postJson('/api/compute-multi', {
    circumferences: [360, 360],
    seamWidth: 0,
    zones: [{ start: 90, end: 180 }],
    route: { fromDeg: 300, toDeg: 30 },
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.route);
  assert.equal(r.json.route.status, 'ok');
  assert.equal(r.json.route.best.direction, 'cw');
  assert.equal(typeof r.json.route.reason, 'string');

  // 两端各自安全但被禁用段隔开 → unreachable
  const sep = await postJson('/api/compute-multi', {
    circumferences: [360, 360],
    seamWidth: 0,
    zones: [
      { start: 0, end: 90 },
      { start: 180, end: 270 },
    ],
    route: { fromDeg: 120, toDeg: 300 },
  });
  assert.equal(sep.json.route.status, 'unreachable');
  assert.equal(sep.json.route.from.safe, true);
  assert.equal(sep.json.route.to.safe, true);
  assert.equal(sep.json.route.best, null);

  // 缺省 route → null
  const noRoute = await postJson('/api/compute-multi', baseMulti);
  assert.equal(noRoute.json.route, null);

  // 非法 route → 400
  const bad = await postJson('/api/compute-multi', {
    ...baseMulti,
    route: { fromDeg: 10, toDeg: 'x' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /route/);
});

test('路径边界：跨 0°、整圈可行与起终点相同', async () => {
  // 跨 0°：可行跨零弧 180°→90°，350°→10° 顺时针 20°
  const wrap = await postJson('/api/compute', {
    circumference: 360,
    seamWidth: 0,
    zones: [{ start: 90, end: 180 }],
    route: { fromDeg: 350, toDeg: 10 },
  });
  assert.equal(wrap.json.route.status, 'ok');
  assert.equal(wrap.json.route.best.direction, 'cw');
  assert.equal(Math.round(wrap.json.route.best.sweepDeg), 20);

  // 整圈可行：两方向均可达，等长（180°）取顺时针
  const full = await postJson('/api/compute', {
    circumference: 360,
    seamWidth: 0,
    zones: [],
    route: { fromDeg: 0, toDeg: 180 },
  });
  assert.equal(full.json.route.cw.reachable, true);
  assert.equal(full.json.route.ccw.reachable, true);
  assert.equal(full.json.route.best.direction, 'cw');
  assert.equal(Math.round(full.json.route.best.sweepDeg), 180);

  // 起终点相同（含归一化后相同）：转角 0，无需旋转
  const same = await postJson('/api/compute', {
    circumference: 360,
    seamWidth: 0,
    zones: [{ start: 90, end: 180 }],
    route: { fromDeg: -30, toDeg: 330 },
  });
  assert.equal(same.json.route.samePoint, true);
  assert.equal(same.json.route.status, 'ok');
  assert.equal(Math.round(same.json.route.best.sweepDeg), 0);
});
