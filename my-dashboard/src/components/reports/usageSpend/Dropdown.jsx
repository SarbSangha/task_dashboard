import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon, ICONS, useOutsideClose } from './shared';

/**
 * Custom select used across the Usage & Spend report in place of the native
 * <select>.
 *
 * options: [{ value, label, icon?, hint?, group?, meta? }]
 * - multiple: value is an array, the menu stays open while picking
 * - searchable: filter box at the top (on by default past 8 options)
 * - trigger: custom trigger content; the dropdown then behaves as a menu
 */
export default function Dropdown({
  value,
  options,
  onChange,
  multiple = false,
  searchable,
  placeholder = 'Select',
  size = 'md',
  align = 'left',
  label,
  trigger,
  triggerClassName = '',
  menuWidth,
  max,
  disabled = false,
  allLabel,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useOutsideClose(open, setOpen);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const triggerRef = useRef(null);
  const listId = useId();

  const canSearch = searchable ?? options.length > 8;
  const selected = useMemo(() => (multiple ? new Set(value || []) : new Set([value])), [multiple, value]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => `${o.label} ${o.hint || ''} ${o.group || ''}`.toLowerCase().includes(needle));
  }, [options, q]);

  useEffect(() => {
    if (!open) {
      setQ('');
      return;
    }
    const idx = filtered.findIndex((o) => selected.has(o.value));
    setActive(idx >= 0 ? idx : 0);
    if (canSearch) setTimeout(() => searchRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (opt) => {
    if (!opt || opt.disabled) return;
    if (multiple) {
      const next = new Set(value || []);
      if (next.has(opt.value)) next.delete(opt.value);
      else {
        if (max && next.size >= max) return;
        next.add(opt.value);
      }
      onChange([...next]);
      return;
    }
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKey = (e) => {
    if (!open) {
      if (['ArrowDown', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(filtered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(filtered[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      if (e.key === 'Escape') triggerRef.current?.focus();
    }
  };

  const current = !multiple ? options.find((o) => o.value === value) : null;
  const picked = multiple ? options.filter((o) => selected.has(o.value)) : [];

  let display;
  if (trigger) display = trigger;
  else if (multiple) {
    display = picked.length ? (
      <span className="zdd-chips">
        {picked.slice(0, 2).map((o) => (
          <span key={o.value} className="zdd-chip">
            {o.icon}
            <span>{o.label}</span>
          </span>
        ))}
        {picked.length > 2 && <span className="zdd-more">+{picked.length - 2}</span>}
      </span>
    ) : (
      <span className="zdd-placeholder">{allLabel || placeholder}</span>
    );
  } else {
    display = current ? (
      <span className="zdd-value">
        {current.icon}
        <span className="zdd-value-text">{current.label}</span>
      </span>
    ) : (
      <span className="zdd-placeholder">{placeholder}</span>
    );
  }

  let lastGroup;
  return (
    <div className={`zdd zdd-${size} ${open ? 'is-open' : ''} ${className}`} ref={wrapRef} onKeyDown={onKey}>
      <button
        ref={triggerRef}
        type="button"
        className={trigger ? triggerClassName || 'zrs-btn' : 'zdd-trigger'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {display}
        {!trigger && <span className="zdd-caret"><Icon d={ICONS.chevron} size={16} /></span>}
        {trigger && <span className="zrs-caret" />}
      </button>

      {open && (
        <div className={`zdd-pop ${align === 'right' ? 'right' : ''}`} style={menuWidth ? { width: menuWidth } : null}>
          {canSearch && (
            <div className="zdd-search">
              <Icon d={ICONS.search} size={14} />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                aria-label="Filter options"
              />
            </div>
          )}
          {multiple && (
            <div className="zdd-multi-head">
              <span>
                {picked.length} selected{max ? ` · max ${max}` : ''}
              </span>
              {picked.length > 0 && (
                <button type="button" onClick={() => onChange([])}>
                  Clear
                </button>
              )}
            </div>
          )}
          <ul className="zdd-list" role="listbox" id={listId} aria-multiselectable={multiple || undefined} ref={listRef}>
            {filtered.length === 0 && <li className="zdd-none">No matches</li>}
            {filtered.map((o, i) => {
              const isSel = selected.has(o.value);
              const atMax = multiple && max && !isSel && selected.size >= max;
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <React.Fragment key={`${o.value}`}>
                  {head && <li className="zdd-group">{head}</li>}
                  <li
                    role="option"
                    aria-selected={isSel}
                    aria-disabled={atMax || o.disabled || undefined}
                    data-idx={i}
                    className={`zdd-opt${i === active ? ' active' : ''}${isSel ? ' selected' : ''}${atMax ? ' muted' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                  >
                    {multiple && (
                      <span className={`zdd-box${isSel ? ' on' : ''}`}>{isSel && <Icon d={ICONS.check} size={12} />}</span>
                    )}
                    {o.icon && <span className="zdd-opt-icon">{o.icon}</span>}
                    <span className="zdd-opt-text">
                      <span>{o.label}</span>
                      {o.hint && <small>{o.hint}</small>}
                    </span>
                    {o.meta != null && <span className="zdd-opt-meta">{o.meta}</span>}
                    {!multiple && isSel && (
                      <span className="zdd-tick">
                        <Icon d={ICONS.check} size={14} />
                      </span>
                    )}
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
