import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './KlingCardMenu.css';

const MENU_MARGIN = 8;
const FALLBACK_MENU_WIDTH = 220;
const FALLBACK_MENU_HEIGHT = 220;

/**
 * Single global, portal-rendered context menu for generation cards. Only one
 * instance ever exists regardless of grid size — cards never render their own
 * dropdown, so nothing can clip it against virtualized/overflow-hidden containers.
 */
export default function KlingCardMenu({
  generation,
  anchorRect,
  onClose,
  onOpenDrawer,
  canDownload,
  canManageProject,
  userProjects,
  onMoveToProject,
  onRemoveFromProject,
}) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);

  useLayoutEffect(() => {
    setShowProjectPicker(false);
    if (!anchorRect) {
      setPosition(null);
      return;
    }

    const menuEl = menuRef.current;
    const menuWidth = menuEl?.offsetWidth || FALLBACK_MENU_WIDTH;
    const menuHeight = menuEl?.offsetHeight || FALLBACK_MENU_HEIGHT;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top = anchorRect.bottom + 6;
    let left = anchorRect.right - menuWidth;

    if (left < MENU_MARGIN) left = Math.max(MENU_MARGIN, anchorRect.left);
    if (left + menuWidth > viewportWidth - MENU_MARGIN) left = viewportWidth - menuWidth - MENU_MARGIN;
    if (top + menuHeight > viewportHeight - MENU_MARGIN) top = anchorRect.top - menuHeight - 6;
    if (top < MENU_MARGIN) top = MENU_MARGIN;

    setPosition({ top, left });
  }, [anchorRect, generation]);

  useEffect(() => {
    if (!position) return;
    const firstItem = menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)');
    firstItem?.focus();
  }, [position, generation]);

  useEffect(() => {
    if (!showProjectPicker) return;
    const backButton = menuRef.current?.querySelector('.kling-card-menu-back');
    backButton?.focus();
  }, [showProjectPicker]);

  useEffect(() => {
    if (!anchorRect) return undefined;

    const handlePointerDown = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      // Clicking a card's own trigger button is handled by that button's onClick
      // toggle (open a different generation's menu, or close this one if it's the
      // same one). If this mousedown handler also called onClose() first, the
      // toggle would always see "nothing open" by the time its click fires and
      // reopen instead of closing — so skip it here and let the toggle own it.
      if (event.target.closest?.('.kling-card-menu-trigger')) return;
      onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    const handleDismiss = () => onClose();

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [anchorRect, onClose]);

  if (!generation || !anchorRect) return null;

  const style = position
    ? { top: position.top, left: position.left, visibility: 'visible' }
    : { top: anchorRect.bottom, left: anchorRect.left, visibility: 'hidden' };

  return createPortal(
    <div ref={menuRef} className="kling-card-menu-portal" role="menu" aria-label="Generation actions" style={style}>
      {!showProjectPicker ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="kling-card-menu-item"
            onClick={() => {
              onOpenDrawer(generation);
              onClose();
            }}
          >
            <span className="kling-card-menu-icon" aria-hidden="true">&#128065;</span>
            Quick Preview
          </button>
          {generation.canonicalAssetUrl && (
            <a
              role="menuitem"
              className="kling-card-menu-item"
              href={generation.canonicalAssetUrl}
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
            >
              <span className="kling-card-menu-icon" aria-hidden="true">&#8599;</span>
              Open Original
            </a>
          )}
          {canDownload && generation.canonicalAssetUrl && (
            <a
              role="menuitem"
              className="kling-card-menu-item"
              href={generation.canonicalAssetUrl}
              download
              onClick={onClose}
            >
              <span className="kling-card-menu-icon" aria-hidden="true">&#11015;</span>
              Download Original
            </a>
          )}
          <button
            type="button"
            role="menuitem"
            className="kling-card-menu-item"
            onClick={() => {
              onOpenDrawer(generation);
              onClose();
            }}
          >
            <span className="kling-card-menu-icon" aria-hidden="true">&#8505;</span>
            Metadata
          </button>
          <button type="button" role="menuitem" className="kling-card-menu-item" disabled title="Coming in a future update">
            <span className="kling-card-menu-icon" aria-hidden="true">&#10022;</span>
            Find Similar
          </button>

          {canManageProject && (
            <>
              <div className="kling-card-menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="kling-card-menu-item"
                onClick={() => setShowProjectPicker(true)}
              >
                <span className="kling-card-menu-icon" aria-hidden="true">&#128193;</span>
                Move to Project
              </button>
              {generation.projectId && (
                <button
                  type="button"
                  role="menuitem"
                  className="kling-card-menu-item kling-card-menu-item-danger"
                  onClick={() => {
                    onRemoveFromProject(generation);
                    onClose();
                  }}
                >
                  <span className="kling-card-menu-icon" aria-hidden="true">&times;</span>
                  Remove from Project
                </button>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="kling-card-menu-header">
            <button
              type="button"
              className="kling-card-menu-back"
              onClick={() => setShowProjectPicker(false)}
              aria-label="Back to actions"
            >
              &#8592;
            </button>
            <span>Move to project</span>
          </div>
          {!userProjects?.length ? (
            <p className="kling-card-menu-empty">You have no projects yet.</p>
          ) : (
            userProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className="kling-card-menu-item"
                onClick={() => {
                  onMoveToProject(generation, project);
                  onClose();
                }}
              >
                {project.name}
              </button>
            ))
          )}
        </>
      )}
    </div>,
    document.body
  );
}
