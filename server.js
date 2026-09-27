'use strict';

const path = require('path');
const express = require('express');
const { computeSeamAvoidance } = require('./src/seamMath');
const { computeMultiSpec, MIN_SPECS, MAX_SPECS } = require('./src/multiSpec');
const { parseDetents } = require('./src/detents');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_ZONES = 200;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 前端直接复用 src 下的 UMD 差异算法
app.use('/src', express.static(path.join(__dirname, 'src')));

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/** 校验设备档位参数，返回错误信息或 null。 */
function validateDetents(detents) {
  if (detents === undefined) return null;
  if (detents === null || typeof detents !== 'object' || Array.isArray(detents)) {
    return 'detents 必须为对象，如 {enabled:true, steps:12, offsetDeg:0}';
  }
  if (!detents.enabled) return null;
  const { steps, offsetDeg } = detents;
  if (
    typeof steps !== 'number' ||
    !Number.isFinite(steps) ||
    !Number.isInteger(steps) ||
    steps < 2 ||
    steps > 360
  ) {
    return 'detents.steps 必须为 2～360 的整数（每圈档位数）';
  }
  if (
    offsetDeg !== undefined &&
    offsetDeg !== null &&
    !isFiniteNumber(offsetDeg)
  ) {
    return 'detents.offsetDeg 必须为数值（角度，按整圈归一）';
  }
  return null;
}

/** 校验调机旋转路径参数，返回错误信息或 null。 */
function validateRoute(route) {
  if (route === undefined || route === null) return null;
  if (typeof route !== 'object' || Array.isArray(route)) {
    return 'route 必须为对象，如 {fromDeg:30, toDeg:210}';
  }
  if (!isFiniteNumber(route.fromDeg) || !isFiniteNumber(route.toDeg)) {
    return 'route.fromDeg 与 route.toDeg 必须为数值（角度，按整圈归一）';
  }
  return null;
}

/** 校验安装误差参数，返回错误信息或 null。 */
function validateTolerance(tolerance) {
  if (tolerance === undefined || tolerance === null) return null;
  if (typeof tolerance !== 'object' || Array.isArray(tolerance)) {
    return 'tolerance 必须为对象，如 {ccwDeg:2, cwDeg:3}';
  }
  if (!isFiniteNumber(tolerance.ccwDeg) || tolerance.ccwDeg < 0) {
    return 'tolerance.ccwDeg 必须为不小于 0 的有限角度（°）';
  }
  if (!isFiniteNumber(tolerance.cwDeg) || tolerance.cwDeg < 0) {
    return 'tolerance.cwDeg 必须为不小于 0 的有限角度（°）';
  }
  return null;
}

/** 校验共用的接缝宽度与保护区，返回错误信息或 null。 */
function validateSharedInput(seamWidth, zones) {
  if (!isFiniteNumber(seamWidth) || seamWidth < 0) {
    return 'seamWidth 必须为不小于 0 的数值 (mm)';
  }
  if (!Array.isArray(zones) || zones.length > MAX_ZONES) {
    return `zones 必须为数组，且不超过 ${MAX_ZONES} 个`;
  }
  for (const [i, z] of zones.entries()) {
    if (!z || !isFiniteNumber(z.start) || !isFiniteNumber(z.end)) {
      return `zones[${i}] 需要数值类型的 start 与 end (mm)`;
    }
  }
  return null;
}

app.post('/api/compute', (req, res) => {
  const body = req.body || {};
  const { circumference, seamWidth, zones, detents, route, tolerance } = body;

  if (!isFiniteNumber(circumference) || circumference <= 0) {
    return res.status(400).json({ error: 'circumference 必须为大于 0 的数值 (mm)' });
  }
  const sharedError = validateSharedInput(seamWidth, zones);
  if (sharedError) return res.status(400).json({ error: sharedError });
  const detentsError = validateDetents(detents);
  if (detentsError) return res.status(400).json({ error: detentsError });
  const routeError = validateRoute(route);
  if (routeError) return res.status(400).json({ error: routeError });
  const toleranceError = validateTolerance(tolerance);
  if (toleranceError) return res.status(400).json({ error: toleranceError });

  try {
    const result = computeSeamAvoidance(
      circumference,
      seamWidth,
      zones,
      detents,
      route,
      tolerance
    );
    res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post('/api/compute-multi', (req, res) => {
  const body = req.body || {};
  const { circumferences, seamWidth, zones, detents, route, tolerance } = body;

  if (
    !Array.isArray(circumferences) ||
    circumferences.length < MIN_SPECS ||
    circumferences.length > MAX_SPECS
  ) {
    return res
      .status(400)
      .json({ error: `circumferences 必须为含 ${MIN_SPECS}～${MAX_SPECS} 个周长的数组 (mm)` });
  }
  for (const [i, C] of circumferences.entries()) {
    if (!isFiniteNumber(C) || C <= 0) {
      return res.status(400).json({ error: `circumferences[${i}] 必须为大于 0 的数值 (mm)` });
    }
  }
  const sharedError = validateSharedInput(seamWidth, zones);
  if (sharedError) return res.status(400).json({ error: sharedError });
  const detentsError = validateDetents(detents);
  if (detentsError) return res.status(400).json({ error: detentsError });
  const routeError = validateRoute(route);
  if (routeError) return res.status(400).json({ error: routeError });
  const toleranceError = validateTolerance(tolerance);
  if (toleranceError) return res.status(400).json({ error: toleranceError });

  try {
    const result = computeMultiSpec(
      circumferences,
      seamWidth,
      zones,
      detents,
      route,
      tolerance
    );
    res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`seam-avoidance app listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { app };
