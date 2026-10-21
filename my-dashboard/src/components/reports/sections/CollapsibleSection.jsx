import { useState } from 'react';

/**
 * A titled section with a show/hide arrow. Collapsed, it shows only its
 * one-line summary, so long admin cards (Suno / Flow credit prices) stay
 * short. Open/closed is remembered per viewer (`storageKey`) - a per-viewer
 * convenience only, so a blocked storage just falls back to `defaultOpen`.
 */
const readOpen = (key, fallback) => {
  try {
    const stored = key ? window.localStorage.getItem(key) : null;
    return stored == null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
};

const CollapsibleSection = ({ title, summary, storageKey, defaultOpen = false, level = 'card', actions, forceOpen = false, children }) => {
  const [stored, setOpen] = useState(() => readOpen(storageKey, defaultOpen));
  // forceOpen: something inside is being edited (e.g. a rate opened from
  // another section), so it must be visible whatever the viewer last chose.
  const open = stored || forceOpen;
  const toggle = () => {
    setOpen((prev) => {
      try { if (storageKey) window.localStorage.setItem(storageKey, prev ? '0' : '1'); } catch { /* per-viewer only */ }
      return !prev;
    });
  };
  const isCard = level === 'card';
  return (
    <div className={isCard ? 'rpt-card' : undefined}
      style={isCard ? { padding: 16, marginBottom: 20 } : { marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button type="button" onClick={toggle} aria-expanded={open}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 0, padding: 0,
            cursor: 'pointer', color: 'inherit', textAlign: 'left', flex: '1 1 auto', minWidth: 0 }}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 12, fontSize: 11,
            transition: 'transform .15s ease', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
          <span style={{ fontSize: isCard ? 14 : 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{title}</span>
          {!open && summary && (
            <span style={{ fontSize: 12, color: 'var(--color-text-muted, #888)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
          )}
        </button>
        {open && actions}
      </div>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
};

export default CollapsibleSection;
