import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'chatgptCapture.pinnedConversationIds';

function readPinned() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Pinning is client-side only (localStorage, per browser) rather than a new
 * DB column - there's no server round-trip, so toggling reads as instant
 * ("optimistic" in the trivial sense that there's nothing to roll back).
 */
export function usePinnedConversations() {
  const [pinnedIds, setPinnedIds] = useState(() => new Set(readPinned()));

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...pinnedIds]));
    } catch {
      // Best-effort only - a full localStorage quota shouldn't break browsing.
    }
  }, [pinnedIds]);

  const isPinned = useCallback((conversationId) => pinnedIds.has(conversationId), [pinnedIds]);

  const togglePin = useCallback((conversationId) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }, []);

  return { pinnedIds, isPinned, togglePin };
}
