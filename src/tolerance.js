'use strict';

/**
 * 安装误差分析。
 *
 * 标称角度 θ 的安装误差用两侧角宽表示：逆时针 ccwDeg、顺时针 cwDeg
 * （均为非负有限角度）。实际角度可能落在从 θ−ccwDeg 到 θ+cwDeg 的整条正向
 * 圆弧（宽 T = ccwDeg + cwDeg）上的任意位置；θ 可靠 ⟺ 该圆弧整条落在安全段
 * （单规格可行段 / 多规格共用段）内，含边界。
 *
 * 对每条宽 w 的安全弧 [s, e]（提升坐标），可靠 θ 区间为 [s+ccwDeg, e−cwDeg]：
 *  - w > T：宽 w−T 的可靠段；
 *  - w = T：收缩后仅剩一个点 θ = s+ccwDeg（仍可靠，输出单点段）；
 *  - w < T：该弧无可靠角度。
 * 整圈安全时任意 θ 均可靠（可靠段为整圈）；误差总宽 T ≥ 360° 时误差弧覆盖
 * 整圈，仅整圈安全有解，否则可靠段为空。
 *
 * 可靠段的圆周表示与现有可行段/共用段约定一致（见 README「圆周区间表示约定」），
 * 另加单点段 {startDeg, endDeg:同值, wraps:false, widthDeg:0, point:true}。
 */

const FULL = 360;
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
 * 解析安装误差参数。
 * 未传 / null / false → {enabled:false}；
 * 对象：ccwDeg 与 cwDeg 均为非负有限角度 → {enabled:true, ccwDeg, cwDeg}；
 * 其余（非对象、缺失、负数、非有限数）抛错，由接口层转为 400。
 */
function parseTolerance(input) {
  if (input === undefined || input === null || input === false) {
    return { enabled: false };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('tolerance 必须为对象，如 {ccwDeg:2, cwDeg:3}');
  }
  const { ccwDeg, cwDeg } = input;
  const bad = (x) => typeof x !== 'number' || !Number.isFinite(x) || x < 0;
  if (bad(ccwDeg) || bad(cwDeg)) {
    throw new RangeError('tolerance.ccwDeg 与 tolerance.cwDeg 必须为非负有限角度（°）');
  }
  return { enabled: true, ccwDeg, cwDeg };
}

/** 圆周弧宽度（度）；缺省时由端点（含跨零）推算。 */
function arcWidthDeg(arc) {
  if (arc.widthDeg !== undefined) return arc.widthDeg;
  const s = mod(arc.startDeg, FULL);
  return (arc.wraps ? mod(arc.endDeg, FULL) + FULL : arc.endDeg) - s;
}

/** 排序、裁剪并合并紧贴/重叠的 [0,360] 线性片段（与 detents.normalizePieces 同逻辑）。 */
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
 * 安全弧集合 + 两侧误差 → 全部可靠角度段。
 * @param {Array<{startDeg:number,endDeg:number,wraps?:boolean,widthDeg?:number,full?:boolean}>} arcs
 *        安全圆周弧（单规格可行段或多规格共用段；空数组表示无安全段）
 * @param {number} ccwDeg 逆时针误差（非负有限角度）
 * @param {number} cwDeg  顺时针误差（非负有限角度）
 * @returns {{full:boolean, empty:boolean, arcs:Array}}
 *   full=true 时 arcs 为整圈弧；empty=true 时 arcs 为空（可靠段为空）。
 */
function computeReliableArcs(arcs, ccwDeg, cwDeg) {
  const total = ccwDeg + cwDeg;
  const list = Array.isArray(arcs) ? arcs : [];
  const fullArc = { startDeg: 0, endDeg: 0, wraps: false, widthDeg: FULL, full: true };

  // 整圈安全：任意 θ 的误差弧都落在整圈内，全部角度可靠
  if (list.some((a) => a && (a.full || arcWidthDeg(a) >= FULL - EPS))) {
    return { full: true, empty: false, arcs: [fullArc] };
  }
  // 误差总宽 ≥ 360°：误差弧覆盖整圈，仅整圈安全有解（上面已排除）；无安全段同理为空
  if (total >= FULL - EPS || list.length === 0) {
    return { full: false, empty: true, arcs: [] };
  }

  const pieces = []; // [0,360] 线性片段
  const points = []; // 收缩后仅剩的单点（角度）
  for (const arc of list) {
    const s = mod(arc.startDeg, FULL);
    const w = arcWidthDeg(arc);
    const rw = w - total; // 收缩后宽度
    if (rw < -EPS) continue; // 该弧收缩后为空
    if (rw <= EPS) {
      // 收缩后仅剩一个点
      points.push(mod(s + ccwDeg, FULL));
      continue;
    }
    // 可靠 θ 提升区间 [s+ccwDeg, s+w−cwDeg]，拆为 [0,360] 片段
    const rs = s + ccwDeg;
    const re = rs + rw;
    if (rs >= FULL) {
      pieces.push([rs - FULL, re - FULL]);
    } else if (re > FULL + EPS) {
      pieces.push([rs, FULL]);
      if (re - FULL > EPS) pieces.push([0, re - FULL]);
    } else {
      pieces.push([rs, Math.min(re, FULL)]);
    }
  }

  const merged = normalizePieces(pieces);
  const out = [];
  let segs = merged;
  // 零点两侧的片段拼回一条跨零弧（与 multiSpec.toCircularArcs 一致）
  if (
    merged.length >= 2 &&
    merged[0][0] <= EPS &&
    merged[merged.length - 1][1] >= FULL - EPS
  ) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    out.push({
      startDeg: last[0],
      endDeg: first[1],
      wraps: true,
      widthDeg: FULL - last[0] + first[1],
    });
    segs = merged.slice(1, -1);
  }
  for (const [a, b] of segs) {
    out.push({ startDeg: a, endDeg: b, wraps: false, widthDeg: b - a });
  }
  for (const p of points) {
    out.push({ startDeg: p, endDeg: p, wraps: false, widthDeg: 0, point: true });
  }
  out.sort((x, y) => x.startDeg - y.startDeg || x.widthDeg - y.widthDeg);
  return { full: false, empty: out.length === 0, arcs: out };
}

/**
 * 角度 deg（任意数值，按整圈归一）是否落在可靠段内（含边界）。
 * 单点段按圆周容差匹配；其余与 routePlan.degInArc 的判定一致。
 */
function degInReliable(arcs, deg) {
  const x = mod(deg, FULL);
  for (const a of arcs || []) {
    if (a.full) return true;
    if (a.point) {
      if (circDistDeg(x, a.startDeg) <= 1e-6) return true;
      continue;
    }
    const w = arcWidthDeg(a);
    if (w > EPS && mod(x - mod(a.startDeg, FULL), FULL) <= w + EPS) return true;
  }
  return false;
}

module.exports = {
  FULL,
  EPS,
  mod,
  circDistDeg,
  parseTolerance,
  arcWidthDeg,
  computeReliableArcs,
  degInReliable,
};
