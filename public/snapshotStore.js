'use strict';

/* 方案快照本地持久化（localStorage）。快照保存当前输入参数与计算结果。 */

(function (root) {
  'use strict';

  const KEY = 'seam-avoidance:snapshots:v1';
  const MAX_SNAPSHOTS = 100;

  function loadAll() {
    let list = [];
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch (e) {
      // 存储损坏时静默丢弃，避免阻塞主流程
      list = [];
    }
    return list;
  }

  function persist(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  /** 新建快照；返回 {ok, snapshot?, error?}。 */
  function createSnapshot(name, input, result) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, error: '请填写快照名称' };
    if (trimmed.length > 40) return { ok: false, error: '名称不超过 40 个字符' };
    if (!input || !result) return { ok: false, error: '当前没有可保存的计算结果' };

    const list = loadAll();
    if (list.length >= MAX_SNAPSHOTS) {
      return { ok: false, error: `最多保存 ${MAX_SNAPSHOTS} 个快照，请先删除` };
    }
    const snapshot = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      createdAt: new Date().toISOString(),
      input: {
        circumference: input.circumference,
        seamWidth: input.seamWidth,
        zones: (input.zones || []).map((z) => ({ start: z.start, end: z.end })),
        detents: input.detents || { enabled: false },
        tolerance: input.tolerance || null,
      },
      result,
    };
    list.push(snapshot);
    persist(list);
    return { ok: true, snapshot };
  }

  function getById(id) {
    return loadAll().find((s) => s.id === id) || null;
  }

  function remove(id) {
    const list = loadAll().filter((s) => s.id !== id);
    persist(list);
  }

  root.SnapshotStore = { loadAll, createSnapshot, remove, getById, MAX_SNAPSHOTS };
})(window);
