import React, { useEffect, useRef } from 'react';
import ToolLogo, { toolColor } from '../../common/ToolLogo';

export const CHART_PALETTE = ['#10b981', '#8b5cf6', '#38bdf8', '#f59e0b', '#ec4899', '#14b8a6', '#f97316', '#a3e635'];
export const DEPT_HUES = [160, 262, 330, 38, 200, 20, 290, 85];

// Claude / ChatGPT rows link to the chat itself; every other tool links to the file.
export const CHAT_TOOLS = new Set(['Claude', 'ChatGPT']);

export const fmtINR = (val) => {
  const n = Number(val || 0);
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
};
export const fmtCompactINR = (val) => {
  const n = Number(val || 0);
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
};
export const fmtNum = (val) => Number(val || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 });
export const fmtCompactNum = (val) => {
  const n = Number(val || 0);
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return fmtNum(n);
};
export const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

export const hashHue = (text, hues = DEPT_HUES) =>
  hues[[...String(text || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % hues.length];

// Which player an output needs, from the report's output type ("AI Video",
// "Voice / Audio", "AI Image"…). The backend's URL-based guess wins when it has one.
export const guessKind = (outputType) => {
  const t = String(outputType || '').toLowerCase();
  if (/video/.test(t)) return 'video';
  if (/audio|voice|music|soundtrack|sample/.test(t)) return 'audio';
  if (/image|asset/.test(t)) return 'image';
  return null;
};

// What each tool makes - steadier than the output type, which can say
// "AI Image" for a Kling video.
const TOOL_MEDIA = {
  Kling: 'video',
  HeyGen: 'video',
  Flow: 'video',
  Suno: 'audio',
  ElevenLabs: 'audio',
  'Epidemic Sound': 'audio',
  Splice: 'audio',
  Freepik: 'image',
};
export const rowKind = (row) => TOOL_MEDIA[row?.tool] || guessKind(row?.outputType);

// "Kling (12)" -> { tool: 'Kling', count: 12 }
export const parseToolsUsed = (list) =>
  (list || [])
    .map((entry) => {
      const m = /^(.*) \((\d+)\)$/.exec(String(entry));
      return m ? { tool: m[1], count: Number(m[2]) } : null;
    })
    .filter(Boolean);

export const ICONS = {
  rupee: 'M7 4h10v2h-3.2c.5.6.9 1.3 1.1 2H17v2h-2.1c-.4 2.3-2.4 4-4.9 4h-.6l5.3 6h-2.7l-5.3-6H6v-2h4c1.4 0 2.6-.8 3-2H6V8h6.9c-.4-1.2-1.6-2-2.9-2H7V4z',
  bars: 'M5 20V10h3v10H5zm5.5 0V4h3v16h-3zM16 20v-7h3v7h-3z',
  doc: 'M6 2h8l6 6v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm7 1.5V9h5.5L13 3.5zM8 13h8v2H8v-2zm0 4h8v2H8v-2z',
  people: 'M9 11a4 4 0 100-8 4 4 0 000 8zm7 0a3 3 0 100-6 3 3 0 000 6zM2 20c0-3.3 3.1-6 7-6s7 2.7 7 6H2zm15.5 0c0-1.9-.8-3.6-2.1-4.8 3 .3 5.6 2.2 5.6 4.8h-3.5z',
  person: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6H5z',
  info: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  calendar: 'M7 2v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H9V2H7zm-2 8h14v10H5V10z',
  refresh: 'M17.7 6.3A8 8 0 1020 12h-2a6 6 0 11-1.8-4.2L13 11h7V4l-2.3 2.3z',
  download: 'M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3zM5 19h14v2H5v-2z',
  search: 'M10 4a6 6 0 104.47 10.03l4.75 4.75 1.06-1.06-4.75-4.75A6 6 0 0010 4zm0 1.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9z',
  columns: 'M3 5h18v14H3V5zm2 2v10h4V7H5zm6 0v10h2V7h-2zm4 0v10h4V7h-4z',
  chart: 'M4 19h16v2H2V3h2v16zm3-3l4-5 3 3 5-7 1.6 1.2-6.4 9-3-3-2.6 3.3L7 16z',
  compare: 'M3 4h8v16H3V4zm2 2v12h4V6H5zm8-2h8v16h-8V4zm2 2v12h4V6h-4z',
  tool: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
  spark: 'M12 2l2.4 7.2H22l-6.2 4.5 2.4 7.3L12 16.5 5.8 21l2.4-7.3L2 9.2h7.6L12 2z',
  coin: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 15.9V19h-2v-1.1c-1.7-.3-3-1.4-3.1-3h2c.1.9.9 1.4 2.1 1.4 1.3 0 1.9-.6 1.9-1.3 0-.8-.6-1.2-2.3-1.6-2.2-.5-3.4-1.3-3.4-3 0-1.4 1.1-2.5 2.8-2.8V6h2v1.1c1.6.3 2.6 1.4 2.7 2.8h-2c-.1-.8-.7-1.3-1.8-1.3-1.1 0-1.7.5-1.7 1.2 0 .7.6 1 2.3 1.4 2.2.5 3.4 1.3 3.4 3.1 0 1.5-1.1 2.6-2.9 2.9z',
  external: 'M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H5v12h12v-6h2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  chat: 'M4 4h16a2 2 0 012 2v10a2 2 0 01-2 2H8l-4 4V6a2 2 0 012-2z',
  sort: 'M7 4l4 4H8v12H6V8H3l4-4zm10 16l-4-4h3V4h2v12h3l-4 4z',
  close: 'M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3 1.4 1.4z',
  check: 'M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.4L9 16.2z',
  chevron: 'M7 10l5 5 5-5H7z',
  briefcase: 'M10 2h4a2 2 0 012 2v2h4a2 2 0 012 2v11a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4V4a2 2 0 012-2zm0 4h4V4h-4v2z',
  crown: 'M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z',
  play: 'M8 5v14l11-7L8 5z',
  image: 'M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z',
};

export const Icon = ({ d, size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path d={d} fill="currentColor" />
  </svg>
);

export const Avatar = ({ name, size }) => {
  const label = String(name || '?').trim();
  const initials = label.split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('');
  return (
    <span
      className="zrs-avatar"
      style={{ '--hue': hashHue(label), ...(size ? { width: size, height: size, fontSize: size * 0.42 } : null) }}
      aria-hidden="true"
    >
      {initials || '?'}
    </span>
  );
};

export const ToolTag = ({ name, onClick }) => (
  <button
    type="button"
    className="zrs-tool-tag"
    style={{ '--tool': toolColor(name) }}
    onClick={onClick}
    disabled={!onClick}
    title={onClick ? `Show only ${name}` : name}
  >
    <ToolLogo name={name} size={16} />
    {name}
  </button>
);

export const DeptPill = ({ name }) =>
  name ? (
    <span className="zrs-dept" style={{ '--hue': hashHue(name) }}>
      {name}
    </span>
  ) : (
    <span className="zrs-muted">—</span>
  );

export const ShareBar = ({ pct }) => (
  <div className="zrs-share">
    <span className="zrs-share-track">
      <span style={{ width: `${Math.min(100, Number(pct || 0))}%` }} />
    </span>
    <span className="zrs-share-val">{fmtNum(pct)}%</span>
  </div>
);

// One shimmering placeholder bar.
export const Skel = ({ w = '100%', h = 10, r = 6, style }) => (
  <span className="zrs-skel" style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />
);

export const SkeletonRows = ({ cols, rows = 8 }) => (
  <tbody className="zrs-skeleton">
    {Array.from({ length: rows }).map((_, r) => (
      <tr key={r}>
        {Array.from({ length: cols }).map((__, c) => (
          <td key={c}>
            <span style={{ width: `${45 + ((r * 7 + c * 13) % 45)}%` }} />
          </td>
        ))}
      </tr>
    ))}
  </tbody>
);

// Shape-matched placeholder for each chart card while data syncs.
export const ChartSkeleton = ({ kind = 'area' }) => {
  if (kind === 'donut') {
    return (
      <div className="zrs-chart-skel donut" aria-hidden="true">
        <span className="zrs-skel-ring" />
        <div className="zrs-chart-skel-legend">
          {[78, 64, 70, 52, 58, 40].map((w, i) => (
            <Skel key={i} w={`${w}%`} h={9} />
          ))}
        </div>
      </div>
    );
  }
  if (kind === 'bars') {
    return (
      <div className="zrs-chart-skel bars" aria-hidden="true">
        {[86, 64, 30, 22, 14, 10].map((h, i) => (
          <Skel key={i} w="100%" h={`${h}%`} r={6} />
        ))}
      </div>
    );
  }
  return (
    <div className="zrs-chart-skel area" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="zrs-chart-skel-line" />
      ))}
      <span className="zrs-chart-skel-wave" />
    </div>
  );
};

export const ChartTooltip = ({ active, payload, label, money = true }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="zrs-tip">
      <span>{label || p.payload?.name}</span>
      <b>{money ? fmtINR(p.value) : fmtNum(p.value)}</b>
    </div>
  );
};

// Chats open their transcript; every other output plays in the dashboard.
export const OutputLink = ({ row, onOpen }) => {
  if (!row?.hasOutput || !row.outputRef) return <span className="zrs-muted">—</span>;
  const chat = CHAT_TOOLS.has(row.tool);
  const kind = rowKind(row);
  const [icon, label, title] = chat
    ? [ICONS.chat, 'View chat', 'Read this conversation']
    : kind === 'video' || kind === 'audio'
      ? [ICONS.play, 'Play', 'Play here, or download']
      : kind === 'image'
        ? [ICONS.image, 'View', 'View here, or download']
        : [ICONS.external, 'Open', 'Preview here, or download'];
  return (
    <button type="button" className={`zrs-open${chat ? '' : ' media'}`} onClick={() => onOpen(row)} title={title}>
      <Icon d={icon} size={12} />
      {label}
    </button>
  );
};

export function useOutsideClose(open, setOpen) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);
  return ref;
}

/* ---------- sorting ---------- */

export function sortRows(rows, columns, sort) {
  if (!sort?.key || !rows?.length) return rows || [];
  const col = columns.find((c) => c.key === sort.key);
  if (!col?.sort) return rows;
  const mult = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.sort(a);
    const vb = col.sort(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
    return String(va ?? '').localeCompare(String(vb ?? ''), 'en', { numeric: true, sensitivity: 'base' }) * mult;
  });
}

// Click a header: first click sorts numbers high → low and text A → Z,
// the second flips it, the third returns to the default order.
export function nextSort(sort, col) {
  const first = col.num ? 'desc' : 'asc';
  if (sort?.key !== col.key) return { key: col.key, dir: first };
  if (sort.dir === first) return { key: col.key, dir: first === 'desc' ? 'asc' : 'desc' };
  return null;
}

export const sortLabel = (col, dir) =>
  col.num ? (dir === 'desc' ? 'High → low' : 'Low → high') : dir === 'asc' ? 'A → Z' : 'Z → A';

// Options for the "Sort" dropdown built from a sheet's sortable columns.
export const sortOptions = (columns) => [
  { value: '', label: 'Default order', hint: 'As the report lists it' },
  ...columns
    .filter((c) => c.sort)
    .flatMap((c) => {
      const dirs = c.num ? ['desc', 'asc'] : ['asc', 'desc'];
      return dirs.map((dir) => ({
        value: `${c.key}:${dir}`,
        label: `${c.label} · ${sortLabel(c, dir)}`,
      }));
    }),
];

export const SortTh = ({ col, sort, onSort }) => {
  if (!col.sort) return <th className={col.num ? 'num' : ''}>{col.label}</th>;
  const active = sort?.key === col.key;
  return (
    <th
      className={`${col.num ? 'num ' : ''}zrs-sortable${active ? ' sorted' : ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" onClick={() => onSort(nextSort(sort, col))} title={`Sort by ${col.label}`}>
        {col.label}
        <span className={`zrs-sort-ind ${active ? sort.dir : ''}`} aria-hidden="true">
          <i />
          <i />
        </span>
      </button>
    </th>
  );
};
