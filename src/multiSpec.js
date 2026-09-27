'use strict';

/**
 * 多规格共用角度算法。
 *
 * 输入 2～8 个筒体周长（mm），沿用同一接缝安全宽度 W 与同一组毫米制保护区，
 * 对每个规格分别调用 computeSeamAvoidance，再把可行段统一归一化到角度域
 * [0°, 360°) 求圆周交集，输出所有规格均安全的角度段。
 *
 * 默认角度：对候选 θ，取 θ 在各规格下到该规格禁用边界的圆周角距离的最小值
 * g(θ) = min_k dist(θ, ∂F_k)，在公共可行段上最大化 g；并列取较小角度。
 * 公共可行段（圆相邻并集边界之间的空隙）内 g(θ) = min(θ-s, e-θ)，
 * 最大值落在最宽公共段中点，因此可直接按“最宽段中点、并列取小角”选取，
 * 各规格的实际间隙仍逐一分量计算并随结果返回。
 *
 * 无共同解时，按输入顺序逐个累计交集，报告使交集首次归零的规格，
 * 并给出此前公共可行段与该规格禁用段的冲突区间。
 *
 * 公共可行段为空时额外计算“最小违约备选”：按各规格禁用角度边界切分整圆，
 * 各原子区间内每个规格的侵入深度（走出该规格禁用区的最近角距离）为分段
 * 线性函数，枚举切分点、禁用弧最深入点与上升/下降直线交点，按
 * 最大侵入深度 → 总侵入深度 → 较小角度的字典序选出违约最小的角度；
 * 启用设备档位约束时仅在档位角度中评估。
 */

const { computeSeamAvoidance } = require('./seamMath');
const { parseDetents, analyzeDetents, detentPositions } = require('./detents');
const { planRoute } = require('./routePlan');
const { parseTolerance, computeReliableArcs, degInReliable } = require('./tolerance');

const FULL = 360;
const EPS = 1e-7; // 角度比较容差
const MIN_SPECS = 2;
const MAX_SPECS = 8;

function mod(n, m) {
  return ((n % m) + m) % m;
}

function clamp360(x) {
  return Math.max(0, Math.min(FULL, x));
}

/** 排序、裁剪并合并紧贴/重叠的 [0,360] 线性片段。 */
function normalizePieces(pieces) {
  const sorted = pieces
    .map(([a, b]) => [clamp360(a), clamp360(b)])
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

function isFullCircle(pieces) {
  return (
    pieces.length === 1 && pieces[0][0] <= EPS && pieces[0][1] >= FULL - EPS
  );
}

/**
 * 单规格结果 → 可行角度片段（均在 [0,360] 内、不跨零、已排序）。
 * 无解返回 []；整圈可行返回 [[0,360]]。
 */
function feasibleDegPieces(result) {
  if (result.noSolution) return [];
  const pieces = [];
  for (const g of result.feasible) {
    const width =
      g.widthDeg !== undefined
        ? g.widthDeg
        : (g.wraps ? g.endDeg + FULL : g.endDeg) - g.startDeg;
    if (width <= EPS) continue;
    if (width >= FULL - EPS) return [[0, FULL]];
    const s = mod(g.startDeg, FULL);
    const e = s + width;
    if (e >= FULL - EPS) {
      if (FULL - s > EPS) pieces.push([s, FULL]);
      if (e - FULL > EPS) pieces.push([0, e - FULL]);
    } else {
      pieces.push([s, e]);
    }
  }
  return normalizePieces(pieces);
}

/** 单规格结果 → 合并禁用角度片段。无解（整圈禁用）返回 [[0,360]]。 */
function forbiddenDegPieces(result) {
  if (result.noSolution) return [[0, FULL]];
  return normalizePieces(
    (result.forbiddenMerged || []).map((f) => [f.startDeg, f.endDeg])
  );
}

function insideAny(pieces, x) {
  return pieces.some(([a, b]) => x >= a - EPS && x <= b + EPS);
}

/**
 * 圆周交集：以所有片段端点（含 0、360）切分原子区间，
 * 中点被全部片段集覆盖者保留，再合并相邻片段。
 * @param {Array<Array<[number, number]>>} sets 已归一化的 [0,360] 片段集数组
 */
function intersectPieces(sets) {
  if (sets.length === 0) return [];
  const points = new Set([0, FULL]);
  for (const set of sets) {
    for (const [a, b] of set) {
      points.add(clamp360(a));
      points.add(clamp360(b));
    }
  }
  const cuts = [...points].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const x0 = cuts[i];
    const x1 = cuts[i + 1];
    if (x1 - x0 <= EPS) continue;
    const mid = (x0 + x1) / 2;
    if (sets.every((set) => insideAny(set, mid))) out.push([x0, x1]);
  }
  return normalizePieces(out);
}

/**
 * 把不跨零片段还原为圆周弧段：末端 360 与始端 0 的两段合并为一条跨零弧。
 * 整圈返回 {full:true, arcs:[]}。
 * @returns {{full:boolean, arcs:Array<{startDeg:number,endDeg:number,wraps:boolean,widthDeg:number}>}}
 */
function toCircularArcs(pieces) {
  const p = normalizePieces(pieces);
  if (p.length === 0) return { full: false, arcs: [] };
  if (isFullCircle(p)) {
    return {
      full: true,
      arcs: [
        { startDeg: 0, endDeg: 0, wraps: false, widthDeg: FULL, full: true },
      ],
    };
  }
  const first = p[0];
  const last = p[p.length - 1];
  const arcs = [];
  if (first[0] <= EPS && last[1] >= FULL - EPS && p.length >= 2) {
    const width = FULL - last[0] + first[1];
    arcs.push({
      startDeg: last[0],
      endDeg: first[1],
      wraps: true,
      widthDeg: width,
    });
    for (let i = 1; i < p.length - 1; i++) {
      arcs.push({
        startDeg: p[i][0],
        endDeg: p[i][1],
        wraps: false,
        widthDeg: p[i][1] - p[i][0],
      });
    }
  } else {
    for (const seg of p) {
      arcs.push({
        startDeg: seg[0],
        endDeg: seg[1],
        wraps: false,
        widthDeg: seg[1] - seg[0],
      });
    }
  }
  // 统一按起点角度排序输出
  arcs.sort((x, y) => x.startDeg - y.startDeg);
  return { full: false, arcs };
}

/** 圆上两点最短角距离。 */
function circDistDeg(a, b) {
  const d = Math.abs(mod(a - b, FULL));
  return Math.min(d, FULL - d);
}

/** 取一个规格的禁用边界点（角度，模 360 去重）。 */
function forbiddenBoundaryDeg(result) {
  const pts = [];
  for (const f of result.forbiddenMerged || []) {
    for (const p of [f.startDeg, f.endDeg]) {
      const q = mod(p, FULL);
      if (!pts.some((x) => Math.abs(x - q) <= EPS || Math.abs(x - q) >= FULL - EPS)) {
        pts.push(q);
      }
    }
  }
  return pts;
}

/** θ 到某规格最近禁用边界的角距离；该规格无禁用区时为 Infinity。 */
function gapForSpec(deg, result) {
  const pts = forbiddenBoundaryDeg(result);
  if (pts.length === 0) return Infinity;
  return pts.reduce((best, p) => Math.min(best, circDistDeg(deg, p)), Infinity);
}

/**
 * 构造首次归零说明。
 * @param {object} spec 当前规格 {index, circumference, result}
 * @param {Array<[number,number]>} prior 与此规格求交前的公共可行片段
 * @param {Array<[number,number]>} forbidden 当前规格的禁用片段
 */
function buildBlocker(spec, prior, forbidden) {
  const overlapPieces = intersectPieces([prior, forbidden]);
  const blocking = forbidden.filter(([a, b]) =>
    prior.some(([pa, pb]) => b > pa + EPS && a < pb - EPS)
  );
  return {
    index: spec.index,
    circumference: spec.circumference,
    priorCommon: toCircularArcs(prior).arcs,
    blockingForbidden: blocking.map(([a, b]) => ({ startDeg: a, endDeg: b })),
    conflictSegments: toCircularArcs(overlapPieces).arcs,
  };
}

/* ---------------- 最小违约备选 ---------------- */

/**
 * 各规格合并禁用片段 → 圆周禁用弧（{startDeg,endDeg,wraps,widthDeg,full?}）。
 * 与 toCircularArcs 不同：这里输入可能是 [[0,360]] 整圈，需保留 full 标记。
 */
function forbiddenArcsOfSets(forbiddenSets) {
  return forbiddenSets.map((pieces) => {
    if (isFullCircle(pieces)) {
      return [{ startDeg: 0, endDeg: 0, wraps: false, widthDeg: FULL, full: true }];
    }
    return toCircularArcs(pieces).arcs;
  });
}

/** 角度 deg（[0,360]）是否在禁用弧内（含边界，圆上比较）。 */
function arcContainsDeg(arc, deg) {
  if (arc.full) return true;
  if (arc.wraps) return deg >= arc.startDeg - EPS || deg <= arc.endDeg + EPS;
  return deg >= arc.startDeg - EPS && deg <= arc.endDeg + EPS;
}

/**
 * 取禁用弧在提升坐标（含 −360/0/+360 三个周期副本）中包含点 x 的实例 [A,B]。
 * 跨零弧的单周期实例为 [startDeg, endDeg+360]；无命中返回 null。
 */
function liftArcInstance(arc, x) {
  if (arc.full) return null;
  const instances = [];
  if (arc.wraps) {
    for (let k = -1; k <= 1; k++) {
      instances.push([arc.startDeg + k * FULL, arc.endDeg + (k + 1) * FULL]);
    }
  } else {
    for (let k = -1; k <= 1; k++) {
      instances.push([arc.startDeg + k * FULL, arc.endDeg + k * FULL]);
    }
  }
  return instances.find(([a, b]) => x >= a - EPS && x <= b + EPS) || null;
}

/**
 * 角度 θ 对单规格禁用弧集的侵入深度：从 θ 沿圆周走出该规格禁用区所需的
 * 最小角距离（到所含禁用弧近端出口的距离）。落在安全处为 0；整圈禁用恒为
 * 180°（圆上任一点到出口的最远距离上限）。
 */
function intrusionForSpec(deg, arcs) {
  let depth = 0;
  for (const arc of arcs) {
    if (arc.full) return FULL / 2;
    if (!arcContainsDeg(arc, deg)) continue;
    const inst = liftArcInstance(arc, deg);
    let d = 0;
    if (inst) d = Math.min(deg - inst[0], inst[1] - deg);
    if (d > depth) depth = d;
  }
  return Math.max(0, Math.min(depth, FULL / 2));
}

/** 禁用弧“最深入点”（帐篷顶点）在提升区间 [lo,hi] 内的角度；否则 null。 */
function arcPeakLifted(arc, lo, hi) {
  if (arc.full) return null;
  const inst = liftArcInstance(arc, (lo + hi) / 2);
  if (!inst) return null;
  const p = (inst[0] + inst[1]) / 2;
  return p >= lo - EPS && p <= hi + EPS ? p : null;
}

/**
 * 禁用弧在提升子区间（已按顶点切分，弧内深度为单一直线）上的侵入深度直线。
 * 非整圈弧内深度为到近端出口的距离，斜率 +1（x−A）或 −1（B−x）；
 * 整圈弧为常量 180。
 * @returns {{slope:number, intercept:number}}
 */
function depthLineOnLift(arc, lo) {
  if (arc.full) return { slope: 0, intercept: FULL / 2 };
  const [a, b] = liftArcInstance(arc, lo + EPS);
  if (lo < (a + b) / 2 - EPS) return { slope: 1, intercept: -a };
  return { slope: -1, intercept: b };
}

/** 备选候选比较：最大侵入最小优先，并列比总侵入，再并列取较小角度。 */
function betterFallback(curr, cand) {
  if (cand.maxDepth < curr.maxDepth - EPS) return true;
  if (cand.maxDepth > curr.maxDepth + EPS) return false;
  if (cand.totalDepth < curr.totalDepth - EPS) return true;
  if (cand.totalDepth > curr.totalDepth + EPS) return false;
  return cand.deg < curr.deg - EPS;
}

/** 评估一组角度并返回最优备选（null 表示候选为空）。 */
function pickFallback(candidates, specArcs, specs, detentIndexOf) {
  let best = null;
  for (const degRaw of candidates) {
    const deg = mod(degRaw, FULL);
    const intrusions = specArcs.map((arcs, k) => ({
      index: specs[k].index,
      circumference: specs[k].circumference,
      intrusionDeg: intrusionForSpec(deg, arcs),
      mm: (deg / FULL) * specs[k].circumference,
    }));
    const maxDepth = intrusions.reduce((m, x) => Math.max(m, x.intrusionDeg), 0);
    const totalDepth = intrusions.reduce((s, x) => s + x.intrusionDeg, 0);
    const cand = {
      deg,
      maxDepth,
      totalDepth,
      intrusions,
      detentIndex: detentIndexOf ? detentIndexOf(deg) : null,
    };
    if (!best || betterFallback(best, cand)) best = cand;
  }
  return best;
}

/**
 * 连续角度域：按各规格禁用弧边界（0/360、各弧端点）切分整圆为原子区间，
 * 再用每条覆盖弧的最深入点把原子区间切成“深度函数均为直线”的子区间。
 * 各规格侵入深度的最大值（上包络）的最小点必落在子区间端点或某两条
 * 上升/下降直线的交点；总侵入为线性，其区间最小也在端点。枚举这些点
 * 即可得到“最大侵入最小、并列总侵入最小、再并列角度最小”的备选角度。
 */
function fallbackFromArcs(specArcs, specs) {
  const cuts = new Set([0]);
  for (const arcs of specArcs) {
    for (const arc of arcs) {
      if (arc.full) continue;
      cuts.add(mod(arc.startDeg, FULL));
      cuts.add(mod(arc.endDeg, FULL));
    }
  }
  const sortedCuts = [...cuts].sort((a, b) => a - b);

  const candidates = new Set();
  candidates.add(0); // 接缝点

  for (let i = 0; i < sortedCuts.length; i++) {
    const lo = sortedCuts[i];
    const hi = sortedCuts[(i + 1) % sortedCuts.length] + (i + 1 === sortedCuts.length ? FULL : 0);
    if (hi - lo <= EPS) continue;
    const mid = mod((lo + hi) / 2, FULL);

    // 覆盖该原子区间（除端点）的禁用弧
    const covering = [];
    specArcs.forEach((arcs, k) => {
      const arc = arcs.find((a) => arcContainsDeg(a, mid));
      if (arc) covering.push({ arc, specIndex: k });
    });

    // 用覆盖弧的最深入点切分子区间
    const subs = new Set([lo, hi]);
    for (const { arc } of covering) {
      const p = arcPeakLifted(arc, lo, hi);
      if (p !== null && p > lo + EPS && p < hi - EPS) subs.add(p);
    }
    const subCuts = [...subs].sort((a, b) => a - b);

    for (let j = 0; j < subCuts.length - 1; j++) {
      const s0 = subCuts[j];
      const s1 = subCuts[j + 1];
      if (s1 - s0 <= EPS) continue;
      candidates.add(mod(s0, FULL));
      candidates.add(mod(s1, FULL));
      const lines = covering.map(({ arc }) => depthLineOnLift(arc, s0));

      // 任意上升直线与下降直线在子区间内的交点（上包络谷点候选）
      for (let a = 0; a < lines.length; a++) {
        for (let b = a + 1; b < lines.length; b++) {
          const la = lines[a];
          const lb = lines[b];
          if (la.slope * lb.slope >= 0) continue; // 常量/同向直线由端点覆盖
          // x = (lb.b − la.b) / (la.m − lb.m)，其中直线为 m·x + b
          const x =
            (lb.intercept - la.intercept) / (la.slope - lb.slope);
          if (x > s0 + EPS && x < s1 - EPS) candidates.add(mod(x, FULL));
        }
      }
    }
  }

  return pickFallback([...candidates], specArcs, specs, null);
}

/** 构造无共同解时的“最小违约备选”说明。 */
function buildFallbackReason(blocker, detentsEnabled) {
  const scope = detentsEnabled
    ? '（已启用设备档位约束，仅在档位角度中求解）'
    : '';
  if (
    blocker.blockingForbidden.length === 1 &&
    blocker.blockingForbidden[0].startDeg <= EPS &&
    blocker.blockingForbidden[0].endDeg >= FULL - EPS
  ) {
    return `规格 ${blocker.index + 1} 的禁用区覆盖整圈，公共可行段为空${scope}；` +
      '已按“最大侵入深度最小 → 总侵入深度最小 → 较小角度”选出备选角度。';
  }
  return `规格 ${blocker.index + 1} 使公共可行角度首次归零，公共可行段为空${scope}；` +
    '已按“最大侵入深度最小 → 总侵入深度最小 → 较小角度”选出备选角度。';
}

/**
 * 最小违约备选主入口：公共可行段为空时调用。
 * 按字典序（最大侵入深度 → 总侵入深度 → 较小角度）选角；
 * 启用档位时只在档位角度中评估。
 * @param {Array<object>} specs computeMultiSpec 内的 {index,circumference,result}
 * @param {Array<Array<[number,number]>>} forbiddenSets 各规格归一化禁用片段
 * @param {object|null} detentCfg parseDetents 结果
 * @param {object} blocker 首次归零说明
 */
function computeMinViolationFallback(specs, forbiddenSets, detentCfg, blocker) {
  const specArcs = forbiddenArcsOfSets(forbiddenSets);

  let chosen;
  let positions = null;
  if (detentCfg && detentCfg.enabled) {
    positions = detentPositions(detentCfg);
    const indexByDeg = (deg) =>
      positions.findIndex((p) => Math.abs(p - deg) <= EPS);
    chosen = pickFallback(positions, specArcs, specs, indexByDeg);
  } else {
    chosen = fallbackFromArcs(specArcs, specs);
  }

  return {
    deg: chosen.deg,
    detentIndex: chosen.detentIndex,
    maxIntrusionDeg: chosen.maxDepth,
    totalIntrusionDeg: chosen.totalDepth,
    intrusions: chosen.intrusions,
    positions,
    reason: buildFallbackReason(blocker, !!(detentCfg && detentCfg.enabled)),
  };
}

/**
 * 多规格共用角度主入口。
 * @param {number[]} circumferences 2～8 个周长 (mm)
 * @param {number} seamWidth 共用接缝安全宽度 (mm)
 * @param {Array<{start:number,end:number}>} zones 共用印刷保护区 (mm)
 * @param {object} [detentsOpt] 设备档位约束
 *        {enabled:boolean, steps?:2～360 整数, offsetDeg?:number}
 * @param {object} [routeOpt] 调机旋转路径 {fromDeg, toDeg}（角度，按整圈归一）；
 *        基于共用安全段（启用档位时还要求两端落在可用档位上）规划单向连续旋转路径
 * @param {object} [toleranceOpt] 安装误差 {ccwDeg, cwDeg}（非负有限角度）；
 *        给出时基于共用安全段输出可靠角度段；缺省时响应不含 tolerance 字段
 */
function computeMultiSpec(circumferences, seamWidth, zones, detentsOpt, routeOpt, toleranceOpt) {
  if (
    !Array.isArray(circumferences) ||
    circumferences.length < MIN_SPECS ||
    circumferences.length > MAX_SPECS
  ) {
    throw new RangeError(
      `circumferences 必须为含 ${MIN_SPECS}～${MAX_SPECS} 个周长的数组`
    );
  }
  const detentCfg = parseDetents(detentsOpt);

  const specs = circumferences.map((C, index) => ({
    index,
    circumference: C,
    result: computeSeamAvoidance(C, seamWidth, zones),
  }));
  const feasibleSets = specs.map((s) => feasibleDegPieces(s.result));
  const forbiddenSets = specs.map((s) => forbiddenDegPieces(s.result));

  // 按输入顺序累计交集，定位使公共交集首次归零的规格
  let acc = [[0, FULL]];
  let blocker = null;
  for (const spec of specs) {
    const next = intersectPieces([acc, feasibleSets[spec.index]]);
    if (next.length === 0) {
      blocker = buildBlocker(spec, acc, forbiddenSets[spec.index]);
      break;
    }
    acc = next;
  }

  const common = blocker ? [] : toCircularArcs(acc).arcs;
  const fullCircle = !blocker && isFullCircle(acc);

  let best = null;
  let detents = detentCfg.enabled
    ? {
        enabled: true,
        steps: detentCfg.steps,
        offsetDeg: detentCfg.offsetDeg,
        stepDeg: FULL / detentCfg.steps,
        positions: Array.from(
          { length: detentCfg.steps },
          (_, k) => mod(detentCfg.offsetDeg + (k * FULL) / detentCfg.steps, FULL)
        ).sort((a, b) => a - b),
        available: [],
        best: null,
        noAvailable: false,
        nearest: [],
      }
    : { enabled: false };
  if (!blocker) {
    const gapsAt = (deg) =>
      specs.map((s) => {
        const gap = gapForSpec(deg, s.result);
        return {
          index: s.index,
          circumference: s.circumference,
          gapDeg: Number.isFinite(gap) ? gap : null, // null：该规格无禁用边界
          mm: (deg / FULL) * s.circumference,
        };
      });

    // 瓶颈间隙：各规格到禁用边界距离的最小值；全部规格均无禁用区时为 null（无约束）
    const minGapOfGaps = (gaps) => {
      const finite = gaps.filter((g) => g.gapDeg !== null);
      return finite.length
        ? finite.reduce((m, g) => (g.gapDeg < m ? g.gapDeg : m), Infinity)
        : null;
    };
    const minGapSpecOfGaps = (gaps, minGap) => {
      let idx = null;
      for (const g of gaps) {
        if (g.gapDeg !== null && g.gapDeg <= minGap + EPS && (idx === null || g.index < idx)) {
          idx = g.index;
        }
      }
      return idx;
    };

    if (detentCfg.enabled) {
      // 档位与共用段相交；默认档位沿用“瓶颈间隙最大、角度较小优先”
      const analysis = analyzeDetents(
        detentCfg,
        common,
        (deg) => minGapOfGaps(gapsAt(deg)),
        gapsAt
      );
      detents = {
        enabled: true,
        steps: analysis.steps,
        offsetDeg: analysis.offsetDeg,
        stepDeg: analysis.stepDeg,
        positions: analysis.positions,
        available: analysis.available.map((c) => ({
          index: c.index,
          deg: c.deg,
          minGapDeg: c.minGapDeg,
          gaps: c.detail,
        })),
        best: null,
        noAvailable: analysis.noAvailable,
        nearest: analysis.nearest,
      };
      if (analysis.best) {
        const win = analysis.best;
        detents.best = {
          index: win.index,
          deg: win.deg,
          minGapDeg: win.minGapDeg,
          minGapSpecIndex:
            win.minGapDeg === null ? null : minGapSpecOfGaps(win.detail, win.minGapDeg),
          gaps: win.detail,
        };
        best = {
          deg: win.deg,
          minGapDeg: win.minGapDeg,
          minGapSpecIndex: detents.best.minGapSpecIndex,
          gaps: win.detail,
          detentIndex: win.index,
        };
      }
      // noAvailable（连续有解但无可用档位）时 best 保持 null
    } else if (fullCircle) {
      // 所有规格均无禁用区：整圈等距，按“角度最小”取 0
      best = {
        deg: 0,
        minGapDeg: null,
        minGapSpecIndex: null,
        gaps: gapsAt(0),
      };
    } else {
      // 每条公共弧的中点为该弧上最小间隙最大点；弧越宽中点越优
      const candidates = common.map((arc) => {
        const endLifted = arc.wraps ? arc.endDeg + FULL : arc.endDeg;
        const deg = mod((arc.startDeg + endLifted) / 2, FULL);
        const gaps = gapsAt(deg);
        return { deg, minGap: minGapOfGaps(gaps), gaps, width: arc.widthDeg };
      });
      candidates.sort((x, y) => {
        if (x.minGap === null) return y.minGap === null ? x.deg - y.deg : -1;
        if (y.minGap === null) return 1;
        if (Math.abs(x.minGap - y.minGap) > EPS) return y.minGap - x.minGap;
        return x.deg - y.deg;
      });
      const win = candidates[0];
      best = {
        deg: win.deg,
        minGapDeg: win.minGap,
        minGapSpecIndex: win.minGap === null ? null : minGapSpecOfGaps(win.gaps, win.minGap),
        gaps: win.gaps,
      };
    }
  }

  // 公共可行段为空：计算“最小违约备选”（启用档位时仅在档位角度中求解）
  const fallback = blocker
    ? computeMinViolationFallback(specs, forbiddenSets, detentCfg, blocker)
    : null;

  // 调机旋转路径规划（可选）：基于共用安全段与可用档位判断两端并选出较短单向路径
  let route = null;
  if (routeOpt !== undefined && routeOpt !== null) {
    route = planRoute(
      routeOpt.fromDeg,
      routeOpt.toDeg,
      common,
      detentCfg.enabled ? { available: detents.available } : null
    );
  }

  const result = {
    mode: 'multi',
    seamWidth,
    specs,
    common,
    fullCircle,
    best,
    noSolution: blocker !== null,
    blocker,
    fallback,
    detents,
    route,
  };

  // 安装误差分析（可选，独立于原有结果）：复用共用安全段收缩出可靠角度段
  const tolCfg = parseTolerance(toleranceOpt);
  if (tolCfg.enabled) {
    const rel = computeReliableArcs(common, tolCfg.ccwDeg, tolCfg.cwDeg);
    // 落在可靠段内（含边界/单点）的档位；可靠段为空与“有段无档位”分别标记
    let tolDetents = null;
    if (detentCfg.enabled) {
      const available = (detents.available || []).filter((d) =>
        degInReliable(rel.arcs, d.deg)
      );
      tolDetents = {
        available,
        noAvailable: !rel.empty && available.length === 0,
      };
    }
    result.tolerance = {
      ccwDeg: tolCfg.ccwDeg,
      cwDeg: tolCfg.cwDeg,
      totalDeg: tolCfg.ccwDeg + tolCfg.cwDeg,
      full: rel.full,
      empty: rel.empty,
      arcs: rel.arcs,
      detents: tolDetents,
    };
  }

  return result;
}

module.exports = {
  EPS,
  MIN_SPECS,
  MAX_SPECS,
  mod,
  feasibleDegPieces,
  forbiddenDegPieces,
  intersectPieces,
  toCircularArcs,
  circDistDeg,
  gapForSpec,
  forbiddenArcsOfSets,
  arcContainsDeg,
  intrusionForSpec,
  computeMinViolationFallback,
  computeMultiSpec,
};
