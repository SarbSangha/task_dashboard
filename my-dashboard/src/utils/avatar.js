const DATA_IMAGE_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;
const SUPPORTED_AVATAR_URL = /^(https?:\/\/|blob:|\/)/i;

export function normalizeAvatarSrc(avatar) {
  if (typeof avatar !== 'string') {
    return null;
  }

  const value = avatar.trim();
  if (!value) {
    return null;
  }

  if (DATA_IMAGE_PREFIX.test(value) || SUPPORTED_AVATAR_URL.test(value)) {
    return value;
  }

  return null;
}

export function getAvatarInitials(name) {
  return (
    name
      ?.split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?'
  );
}
