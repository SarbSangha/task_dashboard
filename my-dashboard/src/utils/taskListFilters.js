// Shared client-side helpers for the Inbox / Outbox / Tracking task lists.
//
// Search (`q`) and the date range are applied server-side by the list
// endpoints so they reach every matching task, not just the page already in
// memory. These helpers are the local mirror of that intent: they keep counts
// and the "still typing" refinement consistent with what the server returns,
// and must never hide a row the server chose to include.

export const getLocalDateKey = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const TASK_ACTIVITY_FIELDS = [
  'createdAt',
  'updatedAt',
  'sentAt',
  'submittedAt',
  'completedAt',
  'approvedAt',
  'currentStageStartedAt',
  'currentStageEndedAt',
];

/**
 * A task matches a picked day when that day falls inside the task's activity
 * span [created ... last touched]. This mirrors the server's date_from/date_to
 * interval filter, so a row the server returned is never filtered out again
 * locally (the old "exact timestamp on that day" check did exactly that).
 */
export const doesTaskMatchDate = (task, selectedDate) => {
  if (!selectedDate) return true;
  const activityKeys = TASK_ACTIVITY_FIELDS
    .map((field) => getLocalDateKey(task?.[field]))
    .filter(Boolean);
  if (activityKeys.length === 0) return true;
  const startKey = getLocalDateKey(task?.createdAt)
    || activityKeys.reduce((a, b) => (b < a ? b : a));
  const endKey = activityKeys.reduce((a, b) => (b > a ? b : a));
  return startKey <= selectedDate && selectedDate <= endKey;
};

export const getTaskSearchText = (task) => [
  task?.title,
  task?.taskNumber,
  task?.projectName,
  task?.projectId,
  task?.customerName,
  task?.reference,
  task?.status,
  task?.priority,
  task?.description,
  task?.currentStageTitle,
  task?.creator?.name,
  task?.creator?.email,
  ...(Array.isArray(task?.assignedTo)
    ? task.assignedTo.map((person) => `${person?.name || ''} ${person?.email || ''}`)
    : []),
].filter(Boolean).join(' ').toLowerCase();
