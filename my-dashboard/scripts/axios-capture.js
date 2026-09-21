// Replaces axios's transport BEFORE services/api.js is evaluated, so the
// instance it creates at module scope inherits this adapter and no request
// ever leaves the process. Import order matters: this must be imported
// before api.js.
import axios from 'axios';

export const captured = { last: null, all: [] };

axios.defaults.adapter = async (config) => {
  let data = {};
  try { data = JSON.parse(config.data || '{}'); } catch { data = config.data; }
  const entry = { url: config.url, method: config.method, data };
  captured.last = entry;
  captured.all.push(entry);
  return { data: { success: true, data: { id: 1 } }, status: 200, statusText: 'OK', headers: {}, config };
};
