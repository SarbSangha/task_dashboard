// Minimal browser surface so module-scope code in the app's imports can
// evaluate under Node. Evaluated before AuthContext via import order.
const store = new Map();
const storage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
class FakeWS { constructor() { this.readyState = 0; } close() {} send() {} addEventListener() {} }
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
const g = globalThis;
g.window = g;
g.self = g;
g.localStorage = storage;
g.sessionStorage = storage;
g.WebSocket = FakeWS;
g.document = {
  visibilityState: 'visible',
  addEventListener() {}, removeEventListener() {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} }, body: { style: {}, appendChild() {} },
  documentElement: { style: {}, classList: { add() {}, remove() {} } },
  cookie: '',
};
try {
  Object.defineProperty(g, 'navigator', {
    value: { userAgent: 'node', onLine: true, serviceWorker: undefined },
    configurable: true, writable: true,
  });
} catch { /* Node 24 defines navigator as a getter; the built-in is fine */ }
try {
  Object.defineProperty(g, 'location', {
    value: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', protocol: 'http:', host: 'localhost' },
    configurable: true, writable: true,
  });
} catch { /* ignore */ }
g.addEventListener = () => {}; g.removeEventListener = () => {};
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.requestIdleCallback = (fn) => setTimeout(fn, 0);
g.cancelIdleCallback = (id) => clearTimeout(id);
