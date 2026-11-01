// Shared by TaskReportPanel and TaskReportDrawer.
export const DEADLINE_BADGES = {
  overdue: { label: 'Overdue', tone: 'danger' },
  due_soon: { label: 'Due soon', tone: 'warning' },
  on_track: { label: 'On track', tone: 'neutral' },
  met: { label: 'On time', tone: 'success' },
  missed: { label: 'Late', tone: 'danger-soft' },
  no_deadline: { label: 'No deadline', tone: 'muted' },
  closed: { label: 'Closed', tone: 'muted' },
};
