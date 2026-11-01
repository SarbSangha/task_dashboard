import { useEffect, useRef, useState } from 'react';
import { EMOJI_GROUPS } from './chatUtils';

export default function EmojiPicker({ onSelect, onClose, anchorRef }) {
  const [activeGroupId, setActiveGroupId] = useState(EMOJI_GROUPS[0].id);
  const pickerRef = useRef(null);
  const activeGroup = EMOJI_GROUPS.find((group) => group.id === activeGroupId) || EMOJI_GROUPS[0];

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (pickerRef.current?.contains(event.target)) return;
      if (anchorRef?.current?.contains(event.target)) return;
      onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorRef, onClose]);

  return (
    <div
      className="emoji-picker"
      ref={pickerRef}
      role="dialog"
      aria-label="Insert emoji"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="emoji-picker-tabs" role="tablist">
        {EMOJI_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={group.id === activeGroupId}
            className={`emoji-picker-tab ${group.id === activeGroupId ? 'is-active' : ''}`}
            onClick={() => setActiveGroupId(group.id)}
            title={group.label}
          >
            <span aria-hidden="true">{group.emoji[0]}</span>
            <span className="emoji-picker-tab-label">{group.label}</span>
          </button>
        ))}
      </div>
      <div className="emoji-picker-grid" role="tabpanel" aria-label={activeGroup.label}>
        {activeGroup.emoji.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="emoji-picker-item"
            onClick={() => onSelect(emoji)}
            aria-label={`Insert ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
