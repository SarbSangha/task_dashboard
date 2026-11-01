// Shared display helpers for Inbox and Outbox task cards.
import { formatDateTimeIndia, formatRelativeDayIndia, formatTimeIndiaShort } from './dateTime';

export const humanize = (value = '') =>
  `${value || ''}`
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

export const getInitials = (value = '') =>
  `${value || ''}`
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

export const getAvatarHue = (value = '') =>
  Array.from(`${value || 'task'}`).reduce((total, char) => total + char.charCodeAt(0), 0) % 360;

// Colour family for a task status pill.
export const getStatusTone = (status = '') => {
  const normalized = `${status || ''}`.toLowerCase();
  if (['pending', 'assigned', 'forwarded'].includes(normalized)) return 'pending';
  if (normalized === 'in_progress') return 'progress';
  if (['submitted', 'under_review'].includes(normalized)) return 'review';
  if (normalized === 'need_improvement') return 'revision';
  if (['approved', 'completed'].includes(normalized)) return 'done';
  if (['cancelled', 'rejected'].includes(normalized)) return 'cancelled';
  if (normalized === 'draft') return 'draft';
  return 'pending';
};

export const getPriorityTone = (priority = '') => {
  const normalized = `${priority || ''}`.toLowerCase();
  if (['urgent', 'critical', 'high'].includes(normalized)) return 'high';
  if (normalized === 'medium') return 'medium';
  if (normalized === 'low') return 'low';
  return '';
};

// "Today, 4:30 pm" / "Yesterday, 9:02 am" / "21 Sept, 6:30 pm".
export const formatShortDateTime = (value) => {
  if (!value) return '';
  const day = formatRelativeDayIndia(value);
  const time = formatTimeIndiaShort(value);
  if (!time || time === 'N/A') return '';
  return day === 'Recent' ? time : `${day}, ${time}`;
};

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'rejected']);

/**
 * Deadline urgency for a task: tone drives the chip colour, meta is the short
 * human label ("Overdue", "Due today", "3 days left", "Completed on time").
 */
export const getDeadlineInfo = (task = {}) => {
  const normalizedStatus = `${task.status || ''}`.toLowerCase();
  if (!task.deadline) {
    return { tone: 'none', label: 'No deadline', meta: 'No deadline', full: '' };
  }

  const deadlineDate = new Date(task.deadline);
  if (Number.isNaN(deadlineDate.getTime())) {
    return { tone: 'none', label: formatDateTimeIndia(task.deadline) || 'Invalid date', meta: 'Check date', full: '' };
  }

  const full = formatDateTimeIndia(task.deadline);
  const label = formatShortDateTime(task.deadline) || full;
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const deadlineDayStart = new Date(deadlineDate);
  deadlineDayStart.setHours(0, 0, 0, 0);
  const diffMs = deadlineDate.getTime() - now;
  const diffDays = Math.round((deadlineDayStart.getTime() - todayStart.getTime()) / (24 * 60 * 60 * 1000));
  const isDeadlineMissed = diffMs < 0;

  const completionCandidates = [task.completedAt, task.approvedAt];
  if (['completed', 'approved'].includes(normalizedStatus)) {
    completionCandidates.push(task.updatedAt);
  }
  const recordedFinishDate = completionCandidates
    .filter(Boolean)
    .map((value) => new Date(value))
    .find((date) => !Number.isNaN(date.getTime())) || null;

  // A closed task is judged by final approval/completion time. The updated
  // timestamp is only a compatibility fallback for older completed records.
  if (recordedFinishDate) {
    const finishedLate = recordedFinishDate.getTime() > deadlineDate.getTime();
    return { tone: finishedLate ? 'late' : 'met', label, full, meta: finishedLate ? 'Completed late' : 'Completed on time' };
  }
  if (isDeadlineMissed && !TERMINAL_STATUSES.has(normalizedStatus)) {
    return { tone: 'overdue', label, full, meta: 'Overdue' };
  }
  if (TERMINAL_STATUSES.has(normalizedStatus)) {
    return { tone: isDeadlineMissed ? 'late' : 'met', label, full, meta: isDeadlineMissed ? 'Closed late' : 'Closed' };
  }
  if (diffDays <= 1) {
    return { tone: 'today', label, full, meta: diffDays <= 0 ? 'Due today' : 'Due tomorrow' };
  }
  if (diffDays <= 3) {
    return { tone: 'soon', label, full, meta: `${diffDays} days left` };
  }
  return { tone: 'ok', label, full, meta: `${diffDays} days left` };
};
