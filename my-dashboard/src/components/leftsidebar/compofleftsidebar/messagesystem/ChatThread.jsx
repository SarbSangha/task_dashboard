import { useEffect, useRef, useState } from 'react';
import { List } from 'react-window';
import MessageRow from './MessageRow';
import { hasFileDrag } from './chatUtils';
import { IconArrowDown, IconUpload } from './chatIcons';

// Row heights are measured only after rows render, so a single scrollToRow
// lands short. A "pin" re-applies the target every frame until heights settle
// or the user scrolls on their own.
const OPEN_PIN_MS = 1500;
const NEW_MESSAGE_PIN_MS = 700;
const AT_BOTTOM_THRESHOLD_PX = 72;
const SHOW_JUMP_THRESHOLD_PX = 280;
// Within this distance a late height change (image/video preview loading)
// still keeps the reader glued to the newest message.
const STICK_THRESHOLD_PX = 24;

const findLastMessageItem = (items) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === 'message') return items[index];
  }
  return null;
};

export default function ChatThread({
  currentUserId,
  dropLabel,
  emptyState,
  items,
  onDropFiles,
  onScrollRequestMissed,
  rowHeight,
  rowProps,
  scrollRequest,
  threadKey,
  typingLabel,
}) {
  const listRef = useRef(null);
  const itemsRef = useRef(items);
  const pinRef = useRef({ mode: null, until: 0, frame: 0 });
  const atBottomRef = useRef(true);
  // Stricter than atBottomRef: only true when the reader is flush with the end,
  // so late height changes (images loading, reactions) never yank someone who
  // scrolled up even slightly.
  const stickToBottomRef = useRef(true);
  const lastThreadKeyRef = useRef(null);
  const lastMessageIdRef = useRef(null);
  const messageCountRef = useRef(0);
  const dragDepthRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  itemsRef.current = items;

  const scrollToIndex = (index, align, behavior = 'instant') => {
    if (index < 0) return;
    listRef.current?.scrollToRow({ index, align, behavior });
  };

  const stopPin = () => {
    window.cancelAnimationFrame(pinRef.current.frame);
    pinRef.current = { mode: null, until: 0, frame: 0 };
  };

  const pinTo = (mode, durationMs) => {
    window.cancelAnimationFrame(pinRef.current.frame);
    pinRef.current = { mode, until: performance.now() + durationMs, frame: 0 };

    const tick = () => {
      const pin = pinRef.current;
      if (!pin.mode || performance.now() > pin.until) {
        pinRef.current = { mode: null, until: 0, frame: 0 };
        return;
      }
      const rows = itemsRef.current;
      if (rows.length) {
        const unreadIndex = pin.mode === 'unread' ? rows.findIndex((item) => item.type === 'unread') : -1;
        if (unreadIndex >= 0) {
          scrollToIndex(unreadIndex, 'start');
        } else {
          const node = listRef.current?.element;
          if (!node || node.scrollHeight - node.scrollTop - node.clientHeight > 1) {
            scrollToIndex(rows.length - 1, 'end');
          }
        }
      }
      pin.frame = window.requestAnimationFrame(tick);
    };
    pinRef.current.frame = window.requestAnimationFrame(tick);
  };

  const scrollToLatest = () => {
    setNewBelowCount(0);
    pinTo('bottom', NEW_MESSAGE_PIN_MS);
  };

  // Forgetting the thread on unmount makes a remount (StrictMode, tab switch)
  // position itself again instead of treating the rows as already seen.
  useEffect(() => () => {
    stopPin();
    lastThreadKeyRef.current = null;
  }, []);

  useEffect(() => {
    const lastMessageItem = findLastMessageItem(items);
    const lastMessageId = lastMessageItem?.message?.id ?? null;
    const messageCount = items.filter((item) => item.type === 'message').length;

    if (lastThreadKeyRef.current !== threadKey) {
      lastThreadKeyRef.current = threadKey;
      atBottomRef.current = true;
      stickToBottomRef.current = true;
      setNewBelowCount(0);
      setShowJump(false);
      pinTo('unread', OPEN_PIN_MS);
    } else if (items.length > 0 && !pinRef.current.mode && lastMessageId !== lastMessageIdRef.current) {
      const isMine = Number(lastMessageItem?.message?.senderId) === Number(currentUserId);
      if (atBottomRef.current || isMine) {
        pinTo('bottom', NEW_MESSAGE_PIN_MS);
      } else {
        const added = Math.max(1, messageCount - messageCountRef.current);
        setNewBelowCount((count) => count + added);
      }
    }

    lastMessageIdRef.current = lastMessageId;
    messageCountRef.current = messageCount;
  }, [items, threadKey, currentUserId]);

  const hasRows = items.length > 0;
  useEffect(() => {
    const node = listRef.current?.element;
    if (!hasRows || !node || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      if (pinRef.current.mode) return;
      if (stickToBottomRef.current) {
        const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (distance > 1) node.scrollTop = node.scrollHeight;
      }
      syncScrollState(node);
    });
    observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [hasRows, threadKey]);

  useEffect(() => {
    if (!scrollRequest?.messageId) return;
    const index = items.findIndex((item) => item.type === 'message' && item.message?.id === scrollRequest.messageId);
    if (index < 0) {
      onScrollRequestMissed?.(scrollRequest);
      return;
    }
    stopPin();
    scrollToIndex(index, 'center', 'smooth');
    // Only the request identity should trigger a jump.
  }, [scrollRequest?.nonce]);

  const syncScrollState = (node) => {
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    atBottomRef.current = distance < AT_BOTTOM_THRESHOLD_PX;
    stickToBottomRef.current = distance <= STICK_THRESHOLD_PX;
    setShowJump(distance > SHOW_JUMP_THRESHOLD_PX);
    if (atBottomRef.current) setNewBelowCount(0);
  };

  const handleScroll = (event) => syncScrollState(event.currentTarget);

  // A thread rendered while hidden (mobile list view) has no height, so the
  // opening position never applied; redo it once it becomes visible. Other
  // resizes (composer growing, window resizing) keep a bottom-glued reader glued.
  const lastListHeightRef = useRef(0);
  const handleResize = ({ height }) => {
    const wasHidden = lastListHeightRef.current === 0;
    lastListHeightRef.current = height;
    if (!height) return;
    if (wasHidden) {
      pinTo('unread', OPEN_PIN_MS);
      return;
    }
    const node = listRef.current?.element;
    if (node && stickToBottomRef.current && !pinRef.current.mode) {
      node.scrollTop = node.scrollHeight;
    }
  };

  const dropHandlers = onDropFiles
    ? {
        onDragEnter: (event) => {
          if (!hasFileDrag(event)) return;
          event.preventDefault();
          dragDepthRef.current += 1;
          setIsDragging(true);
        },
        onDragOver: (event) => {
          if (!hasFileDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (event) => {
          if (!hasFileDrag(event)) return;
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setIsDragging(false);
        },
        onDrop: (event) => {
          if (!hasFileDrag(event)) return;
          event.preventDefault();
          dragDepthRef.current = 0;
          setIsDragging(false);
          const files = Array.from(event.dataTransfer?.files || []);
          if (files.length) onDropFiles(files);
        },
      }
    : {};

  return (
    <div className="chat-thread" onWheel={stopPin} onTouchStart={stopPin} onMouseDown={stopPin} onKeyDown={stopPin} {...dropHandlers}>
      {items.length === 0 ? (
        emptyState
      ) : (
        <List
          className="chat-thread-list"
          defaultHeight={520}
          listRef={listRef}
          overscanCount={8}
          rowComponent={MessageRow}
          rowCount={items.length}
          rowHeight={rowHeight}
          rowProps={rowProps}
          onScroll={handleScroll}
          onResize={handleResize}
          style={{ flex: '1 1 auto', minHeight: 0, width: '100%' }}
        />
      )}

      {typingLabel && (
        <div className="chat-typing" role="status" aria-live="polite">
          <span className="chat-typing-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>{typingLabel}</span>
        </div>
      )}

      {(showJump || newBelowCount > 0) && items.length > 0 && (
        <button
          type="button"
          className={`chat-jump ${newBelowCount > 0 ? 'has-new' : ''}`}
          onClick={scrollToLatest}
          aria-label={newBelowCount > 0 ? `${newBelowCount} new messages. Jump to latest` : 'Jump to latest message'}
        >
          {newBelowCount > 0 && <span>{newBelowCount > 99 ? '99+' : newBelowCount} new</span>}
          <IconArrowDown size={16} />
        </button>
      )}

      {isDragging && (
        <div className="chat-drop" aria-hidden="true">
          <div className="chat-drop-card">
            <IconUpload size={26} />
            <strong>Drop to attach</strong>
            {dropLabel && <span>{dropLabel}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
