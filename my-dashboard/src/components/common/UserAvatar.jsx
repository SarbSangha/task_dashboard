import React, { useEffect, useState } from 'react';
import { getAvatarInitials, normalizeAvatarSrc } from '../../utils/avatar';

export function UserAvatar({ avatar, name, size = 40 }) {
  const [imageFailed, setImageFailed] = useState(false);
  const avatarSrc = imageFailed ? null : normalizeAvatarSrc(avatar);
  const initials = getAvatarInitials(name);

  useEffect(() => {
    setImageFailed(false);
  }, [avatar]);

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
        background: avatarSrc ? 'transparent' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        fontWeight: '600',
        fontSize: `${size / 2.5}px`
      }}
    >
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}
