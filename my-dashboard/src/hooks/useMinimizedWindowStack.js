import { useEffect, useState } from 'react';

const STACK_BASE_RIGHT = 8;
const STACK_BASE_BOTTOM = 12;
const STACK_GAP = 10;
const MINIMIZED_WINDOW_HEIGHT = 60;
const MINIMIZED_WINDOW_STEP = MINIMIZED_WINDOW_HEIGHT + STACK_GAP;
// Keep minimized windows above every fullscreen panel/backdrop so the stack
// remains visible even when another overlay opens later.
const STACK_Z_INDEX_BASE = 2147483400;

const minimizedWindowOrder = [];
const listeners = new Set();

const notifyListeners = () => {
  listeners.forEach((listener) => listener());
};

const registerWindow = (windowId) => {
  if (!windowId) return;
  const existingIndex = minimizedWindowOrder.indexOf(windowId);
  if (existingIndex !== -1) {
    minimizedWindowOrder.splice(existingIndex, 1);
  }
  minimizedWindowOrder.push(windowId);
  notifyListeners();
};

const unregisterWindow = (windowId) => {
  if (!windowId) return;
  const existingIndex = minimizedWindowOrder.indexOf(windowId);
  if (existingIndex === -1) return;
  minimizedWindowOrder.splice(existingIndex, 1);
  notifyListeners();
};

const getWindowStackIndex = (windowId) => {
  const registrationIndex = minimizedWindowOrder.indexOf(windowId);
  if (registrationIndex === -1) return -1;
  return minimizedWindowOrder.length - 1 - registrationIndex;
};

export const useMinimizedWindowStack = (windowId, isMinimized) => {
  const [stackIndex, setStackIndex] = useState(() =>
    isMinimized ? getWindowStackIndex(windowId) : -1
  );

  useEffect(() => {
    const syncStackIndex = () => {
      setStackIndex(isMinimized ? getWindowStackIndex(windowId) : -1);
    };

    listeners.add(syncStackIndex);

    if (isMinimized) {
      registerWindow(windowId);
    } else {
      unregisterWindow(windowId);
      syncStackIndex();
    }

    return () => {
      listeners.delete(syncStackIndex);
      unregisterWindow(windowId);
    };
  }, [isMinimized, windowId]);

  if (!isMinimized || stackIndex < 0) {
    return null;
  }

  return {
    width: 'min(228px, calc(100vw - 12px))',
    maxWidth: 'calc(100vw - 12px)',
    height: `${MINIMIZED_WINDOW_HEIGHT}px`,
    maxHeight: `${MINIMIZED_WINDOW_HEIGHT}px`,
    right: `${STACK_BASE_RIGHT}px`,
    bottom: `${STACK_BASE_BOTTOM + stackIndex * MINIMIZED_WINDOW_STEP}px`,
    left: 'auto',
    top: 'auto',
    transform: 'none',
    zIndex: STACK_Z_INDEX_BASE + stackIndex,
  };
};
