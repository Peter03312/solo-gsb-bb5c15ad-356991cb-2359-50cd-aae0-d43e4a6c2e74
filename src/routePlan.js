'use strict';

/**
 * 调机旋转路径规划。
 *
 * 基于已计算的可行角度段（单规格）或共用安全段（多规格），规划从当前角度
 * 到目标角度的调机旋转路径：只允许沿圆周单向连续旋转，且全过程处于安全
 * 角度（落在可行/共用段内，含边界）。
 *
 * 分别评估顺时针（角度增大）与逆时针（角度减小）两条单向路径：某方向可达
 * ⟺ 从起点沿该方向到终点的扫掠角不超出起点所在可行段在该方向上的余量。
 * 两个方向都可达时选转角较短者，等长（含起终点相同的 0°）取顺时针。
 *
 * 启用设备档位约束时，起点与终点还必须落在可用档位上（调机只停靠在档位，
 * 中间过程连续旋转不受档位限制）；端点不安全与端点不在可用档位分别报告。
 */

const FULL = 360;
const EPS = 1e-7; // 角度比较容差

function mod(n, m) {
  return ((n % m) + m) % m;
}

const fmtDeg = (x) => (Math.round(x * 10) / 10).toFixed(1);

/** 圆周弧是否覆盖整圈。 */
function isFullArc(arc) {
  return !!arc.full || (arc.widthDeg !== undefined && arc.widthDeg >= FULL - EPS);
}

/** 圆周弧的宽度（度）；缺省时由端点（含跨零）推算。 */
function arcWidth(arc) {
  if (arc.widthDeg !== undefined) return arc.widthDeg;
  const s = mod(arc.startDeg, FULL);
  const e = arc.wraps ? mod(arc.endDeg, FULL) + FULL : arc.endDeg;
  return e - s;
}

/** 角度 deg（已归一到 [0,360)）是否落在圆周弧内（含边界）。 */
function degInArc(deg, arc) {
  if (isFullArc(arc)) return true;
  const width = arcWidth(arc);
  if (width <= EPS) return false; // 零宽退化弧
  // 从弧起点沿正向（顺时针）的偏移量落在弧宽内即在弧上，跨零/末端 360 均由此统一处理
  return mod(deg - mod(arc.startDeg, FULL), FULL) <= width + EPS;
}

/** 在可用档位中查找角度 deg（圆周容差匹配），返回档位项或 null。 */
function detentAt(available, deg) {
  let hit = null;
  for (const d of available) {
    const diff = Math.abs(mod(d.deg - deg + FULL / 2, FULL) - FULL / 2);
    if (diff <= 1e-6 && (!hit || d.index < hit.index)) hit = d;
  }
  return hit;
}

/**
 * 路径规划主入口。
 * @param {number} fromDeg 当前角度（任意数值，按整圈归一）
 * @param {number} toDeg   目标角度（任意数值，按整圈归一）
 * @param {Array<{startDeg:number,endDeg:number,wraps?:boolean,widthDeg?:number,full?:boolean}>} arcs
 *        可行/共用安全圆周弧（空数组表示整圈禁用）
 * @param {object|null} [detents] 可用档位约束 {available:[{index,deg,...}]}；null 表示不约束
 */
function planRoute(fromDeg, toDeg, arcs, detents) {
  if (!Number.isFinite(fromDeg) || !Number.isFinite(toDeg)) {
    throw new TypeError('route.fromDeg 与 route.toDeg 必须为数值（角度，按整圈归一）');
  }
  const from = mod(fromDeg, FULL);
  const to = mod(toDeg, FULL);
  const samePoint =
    Math.abs(mod(from - to + FULL / 2, FULL) - FULL / 2) <= 1e-9;

  const list = Array.isArray(arcs) ? arcs : [];
  const fullCircle = list.some(isFullArc);
  const fromArc = fullCircle ? null : list.find((a) => degInArc(from, a)) || null;
  const toArc = fullCircle ? null : list.find((a) => degInArc(to, a)) || null;
  const fromSafe = fullCircle || !!fromArc;
  const toSafe = fullCircle || !!toArc;

  const detentsOn = !!(detents && Array.isArray(detents.available));
  const fromDetent = detentsOn ? detentAt(detents.available, from) : null;
  const toDetent = detentsOn ? detentAt(detents.available, to) : null;

  const result = {
    fromDeg: from,
    toDeg: to,
    samePoint,
    detentsConstrained: detentsOn,
    from: {
      safe: fromSafe,
      onDetent: detentsOn ? !!fromDetent : null,
      detentIndex: fromDetent ? fromDetent.index : null,
    },
    to: {
      safe: toSafe,
      onDetent: detentsOn ? !!toDetent : null,
      detentIndex: toDetent ? toDetent.index : null,
    },
    status: 'ok', // 'ok' | 'unreachable' | 'unsafe-endpoint' | 'off-detent'
    reason: '',
    cw: null,
    ccw: null,
    best: null,
  };

  // 两端必须各自落在安全角度上
  if (!fromSafe || !toSafe) {
    result.status = 'unsafe-endpoint';
    const parts = [];
    if (!fromSafe) parts.push(`当前角度 ${fmtDeg(from)}° 不在可行安全段内`);
    if (!toSafe) parts.push(`目标角度 ${fmtDeg(to)}° 不在可行安全段内`);
    result.reason = parts.join('；');
    return result;
  }

  // 启用档位约束：两端还须落在可用档位上
  if (detentsOn && (!fromDetent || !toDetent)) {
    result.status = 'off-detent';
    const parts = [];
    if (!fromDetent) parts.push(`当前角度 ${fmtDeg(from)}° 不在可用档位上`);
    if (!toDetent) parts.push(`目标角度 ${fmtDeg(to)}° 不在可用档位上`);
    result.reason = parts.join('；');
    return result;
  }

  // 两个方向的扫掠角（顺时针 = 角度增大方向）
  const cwSweep = mod(to - from, FULL);
  const ccwSweep = mod(from - to, FULL);

  let cwReach;
  let ccwReach;
  if (fullCircle) {
    cwReach = true;
    ccwReach = true;
  } else {
    // 起点所在可行段在两个方向上的剩余安全角；越过段边界即进入禁用段
    const cwRemain = mod(fromArc.endDeg - from, FULL);
    const ccwRemain = mod(from - fromArc.startDeg, FULL);
    cwReach = cwSweep <= cwRemain + EPS;
    ccwReach = ccwSweep <= ccwRemain + EPS;
  }
  result.cw = { sweepDeg: cwSweep, reachable: cwReach };
  result.ccw = { sweepDeg: ccwSweep, reachable: ccwReach };

  if (!cwReach && !ccwReach) {
    result.status = 'unreachable';
    result.reason =
      '当前角度与目标角度各自安全，但分属被禁用段隔开的不同可行段：' +
      `顺时针 ${fmtDeg(cwSweep)}° 与逆时针 ${fmtDeg(ccwSweep)}° 都会经过禁用角度，单向连续旋转不可达`;
    return result;
  }

  // 可达方向中选转角较短者；等长（含起终点相同）取顺时针
  const dir =
    cwReach && ccwReach
      ? cwSweep <= ccwSweep + EPS
        ? 'cw'
        : 'ccw'
      : cwReach
        ? 'cw'
        : 'ccw';
  const sweepDeg = dir === 'cw' ? cwSweep : ccwSweep;
  result.best = {
    direction: dir,
    directionLabel: dir === 'cw' ? '顺时针' : '逆时针',
    sweepDeg,
    fromDeg: from,
    toDeg: to,
  };
  result.reason = samePoint
    ? '起点与终点相同，无需旋转'
    : `${result.best.directionLabel}旋转 ${fmtDeg(sweepDeg)}° 可达` +
      (cwReach && ccwReach && Math.abs(cwSweep - ccwSweep) > EPS
        ? `（另一方向${dir === 'cw' ? '逆时针' : '顺时针'} ${fmtDeg(dir === 'cw' ? ccwSweep : cwSweep)}°）`
        : '');
  return result;
}

module.exports = {
  FULL,
  EPS,
  mod,
  degInArc,
  planRoute,
};
