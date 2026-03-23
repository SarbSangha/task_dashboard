const taskPanelCache = new Map();

export const buildTaskPanelCacheKey = (userId, panelKey) => `user_${userId}_${panelKey}`;

export const getTaskPanelCache = (key, ttlMs) => {
  const entry = taskPanelCache.get(key);
  if (!entry) return null;
  if (typeof ttlMs === 'number' && ttlMs > 0) {
    const isExpired = Date.now() - entry.cachedAt > ttlMs;
    if (isExpired) {
      taskPanelCache.delete(key);
      return null;
    }
  }
  return entry.value;
};

export const getTaskPanelCacheEntry = (key, ttlMs) => {
  const entry = taskPanelCache.get(key);
  if (!entry) return null;
  if (typeof ttlMs === 'number' && ttlMs > 0) {
    const isExpired = Date.now() - entry.cachedAt > ttlMs;
    if (isExpired) {
      taskPanelCache.delete(key);
      return null;
    }
  }
  return entry;
};

export const setTaskPanelCache = (key, value) => {
  taskPanelCache.set(key, {
    value,
    cachedAt: Date.now(),
  });
};

export const invalidateTaskPanelCache = (key) => {
  taskPanelCache.delete(key);
};

export const invalidateTaskPanelCacheByPrefix = (prefix) => {
  Array.from(taskPanelCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) {
      taskPanelCache.delete(key);
    }
  });
};
