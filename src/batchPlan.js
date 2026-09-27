'use strict';

/**
 * 批次换版计划算法。
 *
 * 按固定生产顺序输入 2～8 个工单（各自筒体周长、接缝安全宽度、毫米制保护区），
 * 全批共用同一台设备：每圈档位数 N（2～72）、零位偏移 o 与初始角度 θ₀。
 *
 * 逐单复用现有单规格计算（computeSeamAvoidance，启用设备档位约束）得到各单的
 * 可用档位；换版发生在工单之间，因此只要求各工单的停机角度落在该单的安全段内
 * （即该单可用档位上），旋转过程不经过其他工单，安全段不限制换版路径。
 *
 * 成本定义（均为圆周最短角距离）：
 *   - 首单：初始角度 θ₀ → 首单停机档位；
 *   - 之后：上一单停机档位 → 本单停机档位。
 * 用动态规划求整批总转角最小的档位序列；总成本相同时取“档位序号序列字典序
 * 最小”者（档位序号为角度升序 0 起的设备档位号，各单一致）。
 *
 * 无可用档位时按工单顺序报告首个失败工单，并区分：
 *   - 'full-circle-no-solution'：该单保护区（含接缝扩展）覆盖整圈，连续域即无解；
 *   - 'detents-none-available'：该单连续安全段非空，但没有任何档位落在安全段内。
 */

const { computeSeamAvoidance } = require('./seamMath');
const { parseDetents, detentPositions, circDistDeg } = require('./detents');

const FULL = 360;
const MIN_ORDERS = 2;
const MAX_ORDERS = 8;
const BATCH_MIN_STEPS = 2;
const BATCH_MAX_STEPS = 72;
const EPS = 1e-9; // 总成本比较容差

function mod(n, m) {
  return ((n % m) + m) % m;
}

/**
 * 由相邻两个角度构造一次“换版”（初始角度 → 首单也算一次对首单的旋转）：
 * 圆周最短角距离为转角；两个方向等长（含起终点相同的 0°）取顺时针。
 */
function buildChange(fromDeg, toDeg) {
  const from = mod(fromDeg, FULL);
  const to = mod(toDeg, FULL);
  const cw = mod(to - from, FULL);
  const ccw = mod(from - to, FULL);
  const direction = cw <= ccw + EPS ? 'cw' : 'ccw';
  const sweepDeg = direction === 'cw' ? cw : ccw;
  return {
    fromDeg: from,
    toDeg: to,
    direction,
    directionLabel: direction === 'cw' ? '顺时针' : '逆时针',
    sweepDeg,
    samePoint: Math.abs(cw) <= EPS && Math.abs(ccw) <= EPS,
  };
}

/**
 * 批次换版计划主入口。
 * @param {Array<{circumference:number, seamWidth:number, zones:Array}>} orders
 *        2～8 个工单（顺序即生产顺序），每单各自周长/接缝宽/保护区
 * @param {object} detents 共用设备档位 {enabled:true, steps:2～72 整数, offsetDeg?}
 * @param {number} [initialDeg=0] 初始角度（°，任意数值，按整圈归一）
 */
function computeBatchPlan(orders, detents, initialDeg) {
  if (
    !Array.isArray(orders) ||
    orders.length < MIN_ORDERS ||
    orders.length > MAX_ORDERS
  ) {
    throw new RangeError(
      `orders 必须为含 ${MIN_ORDERS}～${MAX_ORDERS} 个工单的数组`
    );
  }
  if (
    !detents ||
    typeof detents !== 'object' ||
    Array.isArray(detents) ||
    !detents.enabled
  ) {
    throw new TypeError('批次换版计划必须启用设备档位约束 {enabled:true, steps, offsetDeg?}');
  }
  const rawSteps = detents.steps;
  if (
    typeof rawSteps !== 'number' ||
    !Number.isFinite(rawSteps) ||
    !Number.isInteger(rawSteps) ||
    rawSteps < BATCH_MIN_STEPS ||
    rawSteps > BATCH_MAX_STEPS
  ) {
    throw new RangeError(
      `detents.steps 必须为 ${BATCH_MIN_STEPS}～${BATCH_MAX_STEPS} 的整数（共用设备每圈档位数）`
    );
  }
  const detentCfg = parseDetents(detents);
  const initDeg =
    initialDeg === undefined || initialDeg === null ? 0 : mod(initialDeg, FULL);

  // 全批共用同一套设备档位（序号按角度升序，0 起；各单档位角度完全一致）
  const positions = detentPositions(detentCfg);

  // 逐单复用单规格计算（启用同一档位约束），并定位首个失败工单
  const orderResults = orders.map((o, index) => {
    const result = computeSeamAvoidance(
      o.circumference,
      o.seamWidth,
      o.zones,
      { enabled: true, steps: detentCfg.steps, offsetDeg: detentCfg.offsetDeg }
    );
    let status = 'ok';
    if (result.noSolution) status = 'full-circle-no-solution';
    else if (result.detents.noAvailable) status = 'detents-none-available';
    return {
      index,
      circumference: o.circumference,
      seamWidth: o.seamWidth,
      zones: o.zones,
      status,
      available: result.detents.available, // [{index, deg, mm, gapDeg}]
      result,
    };
  });

  let failure = null;
  const firstBad = orderResults.find((o) => o.status !== 'ok');
  if (firstBad) {
    const fullCircle = firstBad.status === 'full-circle-no-solution';
    const reason = fullCircle
      ? `工单 ${firstBad.index + 1}（周长 ${firstBad.circumference} mm）的保护区（含接缝安全宽度扩展）覆盖整圈，连续角度域即无解，批次计划在该单终止。`
      : `工单 ${firstBad.index + 1}（周长 ${firstBad.circumference} mm）存在连续安全段，但没有任何共用设备档位落在该单安全段内（每圈 ${detentCfg.steps} 档、零位偏移 ${detentCfg.offsetDeg}°），批次计划在该单终止。`;
    failure = {
      index: firstBad.index,
      circumference: firstBad.circumference,
      type: firstBad.status, // 'full-circle-no-solution' | 'detents-none-available'
      fullCircleNoSolution: fullCircle,
      detentsNoneAvailable: !fullCircle,
      reason,
    };
  }

  const detentsView = {
    enabled: true,
    steps: detentCfg.steps,
    offsetDeg: detentCfg.offsetDeg,
    stepDeg: FULL / detentCfg.steps,
    positions,
  };

  if (failure) {
    return {
      mode: 'batch',
      detents: detentsView,
      initialDeg: initDeg,
      orders: orderResults,
      feasible: false,
      failure,
      plan: null,
      totalRotationDeg: null,
    };
  }

  /* ---------- 动态规划：总转角最小，并列取档位序号字典序最小 ----------
   * dp[i][k]：到达第 i 单第 k 个可用档位时的最小总成本，以及取得该成本的
   * 完整档位序号序列。转移时在“成本更低”或“成本相等且序列字典序更小”时更新；
   * 末单再按同样规则选出整批最优序列。
   */
  const avail = orderResults.map((o) => o.available);
  let frontier = avail[0].map((d) => ({
    index: d.index,
    deg: d.deg,
    cost: circDistDeg(initDeg, d.deg),
    seq: [d.index],
  }));

  for (let i = 1; i < orderResults.length; i++) {
    const next = [];
    for (const cand of avail[i]) {
      let bestState = null;
      for (const prev of frontier) {
        const cost = prev.cost + circDistDeg(prev.deg, cand.deg);
        const seq = [...prev.seq, cand.index];
        if (
          !bestState ||
          cost < bestState.cost - EPS ||
          (Math.abs(cost - bestState.cost) <= EPS && lexLess(seq, bestState.seq))
        ) {
          bestState = { index: cand.index, deg: cand.deg, cost, seq };
        }
      }
      next.push(bestState);
    }
    frontier = next;
  }

  // 末单中再取总成本最小、并列档位序号较小者
  let winner = null;
  for (const st of frontier) {
    if (
      !winner ||
      st.cost < winner.cost - EPS ||
      (Math.abs(st.cost - winner.cost) <= EPS && lexLess(st.seq, winner.seq))
    ) {
      winner = st;
    }
  }

  // 组装逐单停机档位与换版角度
  const stops = winner.seq.map((detentIndex, i) => {
    const d = avail[i].find((x) => x.index === detentIndex);
    return {
      orderIndex: i,
      detentIndex,
      deg: d.deg,
      mm: d.mm,
      gapDeg: d.gapDeg,
    };
  });
  const changes = [];
  changes.push({ index: 0, kind: 'initial', ...buildChange(initDeg, stops[0].deg) });
  for (let i = 1; i < stops.length; i++) {
    changes.push({
      index: i,
      kind: 'changeover',
      ...buildChange(stops[i - 1].deg, stops[i].deg),
    });
  }

  return {
    mode: 'batch',
    detents: detentsView,
    initialDeg: initDeg,
    orders: orderResults,
    feasible: true,
    failure: null,
    plan: {
      detentSequence: winner.seq,
      stops,
      changes,
    },
    totalRotationDeg: winner.cost,
  };
}

/** 等长数字序列字典序：a < b（按位置逐位比较）。 */
function lexLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

module.exports = {
  FULL,
  MIN_ORDERS,
  MAX_ORDERS,
  BATCH_MIN_STEPS,
  BATCH_MAX_STEPS,
  mod,
  buildChange,
  lexLess,
  computeBatchPlan,
};
