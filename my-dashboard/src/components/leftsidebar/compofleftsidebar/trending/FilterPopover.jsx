import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './FilterPopover.css';

const PANEL_MAX_WIDTH = 640;
const EDGE = 12;

/**
 * One "Filters" button that opens every filter in a popover, so a tab's
 * toolbar stays a single row (Kling tab, ToolRecordsTab, AI Library, Task
 * Report). Filters apply as they change; the badge counts the active ones.
 *
 * The panel renders on <body> with fixed positioning computed from the
 * button: the panels these toolbars live in clip overflow, and the button is
 * often near their right edge, so an in-flow popover got cut off. It opens
 * below the button, right-aligned when the button sits in the right half of
 * the window, and always stays inside the viewport.
 *
 * The date picker inside also renders its calendar on <body>, so clicks and
 * Escape there belong to the calendar, not to this popover.
 */
export default function FilterPopover({ activeCount = 0, onClear, children, label = 'Filters' }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(null);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);

  const place = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(PANEL_MAX_WIDTH, window.innerWidth - EDGE * 2);
    const preferRight = rect.left + rect.width / 2 > window.innerWidth / 2;
    const idealLeft = preferRight ? rect.right - width : rect.left;
    const left = Math.max(EDGE, Math.min(idealLeft, window.innerWidth - width - EDGE));
    const top = rect.bottom + 8;
    setPlacement({ left, top, width, maxHeight: Math.max(240, window.innerHeight - top - EDGE) });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const inPicker = (target) => Boolean(target?.closest?.('.drp-pop'));
    const onDown = (event) => {
      if (wrapRef.current?.contains(event.target) || panelRef.current?.contains(event.target) || inPicker(event.target)) return;
      setOpen(false);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape' || document.querySelector('.drp-pop')) return;
      setOpen(false);
    };
    // Follow the button if the page or a panel scrolls; ignore scrolling
    // inside the popover itself.
    const onScroll = (event) => {
      if (panelRef.current?.contains(event.target)) return;
      place();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const panel = open && placement && (
    <div
      ref={panelRef}
      className="fpop-panel"
      role="dialog"
      aria-label={label}
      style={{ left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight }}
    >
      <header className="fpop-head">
        <strong>{label}</strong>
        {activeCount > 0 && <span className="fpop-head-count">{activeCount} active</span>}
        <div className="fpop-head-actions">
          {activeCount > 0 && onClear && (
            <button type="button" className="fpop-link" onClick={onClear}>Clear all</button>
          )}
          <button type="button" className="fpop-close" onClick={() => setOpen(false)} aria-label="Close filters">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </header>
      <div className="fpop-body">{children}</div>
      <footer className="fpop-foot">
        <span>Results update as you choose.</span>
        <button type="button" className="fpop-done" onClick={() => setOpen(false)}>Done</button>
      </footer>
    </div>
  );

  return (
    <div className="fpop" ref={wrapRef}>
      <button
        type="button"
        className={`fpop-btn${open ? ' is-open' : ''}${activeCount ? ' has-active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
        {label}
        {activeCount > 0 && <span className="fpop-badge">{activeCount}</span>}
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
