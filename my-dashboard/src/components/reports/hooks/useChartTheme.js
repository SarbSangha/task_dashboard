// Resolves CSS design tokens (index.css) into concrete colors Recharts can use.
// Re-reads whenever the app theme flips so charts stay in sync with light/dark.
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../../context/ThemeContext';

const readVar = (name, fallback) => {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

export function useChartTheme() {
  const { theme } = useTheme();
  const [tick, setTick] = useState(0);

  // Force a re-read after the theme class is applied to <html>/<body>.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setTick((t) => t + 1));
    return () => window.cancelAnimationFrame(id);
  }, [theme]);

  return useMemo(() => {
    const primary = readVar('--color-primary', '#2563eb');
    const info = readVar('--color-info', '#38bdf8');
    const success = readVar('--color-success', '#10b981');
    const warning = readVar('--color-warning', '#f59e0b');
    const danger = readVar('--color-danger', '#ef4444');
    const indigo = readVar('--color-primary-strong', '#4f46e5');
    return {
      primary,
      info,
      success,
      warning,
      danger,
      indigo,
      grid: readVar('--color-border', 'rgba(148,163,184,0.16)'),
      axis: readVar('--color-text-muted', '#94a3b8'),
      text: readVar('--color-text-secondary', '#cbd5e1'),
      // categorical series palette (brand-neutral, distinguishable in both themes)
      series: [primary, info, success, warning, indigo, danger],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, tick]);
}

export default useChartTheme;
