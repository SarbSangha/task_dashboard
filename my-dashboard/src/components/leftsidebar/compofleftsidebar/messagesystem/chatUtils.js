import {
  formatRelativeDayIndia,
  formatTimeIndiaShort,
} from '../../../../utils/dateTime';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const EMOJI_GROUPS = [
  {
    id: 'smileys',
    label: 'Smileys',
    emoji: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😜', '🤪', '🤗', '🤔', '🤨', '😐', '😑', '😶', '🙄', '😏', '😬', '😌', '😔', '😴', '😷', '🤒', '🥳', '😎', '🤓', '😕', '😟', '😮', '😲', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯', '😱'],
  },
  {
    id: 'gestures',
    label: 'Gestures',
    emoji: ['👍', '👎', '👌', '✌️', '🤞', '🤝', '🙏', '👏', '🙌', '👋', '🤙', '💪', '👀', '🫡', '🤷', '🤦', '🙋', '💁', '🙆', '🙅'],
  },
  {
    id: 'work',
    label: 'Work',
    emoji: ['✅', '☑️', '✔️', '❌', '⚠️', '❗', '❓', '📌', '📎', '📁', '📂', '📄', '📝', '📊', '📈', '📉', '🗓️', '⏰', '⏳', '💡', '🔥', '🚀', '🎯', '🏆', '🎉', '🔔', '🔒', '🔑', '💻', '📱', '🎨', '🎬', '🎵', '📷'],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    emoji: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💯', '✨', '⭐', '🌟', '⚡', '☀️', '🌈', '☕', '🍕', '🍰', '🌹', '🎁'],
  },
];

// Consecutive messages from one sender within this window render as a single
// visual group (one avatar + name, tighter spacing).
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export const buildAttachmentCountLabel = (attachments = []) => {
  const count = Array.isArray(attachments) ? attachments.filter(Boolean).length : 0;
  if (!count) return '';
  return `${count} attachment${count === 1 ? '' : 's'}`;
};

export const buildConversationPreview = (message, attachments = []) =>
  `${message || ''}`.trim() || buildAttachmentCountLabel(attachments);

export const buildInitials = (value) =>
  (value || '')
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'G';

export const buildAvatarHue = (value) =>
  Array.from(value || 'group').reduce((total, char) => total + char.charCodeAt(0), 0) % 360;

export const formatMessageTime = (value) => {
  const formatted = formatTimeIndiaShort(value);
  return formatted === 'N/A' ? '' : formatted;
};

export const formatListTimestamp = (value) => {
  if (!value) return '';
  const dayLabel = formatRelativeDayIndia(value);
  if (dayLabel === 'Today') return formatMessageTime(value);
  return dayLabel === 'Recent' ? '' : dayLabel;
};

const toTime = (value) => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

const canGroupWith = (previous, current) => {
  if (!previous || !current) return false;
  if (Number(previous.senderId) !== Number(current.senderId)) return false;
  if (current.forwardMetadata || current.failed || previous.failed) return false;
  return Math.abs(toTime(current.createdAt) - toTime(previous.createdAt)) <= GROUP_WINDOW_MS;
};

const findFirstUnreadIndex = (messages, currentUserId, unreadCount) => {
  if (!unreadCount) return -1;
  let remaining = unreadCount;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (Number(message?.senderId) === Number(currentUserId) || message?.deletedAt) continue;
    remaining -= 1;
    if (remaining === 0) return index;
  }
  return -1;
};

/**
 * Flattens a thread into virtual-list rows: day separators, an optional
 * "new messages" divider before the first unread message, and message rows
 * tagged with their position inside a same-sender group.
 */
export const buildThreadItems = ({ messages = [], currentUserId, unreadCount = 0, prefix }) => {
  const items = [];
  const firstUnreadIndex = findFirstUnreadIndex(messages, currentUserId, unreadCount);
  let lastDayLabel = null;

  messages.forEach((message, index) => {
    const dayLabel = formatRelativeDayIndia(message.createdAt);
    let breaksGroup = false;
    if (dayLabel !== lastDayLabel) {
      items.push({ type: 'separator', id: `${prefix}-separator-${dayLabel}-${message.id}`, label: dayLabel });
      lastDayLabel = dayLabel;
      breaksGroup = true;
    }
    if (index === firstUnreadIndex) {
      items.push({
        type: 'unread',
        id: `${prefix}-unread`,
        label: `${unreadCount} new message${unreadCount === 1 ? '' : 's'}`,
      });
      breaksGroup = true;
    }

    const previous = messages[index - 1];
    const next = messages[index + 1];
    const nextBreaks = !next
      || formatRelativeDayIndia(next.createdAt) !== dayLabel
      || index + 1 === firstUnreadIndex;
    items.push({
      type: 'message',
      id: `${prefix}-message-${message.id}`,
      message,
      isGroupStart: breaksGroup || !canGroupWith(previous, message),
      isGroupEnd: nextBreaks || !canGroupWith(message, next),
    });
  });

  return items;
};

const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;

/** Splits plain text into text and link segments. */
export const linkifySegments = (text = '') => {
  const segments = [];
  let lastIndex = 0;
  let match;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const value = match[0];
    segments.push({
      type: 'link',
      value,
      href: /^https?:\/\//i.test(value) ? value : `https://${value}`,
    });
    lastIndex = match.index + value.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
};

export const hasFileDrag = (event) =>
  Array.from(event?.dataTransfer?.types || []).includes('Files');

const normalizeMentionToken = (value = '') =>
  `${value}`.toLowerCase().replace(/[^a-z0-9_-]/g, '');

export const buildMentionTokens = (person = {}) => {
  const tokens = new Set(
    `${person.name || ''}`
      .split(/\s+/)
      .map(normalizeMentionToken)
      .filter(Boolean)
  );
  const compactName = normalizeMentionToken(person.name || '');
  if (compactName) tokens.add(compactName);
  const emailLocal = `${person.email || ''}`.split('@')[0];
  const compactEmail = normalizeMentionToken(emailLocal);
  if (compactEmail) tokens.add(compactEmail);
  return Array.from(tokens);
};

export const extractMentionIdsFromText = (text = '', members = [], currentUserId = null) => {
  const typedTokens = new Set(
    Array.from(`${text}`.matchAll(/@([a-z0-9_-]+)/gi))
      .map((match) => normalizeMentionToken(match[1]))
      .filter(Boolean)
  );
  if (!typedTokens.size) return [];

  return members
    .filter((member) => member?.id && member.id !== currentUserId)
    .filter((member) => buildMentionTokens(member).some((token) => typedTokens.has(token)))
    .map((member) => member.id);
};

export const findMentionToken = (value = '') => normalizeMentionToken(value);
