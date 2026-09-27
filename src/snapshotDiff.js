'use strict';

/**
 * 方案快照差异比较（UMD：Node 单测与浏览器前端共用）。
 *
 * 两个快照的周长可能不同，因此全部按“角度”在圆周 [0°, 360°) 上比较：
 *  - added / removed：以 B 相对 A 的覆盖集对称差给出新增、移除的圆周区间；
 *  - common：两者共有的覆盖区间（Canvas 上灰底）；
 *  - moves：按重叠最大贪心配对的对应段，给出起点/终点沿最短圆弧的有向位移。
 *
 * 输入段均为“沿正向延伸的线性段”，允许 end 超过 360（跨零点），长度不超过 360。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SnapshotDiff = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FULL = 360;
  const EPS = 1e-7; // 角度比较容差
  const MOVE_EPS = 1e-6; // 小于该角度的边界位移视为未移动

  function mod(n, m) {
    return ((n % m) + m) % m;
  }

  /** 从 from 到 to 的最短圆弧有向角度，范围 (-180, 180]，正为顺时针。 */
  function signedDegDelta(from, to) {
    let d = mod(to - from, FULL);
    if (d > 180) d -= FULL;
    return d;
  }

  /** 合并 [0,360] 内重叠/相邻的线性区间；若覆盖整圈则返回 {full:true}。 */
  function unionMergeDeg(intervals) {
    const sorted = intervals
      .filter(([a, b]) => b - a > EPS)
      .map(([a, b]) => [Math.max(0, Math.min(FULL, a)), Math.max(0, Math.min(FULL, b))])
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
    if (merged.length === 1 && merged[0][0] <= EPS && merged[0][1] >= FULL - EPS) {
      return { full: true, segs: [[0, FULL]] };
    }
    return { full: false, segs: merged };
  }

  /**
   * 归一化线性角度段为 [0,360] 内的合并区间集。
   * 段沿正向延伸：可用 widthDeg 直接给宽（整圈可行段 startDeg=endDeg=0、widthDeg=360），
   * 否则用 (wraps ? endDeg+360 : endDeg) - startDeg 求宽，允许跨零点。
   * @param {Array<{startDeg:number, endDeg:number, wraps?:boolean, widthDeg?:number}>} segs
   */
  function normalizeDegSegments(segs) {
    const pieces = [];
    let full = false;
    for (const g of segs) {
      const start = g.startDeg;
      const width =
        g.widthDeg !== undefined
          ? g.widthDeg
          : (g.wraps ? g.endDeg + FULL : g.endDeg) - start;
      if (width <= EPS) continue;
      if (width >= FULL - EPS) {
        full = true;
        continue;
      }
      const a = mod(start, FULL);
      const b = a + width;
      if (b >= FULL - EPS) {
        pieces.push([a, FULL]);
        if (b > FULL + EPS) pieces.push([0, b - FULL]);
      } else {
        pieces.push([a, b]);
      }
    }
    if (full) return { full: true, segs: [[0, FULL]] };
    return unionMergeDeg(pieces);
  }

  function complementDeg(segs) {
    const out = [];
    let cur = 0;
    for (const [a, b] of segs) {
      if (a > cur + EPS) out.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (FULL > cur + EPS) out.push([cur, FULL]);
    return out;
  }

  function insideAny(segs, x) {
    return segs.some(([a, b]) => x >= a - EPS && x <= b + EPS);
  }

  /** 覆盖集比较：切分原子区间，输出 common / added / removed。 */
  function coverageDiff(A, B) {
    if (A.full && B.full) {
      return { common: [[0, FULL]], added: [], removed: [] };
    }
    if (A.full) {
      return { common: B.segs.slice(), added: [], removed: complementDeg(B.segs) };
    }
    if (B.full) {
      return { common: A.segs.slice(), added: complementDeg(A.segs), removed: [] };
    }

    const points = [0, FULL];
    for (const [a, b] of A.segs.concat(B.segs)) {
      points.push(a, b);
    }
    points.sort((x, y) => x - y);
    const cuts = [];
    for (const p of points) {
      const last = cuts[cuts.length - 1];
      if (last === undefined || p - last > EPS) cuts.push(p);
    }

    const buckets = { common: [], added: [], removed: [] };
    for (let i = 0; i < cuts.length - 1; i++) {
      const x0 = cuts[i];
      const x1 = cuts[i + 1];
      if (x1 - x0 <= EPS) continue;
      const mid = (x0 + x1) / 2;
      const inA = insideAny(A.segs, mid);
      const inB = insideAny(B.segs, mid);
      if (inA && inB) buckets.common.push([x0, x1]);
      else if (inB) buckets.added.push([x0, x1]);
      else if (inA) buckets.removed.push([x0, x1]);
    }
    return {
      common: unionMergeDeg(buckets.common).segs,
      added: unionMergeDeg(buckets.added).segs,
      removed: unionMergeDeg(buckets.removed).segs,
    };
  }

  /** 按重叠长度贪心配对段对（一对一），用于边界移动判定。 */
  function matchSegments(aSegs, bSegs) {
    const pairs = [];
    aSegs.forEach((sa, i) => {
      bSegs.forEach((sb, j) => {
        const lo = Math.max(sa[0], sb[0]);
        const hi = Math.min(sa[1], sb[1]);
        if (hi - lo > EPS) pairs.push({ i, j, overlap: hi - lo });
      });
    });
    pairs.sort((p, q) => q.overlap - p.overlap);
    const usedA = new Set();
    const usedB = new Set();
    const matches = [];
    for (const p of pairs) {
      if (usedA.has(p.i) || usedB.has(p.j)) continue;
      usedA.add(p.i);
      usedB.add(p.j);
      matches.push({ a: aSegs[p.i], b: bSegs[p.j] });
    }
    return matches;
  }

  /** 比较两个同类型段集（均为 {full, segs}）。 */
  function compareSets(A, B) {
    const cov = coverageDiff(A, B);
    const moves = [];
    if (!A.full && !B.full) {
      for (const { a, b } of matchSegments(A.segs, B.segs)) {
        const startDelta = signedDegDelta(a[0], b[0]);
        const endDelta = signedDegDelta(a[1], b[1]);
        if (Math.abs(startDelta) <= MOVE_EPS && Math.abs(endDelta) <= MOVE_EPS) continue;
        moves.push({
          aSeg: a,
          bSeg: b,
          startDelta: Math.abs(startDelta) <= MOVE_EPS ? null : startDelta,
          endDelta: Math.abs(endDelta) <= MOVE_EPS ? null : endDelta,
        });
      }
    }
    return { common: cov.common, added: cov.added, removed: cov.removed, moves };
  }

  /** 从快照存储结构中提取三类角度段集。 */
  function extractSnapshotSegments(snap) {
    const r = (snap && snap.result) || {};
    const zoneSegs = [];
    for (const pieces of r.zonePieces || []) {
      for (const p of pieces) zoneSegs.push({ startDeg: p.startDeg, endDeg: p.endDeg });
    }
    const zones = normalizeDegSegments(zoneSegs);
    const forbidden = normalizeDegSegments(
      (r.forbiddenMerged || []).map((s) => ({ startDeg: s.startDeg, endDeg: s.endDeg }))
    );
    const feasible = r.noSolution
      ? { full: false, segs: [] }
      : normalizeDegSegments(
          (r.feasible || []).map((s) => ({
            startDeg: s.startDeg,
            endDeg: s.endDeg,
            widthDeg: s.widthDeg !== undefined ? s.widthDeg : undefined,
            wraps: s.wraps,
          }))
        );
    return { zones, forbidden, feasible };
  }

  function snapshotMeta(snap, tag) {
    const input = snap.input || {};
    return {
      tag,
      id: snap.id,
      name: snap.name,
      createdAt: snap.createdAt,
      circumference: input.circumference,
      seamWidth: input.seamWidth,
      zoneCount: Array.isArray(input.zones) ? input.zones.length : 0,
      noSolution: !!(snap.result && snap.result.noSolution),
    };
  }

  /**
   * 比较两个快照。a 为基准（A），b 为对比（B）；差异方向 A → B。
   * @returns {{a:object, b:object, zones:object, forbidden:object, feasible:object}}
   */
  function diffSnapshots(a, b) {
    const sa = extractSnapshotSegments(a);
    const sb = extractSnapshotSegments(b);
    return {
      a: snapshotMeta(a, 'A'),
      b: snapshotMeta(b, 'B'),
      zones: compareSets(sa.zones, sb.zones),
      forbidden: compareSets(sa.forbidden, sb.forbidden),
      feasible: compareSets(sa.feasible, sb.feasible),
    };
  }

  return {
    EPS,
    mod,
    signedDegDelta,
    unionMergeDeg,
    normalizeDegSegments,
    complementDeg,
    compareSets,
    extractSnapshotSegments,
    diffSnapshots,
  };
});
