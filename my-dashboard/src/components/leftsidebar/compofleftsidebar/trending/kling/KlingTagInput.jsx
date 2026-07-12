import React, { useState } from 'react';

export default function KlingTagInput({ tags, onAdd, onRemove, disabled }) {
  const [value, setValue] = useState('');

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && value.trim()) {
      event.preventDefault();
      onAdd(value.trim());
      setValue('');
    }
  };

  return (
    <div className="kling-tag-input">
      {tags.length > 0 && (
        <div className="kling-tag-input-chips">
          {tags.map((tagItem) => {
            const label = typeof tagItem === 'string' ? tagItem : tagItem.tag;
            return (
              <span key={label} className="kling-tag-chip">
                {label}
                <button
                  type="button"
                  onClick={() => onRemove(label)}
                  disabled={disabled}
                  aria-label={`Remove tag ${label}`}
                >
                  &times;
                </button>
              </span>
            );
          })}
        </div>
      )}
      <input
        type="text"
        className="kling-tag-input-field"
        placeholder="Add a tag and press Enter"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
    </div>
  );
}
