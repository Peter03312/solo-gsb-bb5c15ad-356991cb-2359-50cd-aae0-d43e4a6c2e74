'use strict';

/**
 * 设备档位约束。
 *
 * 设备每圈有 N 个等距档位，零位偏移为 o (deg)，仅允许角度
 *   θ_k = o + k·360/N （按整圈归一到 [0,360)）。
 * 启用后将档位与连续可行段（单规格）或共用段（多规格）求交：
 * 落在可行段内（含边界）的档位才“可用”；默认档位沿用
 * “瓶颈间隙最大、角度较小优先”规则从可用档位中选取。
 *
 * 连续区间有解但没有可用档位时（区别于保护区覆盖整圈），
 * 给出每条可行（共用）弧前后最近的档位及角距离，供界面提示与拖动吸附。
 */

const FULL = 360;
const MIN_STEPS = 2;
const MAX_STEPS = 360;
const EPS = 1e-7; // 角度比较容差

function mod(n, m) {
  return ((n % m) + m) % m;
}

/** 圆上两点最短角距离。 */
function circDistDeg(a, b) {
  const d = Math.abs(mod(a - b, FULL));
  return Math.min(d, FULL - d);
}

/**
 * 解析档位参数。
 * 禁用：未传 / enabled !== true / steps 缺失 → 返回 {enabled:false}。
 * 启用：steps 必须为 2～360 的整数；offsetDeg（或 offset）为有限数（默认 0）。
 * @param {object|undefined|boolean|null} input
 */
function parseDetents(input) {
  if (input === undefined || input === null || input === false) {
    return { enabled: false };
  }
  if (input === true || typeof input !== 'object') {
    throw new TypeError('detents 参数必须为对象，如 {enabled:true, steps:12, offsetDeg:0}');
  }
  if (!input.enabled) return { enabled: false };

  const steps = input.steps;
  if (
    typeof steps !== 'number' ||
    !Number.isFinite(steps) ||
    !Number.isInteger(steps) ||
    steps < MIN_STEPS ||
    steps > MAX_STEPS
  ) {
    throw new RangeError(
      `detents.steps 必须为 ${MIN_STEPS}～${MAX_STEPS} 的整数（每圈档位数）`
    );
  }
  const rawOffset = input.offsetDeg !== undefined ? input.offsetDeg : input.offset;
  let offsetDeg = 0;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (typeof rawOffset !== 'number' || !Number.isFinite(rawOffset)) {
      throw new TypeError('detents.offsetDeg 必须为数值（角度，按整圈归一）');
    }
    offsetDeg = mod(rawOffset, FULL);
  }
  return { enabled: true, steps, offsetDeg };
}

/** 全部档位角度（升序，已按整圈归一）。 */
function detentPositions(cfg) {
  const { steps, offsetDeg } = cfg;
  const delta = FULL / steps;
  const out = [];
  for (let k = 0; k < steps; k++) out.push(mod(offsetDeg + k * delta, FULL));
  out.sort((a, b) => a - b);
  return out;
}

/** 排序、裁剪并合并紧贴/重叠的 [0,360] 线性片段。 */
function normalizePieces(pieces) {
  const clamp = (x) => Math.max(0, Math.min(FULL, x));
  const sorted = pieces
    .map(([a, b]) => [clamp(a), clamp(b)])
    .filter(([a, b]) => b - a > EPS)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + EPS) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged.map(([a, b]) => [a, b >= FULL - EPS ? FULL : b]);
}

/**
 * 圆周弧（{startDeg,endDeg,wraps?}）→ [0,360] 内不跨零线性片段。
 * full 弧返回 [[0,360]]。
 */
function arcsToFeasiblePieces(arcs) {
  const pieces = [];
  for (const a of arcs || []) {
    if (a.full) return [[0, FULL]];
    const s = mod(a.startDeg, FULL);
    const e = a.wraps ? a.endDeg + FULL : a.endDeg;
    const width = a.widthDeg !== undefined ? a.widthDeg : e - s;
    if (width <= EPS) continue;
    if (width >= FULL - EPS) return [[0, FULL]];
    if (e >= FULL - EPS) {
      if (FULL - s > EPS) pieces.push([s, FULL]);
      if (e - FULL > EPS) pieces.push([0, e - FULL]);
    } else {
      pieces.push([s, e]);
    }
  }
  return normalizePieces(pieces);
}

function isFullCirclePieces(pieces) {
  return (
    pieces.length === 1 && pieces[0][0] <= EPS && pieces[0][1] >= FULL - EPS
  );
}

/** 角度 x 是否落在任一线性片段内（含边界，圆上比较）。 */
function insideAnyOnCircle(pieces, x) {
  return pieces.some(
    ([a, b]) =>
      (x >= a - EPS && x <= b + EPS) ||
      (x + FULL >= a - EPS && x + FULL <= b + EPS)
  );
}

/** 档位候选排序：瓶颈间隙越大越优；并列取较小角度。minGapDeg 为 null 视为无约束（+∞）。 */
function betterCandidate(curr, cand) {
  if (cand.minGapDeg === null && curr.minGapDeg !== null) return true;
  if (curr.minGapDeg === null && cand.minGapDeg !== null) return false;
  if (cand.minGapDeg !== null && curr.minGapDeg !== null) {
    if (cand.minGapDeg > curr.minGapDeg + EPS) return true;
    if (cand.minGapDeg < curr.minGapDeg - EPS) return false;
  }
  return cand.deg < curr.deg - EPS;
}

/**
 * 单条弧（可能跨零）前后最近的档位。
 * before：沿逆时针距弧起点最近；after：沿顺时针距弧终点最近。
 */
function nearestForArc(arc, cfg, positions) {
  if (arc.full || arc.widthDeg >= FULL - EPS) return null;
  const s = mod(arc.startDeg, FULL);
  const eLift = arc.wraps ? mod(arc.startDeg, FULL) + arc.widthDeg : arc.endDeg;

  let before = null;
  let after = null;
  positions.forEach((d, index) => {
    // 检查每个档位在 s 附近整圈的投影 [s-360, s+360]
    for (const lift of [d - FULL, d, d + FULL]) {
      const db = s - lift;
      if (db > EPS && (!before || db < before.distanceDeg - EPS)) {
        before = { index, deg: mod(lift, FULL), distanceDeg: db };
      }
      const da = lift - eLift;
      if (da > EPS && (!after || da < after.distanceDeg - EPS)) {
        after = { index, deg: mod(lift, FULL), distanceDeg: da };
      }
    }
  });
  return { before, after };
}

/**
 * 档位分析（模式无关）。
 * @param {object} cfg parseDetents 返回的启用配置 {steps, offsetDeg}
 * @param {Array<{startDeg:number,endDeg:number,wraps?:boolean,full?:boolean,widthDeg?:number}>} arcs
 *        连续可行（共用）圆周弧；调用方保证其非空
 * @param {(deg:number)=>number|null} minGapAt 该角度的瓶颈间隙（null 表示无约束）
 * @param {(deg:number)=>*} detailAt 该角度的明细（如各规格间隙），原样挂到可用档位
 */
function analyzeDetents(cfg, arcs, minGapAt, detailAt) {
  const positions = detentPositions(cfg);
  const pieces = arcsToFeasiblePieces(arcs);
  const fullFeasible = isFullCirclePieces(pieces);
  const inside = (x) => fullFeasible || insideAnyOnCircle(pieces, x);

  const all = positions.map((deg, index) => ({ index, deg }));
  const available = [];
  let best = null;
  for (const item of all) {
    if (!inside(item.deg)) continue;
    const minGap = minGapAt(item.deg);
    const cand = {
      index: item.index,
      deg: item.deg,
      minGapDeg: minGap,
      detail: detailAt ? detailAt(item.deg) : undefined,
    };
    available.push(cand);
    if (!best || betterCandidate(best, cand)) best = cand;
  }
  available.sort((a, b) => a.deg - b.deg);

  const nearest = [];
  if (!fullFeasible && available.length === 0) {
    for (const arc of arcs) {
      const n = nearestForArc(arc, cfg, positions);
      if (n && (n.before || n.after)) {
        nearest.push({ arc, before: n.before, after: n.after });
      }
    }
  }

  return {
    enabled: true,
    steps: cfg.steps,
    offsetDeg: cfg.offsetDeg,
    stepDeg: FULL / cfg.steps,
    positions,
    available,
    best, // null：无可用档位
    noAvailable: !fullFeasible && available.length === 0,
    nearest,
  };
}

/**
 * 单规格档位结果（在 seamMath 中组装，角度按周长换算为 mm）。
 * @param {object} cfg 启用配置
 * @param {Array} feasible feasible 弧（{startMm/endMm/wraps/widthDeg/...}）
 * @param {number} C 周长
 * @param {(deg:number)=>number} gapDegAt 角度到最近禁用边界的角距离（无禁用区调用方不应传 null 场景）
 * @param {boolean} noForbidden 无任何禁用边界（整圈等距）
 */
function buildSingleDetents(cfg, feasible, C, gapDegAt, noForbidden) {
  const degToMm = (deg) => (deg / FULL) * C;
  const analysis = analyzeDetents(
    cfg,
    feasible,
    noForbidden ? () => null : gapDegAt,
    (deg) => ({
      gapDeg: noForbidden ? null : gapDegAt(deg),
      mm: degToMm(deg),
    })
  );

  return {
    enabled: true,
    steps: analysis.steps,
    offsetDeg: analysis.offsetDeg,
    stepDeg: analysis.stepDeg,
    positions: analysis.positions,
    available: analysis.available.map((c) => ({
      index: c.index,
      deg: c.deg,
      mm: degToMm(c.deg),
      gapDeg: c.detail.gapDeg,
    })),
    best: analysis.best
      ? {
          index: analysis.best.index,
          deg: analysis.best.deg,
          mm: degToMm(analysis.best.deg),
          gapDeg: analysis.best.detail.gapDeg,
        }
      : null,
    noAvailable: analysis.noAvailable,
    nearest: analysis.nearest.map((n) => ({
      arc: n.arc,
      before: n.before
        ? { index: n.before.index, deg: n.before.deg, distanceDeg: n.before.distanceDeg }
        : null,
      after: n.after
        ? { index: n.after.index, deg: n.after.deg, distanceDeg: n.after.distanceDeg }
        : null,
    })),
  };
}

module.exports = {
  EPS,
  FULL,
  MIN_STEPS,
  MAX_STEPS,
  mod,
  circDistDeg,
  parseDetents,
  detentPositions,
  normalizePieces,
  arcsToFeasiblePieces,
  insideAnyOnCircle,
  betterCandidate,
  nearestForArc,
  analyzeDetents,
  buildSingleDetents,
};
