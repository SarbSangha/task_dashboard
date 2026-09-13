import { useEffect, useState } from 'react';

/**
 * Returns a copy of `value` that only updates after `delayMs` of no changes.
 * Used to keep fast-typing search inputs from firing a request per keystroke.
 */
export function useDebouncedValue(value, delayMs = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export default useDebouncedValue;
