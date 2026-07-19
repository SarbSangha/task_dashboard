import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './Menu.css';

/**
 * Menu — an accessible dropdown / context menu primitive.
 *
 * The shared engine behind the workspace "More" tab overflow and every future
 * ⋮ action menu. Rendered through a portal with fixed positioning so it is
 * never clipped by the `overflow:hidden` workspace window or the `overflow-x`
 * tab strip it opens from.
 *
 * Items are data-driven so callers stay declarative:
 *   items = [
 *     { type: 'section', label: 'Workspace tools' },
 *     { key: 'gen', label: 'Gen Projects', icon: '🎬', active: false, onSelect },
 *     { type: 'separator' },
 *     { key: 'del', label: 'Delete', icon: '🗑', variant: 'danger', onSelect },
 *   ]
 *
 * Provide a custom trigger with `renderTrigger(triggerProps, { open })`, or
 * fall back to the built-in labelled button via the `label` prop.
 *
 * Keyboard: ↓/↑ move, Home/End jump, Enter/Space activate, Esc closes and
 * returns focus to the trigger, Tab closes. Click-outside closes.
 */
export default function Menu({
  items = [],
  label,
  align = 'start', // 'start' | 'end'
  menuLabel = 'Menu',
  className = '',
  triggerClassName = '',
  renderTrigger,
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const baseId = useId();

  // Indices of focusable (non-section, non-separator, non-disabled) items.
  const focusableIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.type && !item.disabled)
    .map(({ index }) => index);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setCoords({ top: rect.bottom + 6, left: rect.left, right: rect.right, triggerWidth: rect.width });
  }, []);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev) computePosition();
      return !prev;
    });
  }, [computePosition]);

  // Reposition while open on scroll/resize; nothing runs when closed.
  useLayoutEffect(() => {
    if (!open) return undefined;
    computePosition();
    const handle = () => computePosition();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [open, computePosition]);

  // On open, move focus to the active item (or the first focusable one).
  useEffect(() => {
    if (!open) return;
    const activeIndex = items.findIndex((item) => !item.type && item.active);
    const target = activeIndex >= 0 ? activeIndex : focusableIndexes[0];
    if (target != null) {
      // Defer to let the portal mount.
      requestAnimationFrame(() => itemRefs.current[target]?.focus());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click outside closes (without stealing focus back to the trigger).
  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    return () => document.removeEventListener('mousedown', handlePointer);
  }, [open]);

  const focusByOffset = (currentIndex, offset) => {
    if (focusableIndexes.length === 0) return;
    const pos = focusableIndexes.indexOf(currentIndex);
    const nextPos = (pos + offset + focusableIndexes.length) % focusableIndexes.length;
    itemRefs.current[focusableIndexes[nextPos]]?.focus();
  };

  const handleTriggerKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        computePosition();
        setOpen(true);
      }
    }
  };

  const handleItemKeyDown = (event, index, item) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusByOffset(index, 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusByOffset(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        itemRefs.current[focusableIndexes[0]]?.focus();
        break;
      case 'End':
        event.preventDefault();
        itemRefs.current[focusableIndexes[focusableIndexes.length - 1]]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        item.onSelect?.();
        close(true);
        break;
      default:
        break;
    }
  };

  const triggerProps = {
    ref: triggerRef,
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: toggle,
    onKeyDown: handleTriggerKeyDown,
  };

  return (
    <>
      {renderTrigger ? (
        renderTrigger(triggerProps, { open })
      ) : (
        <button {...triggerProps} className={`ui-menu-trigger ${triggerClassName}`}>
          <span>{label}</span>
          <span className="ui-menu-caret" aria-hidden="true">▾</span>
        </button>
      )}

      {open && coords
        && createPortal(
          <div
            ref={menuRef}
            className={`ui-menu ${className}`}
            role="menu"
            aria-label={menuLabel}
            style={{
              top: coords.top,
              ...(align === 'end'
                ? { right: Math.max(8, window.innerWidth - coords.right) }
                : { left: Math.max(8, coords.left) }),
              minWidth: Math.max(coords.triggerWidth, 200),
            }}
          >
            {items.map((item, index) => {
              if (item.type === 'section') {
                return (
                  <div key={`section-${index}`} className="ui-menu-section" role="presentation">
                    {item.label}
                  </div>
                );
              }
              if (item.type === 'separator') {
                return <div key={`sep-${index}`} className="ui-menu-separator" role="separator" />;
              }
              return (
                <button
                  key={item.key || `item-${index}`}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  type="button"
                  role="menuitem"
                  id={`${baseId}-item-${index}`}
                  className={`ui-menu-item${item.active ? ' active' : ''}${item.variant === 'danger' ? ' danger' : ''}`}
                  disabled={item.disabled}
                  tabIndex={-1}
                  onClick={() => { item.onSelect?.(); close(true); }}
                  onKeyDown={(event) => handleItemKeyDown(event, index, item)}
                >
                  {item.icon != null && <span className="ui-menu-item-icon" aria-hidden="true">{item.icon}</span>}
                  <span className="ui-menu-item-label">{item.label}</span>
                  {item.active && <span className="ui-menu-item-check" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
