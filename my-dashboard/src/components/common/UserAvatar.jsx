import React from 'react';

export function UserAvatar({ avatar, name, size = 40 }) {
  const initials = name
    ?.split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '50%',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: avatar ? 'transparent' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        fontWeight: '600',
        fontSize: `${size / 2.5}px`
      }}
    >
      {avatar ? (
        <img
          src={avatar}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}
