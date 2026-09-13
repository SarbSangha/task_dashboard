// Verifies the Magnific/Freepik auto-login tells a real captcha challenge /
// rate-limit lockout apart from the always-present passive reCAPTCHA v3 badge,
// so it halts on the former and stays out of the way on the latter. Extracts
// the pure detector pieces from content-freepik.js and drives
// detectActiveChallenge() against a minimal DOM shim.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'content-freepik.js'), 'utf8');
const start = src.indexOf('function normalizeText(');
const end = src.indexOf('async function enforceDashboardOnlyAccess()');
if (start < 0 || end < 0) {
  console.error('FAIL  could not locate the detector slice in content-freepik.js');
  process.exit(1);
}

const VIEWPORT = { innerWidth: 1280, innerHeight: 800 };

function rect(width, height, { x = 20, y = 20 } = {}) {
  return { width, height, left: x, top: y, right: x + width, bottom: y + height };
}

// Minimal element. `rectSpec` -> getBoundingClientRect; `badge` -> pretend the
// node sits inside .grecaptcha-badge for closest().
function makeEl(tag, { text = '', kids = [], src = '', rectSpec = rect(200, 40), badge = false } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    children: kids,
    src,
    getAttribute: (name) => (name === 'src' ? (src || null) : null),
    getBoundingClientRect: () => rectSpec,
    closest: (sel) => (badge && sel.includes('grecaptcha-badge') ? { className: 'grecaptcha-badge' } : null),
    parentElement: null,
  };
  return el;
}

function makeDocument({ bodyText = '', nodes = [], iframes = [] } = {}) {
  const matchIframe = (f, selector) => {
    const s = f.src || '';
    if (selector.includes('bframe')) return s.includes('bframe');
    if (selector.includes('anchor')) return s.includes('anchor');
    if (selector.includes('hcaptcha.com')) return s.includes('hcaptcha.com');
    if (selector.includes('challenges.cloudflare.com')) return s.includes('challenges.cloudflare.com');
    return false;
  };
  return {
    body: { innerText: bodyText },
    querySelectorAll: (selector) => (
      selector.includes('iframe')
        ? iframes.filter((f) => matchIframe(f, selector))
        : nodes
    ),
  };
}

let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

function runWith(doc) {
  const ctx = {
    document: doc,
    window: {
      ...VIEWPORT,
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    },
    console,
    String,
    Array,
    Number,
  };
  ctx.isVisible = () => true;
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);
  return ctx.detectActiveChallenge();
}

// --- must HALT --------------------------------------------------------------

check(
  'lockout notice halts',
  runWith(makeDocument({
    bodyText: 'Welcome to Magnific\nYou have failed to login 21 times. Please try again in 24 hours',
  })) !== '',
  true,
);

check(
  'too-many-attempts notice halts',
  runWith(makeDocument({ bodyText: 'Too many attempts. Your account is locked.' })) !== '',
  true,
);

check(
  'visible reCAPTCHA bframe challenge halts',
  runWith(makeDocument({
    bodyText: 'Log in',
    iframes: [makeEl('iframe', { src: 'https://www.google.com/recaptcha/api2/bframe?hl=en&k=x', rectSpec: rect(400, 580) })],
  })) !== '',
  true,
);

check(
  'interactive "I\'m not a robot" checkbox anchor halts',
  runWith(makeDocument({
    bodyText: 'Log in',
    iframes: [makeEl('iframe', { src: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=normal', rectSpec: rect(300, 78) })],
  })) !== '',
  true,
);

check(
  '"I\'m not a robot" label text halts',
  runWith(makeDocument({ bodyText: 'x', nodes: [makeEl('label', { text: "I'm not a robot" })] })) !== '',
  true,
);

// --- must NOT halt (the reported false positive) ---------------------------

check(
  'passive reCAPTCHA v3 badge anchor does NOT halt (size=invisible)',
  runWith(makeDocument({
    bodyText: 'Log in\nEmail\nPassword\nprotected by reCAPTCHA',
    iframes: [makeEl('iframe', {
      src: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=x&size=invisible&cb=abc',
      rectSpec: rect(256, 60),
    })],
  })),
  '',
);

check(
  'anchor inside .grecaptcha-badge does NOT halt even without size param',
  runWith(makeDocument({
    bodyText: 'Log in',
    iframes: [makeEl('iframe', { src: 'https://www.google.com/recaptcha/api2/anchor?k=x', rectSpec: rect(256, 60), badge: true })],
  })),
  '',
);

check(
  'reported screenshot - badge + email format error - does NOT halt',
  runWith(makeDocument({
    bodyText: 'Log in\nEmail\nPlease enter your email address using the format name@example.com\nPassword\nStay logged in\nLog in\nCookies Settings\nprotected by reCAPTCHA',
    nodes: [
      makeEl('span', { text: 'Please enter your email address using the format name@example.com' }),
      makeEl('span', { text: 'protected by reCAPTCHA' }),
    ],
    iframes: [makeEl('iframe', {
      src: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=x&size=invisible',
      rectSpec: rect(256, 60),
    })],
  })),
  '',
);

check(
  'hidden bframe (opacity 0 wrapper) does NOT halt',
  (() => {
    const frame = makeEl('iframe', { src: 'https://www.google.com/recaptcha/api2/bframe?k=x', rectSpec: rect(400, 580) });
    const hiddenWrap = { getBoundingClientRect: () => rect(400, 580), parentElement: null, __opacity: '0' };
    frame.parentElement = hiddenWrap;
    const doc = makeDocument({ bodyText: 'Log in', iframes: [frame] });
    const ctx = {
      document: doc,
      window: {
        ...VIEWPORT,
        getComputedStyle: (node) => ({
          visibility: node === hiddenWrap ? 'hidden' : 'visible',
          display: 'block',
          opacity: '1',
        }),
      },
      console, String, Array, Number,
    };
    ctx.isVisible = () => true;
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end), ctx);
    return ctx.detectActiveChallenge();
  })(),
  '',
);

console.log(fails === 0 ? '\nALL PASSED' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
