import React, { useCallback, useMemo, useState } from 'react';
import { Grid } from 'react-window';
import { useElementSize } from '../../../../../hooks/useElementSize';
import { KlingGenerationCard } from './KlingGenerationCard';
import KlingCardMenu from './KlingCardMenu';
import KlingCardSkeletonGrid from './KlingCardSkeletonGrid';

const CARD_MIN_WIDTH = 260;
const CARD_GAP = 12;
const CARD_ROW_HEIGHT = 360;

function resolveCellGeneration(generations, columnCount, rowIndex, columnIndex) {
  const index = rowIndex * columnCount + columnIndex;
  return generations[index] || null;
}

/**
 * Custom memo comparator: resolves *this cell's* generation from both the old
 * and new `generations` array/`favoritePendingIds` set and compares only what
 * this specific cell cares about, instead of bailing out whenever the shared
 * array/set reference changes (which happens on every optimistic update).
 * This is what keeps a single favorite/menu toggle from re-rendering every
 * other visible card.
 */
function cellPropsAreEqual(prev, next) {
  if (prev.columnCount !== next.columnCount || prev.rowIndex !== next.rowIndex || prev.columnIndex !== next.columnIndex) {
    return false;
  }
  if (prev.onToggleMenu !== next.onToggleMenu || prev.onOpenDrawer !== next.onOpenDrawer || prev.onToggleFavorite !== next.onToggleFavorite) {
    return false;
  }
  // react-window recomputes each cell's position/size style on container resize
  // (e.g. columnWidth shrinks without columnCount changing) — compare the actual
  // values rather than skip this because the style object is a fresh reference
  // most renders regardless of whether the geometry actually changed.
  const prevStyle = prev.style || {};
  const nextStyle = next.style || {};
  if (
    prevStyle.top !== nextStyle.top
    || prevStyle.left !== nextStyle.left
    || prevStyle.width !== nextStyle.width
    || prevStyle.height !== nextStyle.height
  ) {
    return false;
  }

  const prevGeneration = resolveCellGeneration(prev.generations, prev.columnCount, prev.rowIndex, prev.columnIndex);
  const nextGeneration = resolveCellGeneration(next.generations, next.columnCount, next.rowIndex, next.columnIndex);
  if (prevGeneration !== nextGeneration) return false;
  if (!nextGeneration) return true;

  const prevOpen = prev.openMenuGenerationId === prevGeneration.id;
  const nextOpen = next.openMenuGenerationId === nextGeneration.id;
  if (prevOpen !== nextOpen) return false;

  const prevPending = prev.favoritePendingIds.has(prevGeneration.id);
  const nextPending = next.favoritePendingIds.has(nextGeneration.id);
  return prevPending === nextPending;
}

const KlingGridCell = React.memo(function KlingGridCell({
  ariaAttributes,
  generations,
  columnCount,
  columnIndex,
  rowIndex,
  style,
  openMenuGenerationId,
  onToggleMenu,
  onOpenDrawer,
  onToggleFavorite,
  favoritePendingIds,
}) {
  const generation = resolveCellGeneration(generations, columnCount, rowIndex, columnIndex);
  if (!generation) return null;

  return (
    <div {...ariaAttributes} className="kling-virtual-cell" style={style}>
      <KlingGenerationCard
        generation={generation}
        isMenuOpen={openMenuGenerationId === generation.id}
        onToggleMenu={onToggleMenu}
        onOpenDrawer={onOpenDrawer}
        onToggleFavorite={onToggleFavorite}
        isFavoritePending={favoritePendingIds.has(generation.id)}
      />
    </div>
  );
},
cellPropsAreEqual);

export default function KlingGenerationGrid({
  generations,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpenDrawer,
  onToggleFavorite,
  favoritePendingIds,
  canDownload,
  currentUserId,
  myProjects,
  onMoveToProject,
  onRemoveFromProject,
}) {
  const [gridWrapRef, gridSize] = useElementSize();
  const [openMenu, setOpenMenu] = useState(null);
  const gridWidth = gridSize.width;
  const gridHeight = gridSize.height;

  const columnCount = Math.max(
    1,
    Math.floor((Math.max(gridWidth, CARD_MIN_WIDTH) + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP))
  );
  const columnWidth = Math.max(
    CARD_MIN_WIDTH,
    Math.floor((Math.max(gridWidth, CARD_MIN_WIDTH) - CARD_GAP * (columnCount - 1)) / columnCount)
  );
  const rowCount = Math.max(1, Math.ceil(generations.length / columnCount));

  const handleToggleMenu = useCallback((generation, rect, triggerElement) => {
    setOpenMenu((prev) => (prev && prev.generation.id === generation.id ? null : { generation, rect, triggerElement }));
  }, []);

  const handleCloseMenu = useCallback(() => {
    setOpenMenu((prev) => {
      prev?.triggerElement?.focus?.();
      return null;
    });
  }, []);

  const handleCellsRendered = useCallback(
    ({ rowStopIndex }) => {
      if (!hasMore || loadingMore) return;
      if (rowStopIndex >= rowCount - 2) {
        onLoadMore();
      }
    },
    [hasMore, loadingMore, onLoadMore, rowCount]
  );

  const cellProps = useMemo(
    () => ({
      generations,
      columnCount,
      openMenuGenerationId: openMenu?.generation.id ?? null,
      onToggleMenu: handleToggleMenu,
      onOpenDrawer,
      onToggleFavorite,
      favoritePendingIds,
    }),
    [generations, columnCount, openMenu, handleToggleMenu, onOpenDrawer, onToggleFavorite, favoritePendingIds]
  );

  const canManageOpenMenuProject = Boolean(
    openMenu?.generation && currentUserId && openMenu.generation.ownerUserId === currentUserId
  );

  return (
    <div className="kling-virtual-grid-wrap" ref={gridWrapRef}>
      {gridWidth > 0 && gridHeight > 0 && (
        <Grid
          className="kling-virtual-grid"
          cellComponent={KlingGridCell}
          cellProps={cellProps}
          columnCount={columnCount}
          columnWidth={columnWidth}
          defaultHeight={620}
          defaultWidth={980}
          onCellsRendered={handleCellsRendered}
          overscanCount={1}
          rowCount={rowCount}
          rowHeight={CARD_ROW_HEIGHT}
          style={{ height: gridHeight, width: gridWidth }}
        />
      )}
      {loadingMore && (
        <div className="kling-virtual-loading-more">
          <KlingCardSkeletonGrid count={columnCount || 4} compact />
        </div>
      )}

      <KlingCardMenu
        generation={openMenu?.generation || null}
        anchorRect={openMenu?.rect || null}
        onClose={handleCloseMenu}
        onOpenDrawer={onOpenDrawer}
        canDownload={canDownload}
        canManageProject={canManageOpenMenuProject}
        userProjects={myProjects}
        onMoveToProject={onMoveToProject}
        onRemoveFromProject={onRemoveFromProject}
      />
    </div>
  );
}
