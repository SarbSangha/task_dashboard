import React, { useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '../../../common/UserAvatar';
import { taskAPI } from '../../../../services/api';
import { getTaskPanelCache, setTaskPanelCache } from '../../../../utils/taskPanelCache';
import { formatDateIndia, formatDateTimeIndia } from '../../../../utils/dateTime';
import { buildFileDownloadUrl, buildFileOpenUrl } from '../../../../utils/fileLinks';
import FilePreviewModal from '../../../common/FilePreviewModal';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import './CompanyMemberPreview.css';

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', group: 'functional', description: 'Quick read-only summary of the selected user interface.' },
  { id: 'inbox', label: 'Inbox', group: 'functional', description: 'Tasks assigned to this employee.' },
  { id: 'outbox', label: 'Outbox', group: 'functional', description: 'Tasks created or submitted by this employee.' },
  { id: 'tracking', label: 'Task Tracking', group: 'functional', description: 'Progress and status snapshot for this employee.' },
  { id: 'profile', label: 'Profile Settings', group: 'user', description: 'Read-only profile details.' },
  { id: 'organization', label: 'Organization Details', group: 'user', description: 'Department, role, and employee information.' },
  { id: 'activity', label: 'Activity Snapshot', group: 'user', description: 'Live activity metrics when available.' },
];

const MEMBER_TASK_PREVIEW_CACHE_TTL_MS = 60 * 1000;
const FUNCTIONAL_SECTION_IDS = new Set(['overview', 'inbox', 'outbox', 'tracking']);
const memberTaskPreviewRequests = new Map();
function buildMemberTaskPreviewCacheKey(memberId) {
  return `company_member_preview_tasks_${memberId}`;
}

async function loadMemberPreviewTasks(memberId) {
  const cacheKey = buildMemberTaskPreviewCacheKey(memberId);
  const cachedEntry = getTaskPanelCache(cacheKey, MEMBER_TASK_PREVIEW_CACHE_TTL_MS);
  if (Array.isArray(cachedEntry?.tasks)) {
    return cachedEntry.tasks;
  }

  if (memberTaskPreviewRequests.has(memberId)) {
    return memberTaskPreviewRequests.get(memberId);
  }

  const request = taskAPI
    .getAllTasks({ user_id: memberId })
    .then((response) => {
      const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
      setTaskPanelCache(cacheKey, { tasks });
      return tasks;
    })
    .finally(() => {
      memberTaskPreviewRequests.delete(memberId);
    });

  memberTaskPreviewRequests.set(memberId, request);
  return request;
}

function formatSeconds(seconds = 0) {
  const total = Number(seconds) || 0;
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hrs}h ${mins}m ${secs}s`;
}

function ReadOnlyField({ label, value }) {
  const displayValue =
    value === null || value === undefined || value === ''
      ? 'N/A'
      : value;

  return (
    <div className="company-member-preview-field">
      <span>{label}</span>
      <strong>{displayValue}</strong>
    </div>
  );
}

function formatTaskStatus(value) {
  return String(value || 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTaskDate(value) {
  return formatDateIndia(value);
}

function formatAttachmentName(item, index = 0) {
  if (typeof item === 'string') {
    const cleanValue = item.split('?')[0];
    const segments = cleanValue.split('/');
    return segments[segments.length - 1] || `Attachment ${index + 1}`;
  }

  if (item?.relativePath) {
    const segments = String(item.relativePath).split(/[\\/]/);
    return segments[segments.length - 1] || item.relativePath;
  }

  return item?.originalName || item?.filename || `Attachment ${index + 1}`;
}

function buildFileActionUrl(item, action) {
  if (action === 'download') {
    return buildFileDownloadUrl(item, formatAttachmentName(item));
  }
  return buildFileOpenUrl(item);
}

function SummaryMetric({ label, value, tone = 'default' }) {
  return (
    <div className={`company-member-preview-metric company-member-preview-metric-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function buildTrackingStations(task) {
  const normalizedStatus = String(task?.status || '').toLowerCase();
  const hasAssignment = Boolean(task?.toDepartment) || (Array.isArray(task?.assignedTo) && task.assignedTo.length > 0);
  const started = Boolean(task?.startedAt) || ['in_progress', 'submitted', 'under_review', 'need_improvement', 'approved', 'completed', 'rejected'].includes(normalizedStatus);
  const submitted = Boolean(task?.submittedAt) || ['submitted', 'under_review', 'need_improvement', 'approved', 'completed', 'rejected'].includes(normalizedStatus);
  const approved = Boolean(task?.completedAt) || ['approved', 'completed'].includes(normalizedStatus);

  let currentStation = 'created';
  if (['approved', 'completed'].includes(normalizedStatus)) currentStation = 'approved';
  else if (['submitted', 'under_review', 'need_improvement', 'rejected'].includes(normalizedStatus)) currentStation = 'submitted';
  else if (normalizedStatus === 'in_progress') currentStation = 'started';
  else if (hasAssignment) currentStation = 'assigned';

  const stations = [
    { id: 'created', label: 'Created', completed: true },
    { id: 'assigned', label: 'Assigned', completed: hasAssignment },
    { id: 'started', label: 'Started', completed: started },
    { id: 'submitted', label: 'Submitted', completed: submitted },
    { id: 'approved', label: approved ? 'Completed' : 'Approved', completed: approved },
  ];

  return stations.map((station) => ({
    ...station,
    current: !station.completed && station.id === currentStation,
  }));
}

function TrackingMetroLine({ task }) {
  const stations = buildTrackingStations(task);

  return (
    <div className="company-member-preview-metro-line" aria-label="Task tracking progress">
      {stations.map((station, index) => {
        const nextStation = stations[index + 1];
        const connectorActive = station.completed && (nextStation?.completed || nextStation?.current);

        return (
          <React.Fragment key={`${task.id}-${station.id}`}>
            <div
              className={`company-member-preview-metro-stop ${station.completed ? 'completed' : ''} ${station.current ? 'current' : ''}`}
            >
              <div className="company-member-preview-metro-dot" />
              <span>{station.label}</span>
            </div>
            {nextStation && (
              <div
                className={`company-member-preview-metro-connector ${connectorActive ? 'active' : ''}`}
                aria-hidden="true"
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function TaskArtifactsSection({ title, items, type = 'files', onPreviewFile }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <div className="company-member-preview-detail-section">
      <h4>{title}</h4>
      <div className="company-member-preview-artifact-list">
        {items.map((item, index) => {
          if (type === 'links') {
            const href = typeof item === 'string' ? item : item?.url;
            if (!href) return null;

            return (
              <a
                key={`${title}-${href}-${index}`}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="company-member-preview-link-item"
              >
                {href}
              </a>
            );
          }

          const hasPreview = typeof item === 'string' || item?.url || item?.path;
          const previewHref = hasPreview ? buildFileActionUrl(item, 'preview') : '';
          const downloadHref = hasPreview ? buildFileActionUrl(item, 'download') : '';

          return (
            <div key={`${title}-${formatAttachmentName(item, index)}-${index}`} className="company-member-preview-artifact-item">
              <div>
                <strong>{formatAttachmentName(item, index)}</strong>
                {'relativePath' in Object(item || {}) && item?.relativePath ? (
                  <span>{item.relativePath}</span>
                ) : null}
              </div>
              <div className="company-member-preview-artifact-actions">
                {hasPreview && (
                  <button type="button" onClick={() => previewHref && onPreviewFile?.(item)}>
                    Preview
                  </button>
                )}
                {hasPreview && (
                  <a href={downloadHref}>
                    Download
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReadOnlyTaskDetailsModal({ task, onClose }) {
  const [previewFile, setPreviewFile] = useState(null);
  if (!task) return null;

  const assignedMembers = Array.isArray(task.assignedTo) && task.assignedTo.length > 0
    ? task.assignedTo.map((assignee) => assignee.name).join(', ')
    : 'Not assigned';
  const forwardHistory = Array.isArray(task.forwardHistory) ? task.forwardHistory : [];

  return (
    <>
      <div className="company-member-preview-detail-backdrop" onClick={onClose} />
      <div
        className="company-member-preview-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${task.title || 'Task'} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="company-member-preview-detail-header">
          <div>
            <h3>{task.title || 'Untitled task'}</h3>
            <p>{task.taskNumber || task.projectId || 'Task reference unavailable'}</p>
          </div>
          <button type="button" className="company-member-preview-detail-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="company-member-preview-detail-body">
          <div className="company-member-preview-detail-grid">
            <ReadOnlyField label="Status" value={formatTaskStatus(task.status)} />
            <ReadOnlyField label="Workflow Stage" value={formatTaskStatus(task.workflowStage || task.status)} />
            <ReadOnlyField label="Priority" value={formatTaskStatus(task.priority)} />
            <ReadOnlyField label="Task Type" value={formatTaskStatus(task.taskType || 'task')} />
            <ReadOnlyField label="Project" value={task.projectName || 'N/A'} />
            <ReadOnlyField label="Customer" value={task.customerName || 'N/A'} />
            <ReadOnlyField label="From Department" value={task.fromDepartment || task.creator?.department || 'N/A'} />
            <ReadOnlyField label="To Department" value={task.toDepartment || 'N/A'} />
            <ReadOnlyField label="Created By" value={task.creator?.name || 'Unknown'} />
            <ReadOnlyField label="Assigned To" value={assignedMembers} />
            <ReadOnlyField label="Reference" value={task.reference || 'N/A'} />
            <ReadOnlyField label="Tag" value={task.taskTag || 'N/A'} />
            <ReadOnlyField label="Created At" value={formatDateTimeIndia(task.createdAt)} />
            <ReadOnlyField label="Started At" value={formatDateTimeIndia(task.startedAt)} />
            <ReadOnlyField label="Submitted At" value={formatDateTimeIndia(task.submittedAt)} />
            <ReadOnlyField label="Updated At" value={formatDateTimeIndia(task.updatedAt)} />
            <ReadOnlyField label="Completed At" value={formatDateTimeIndia(task.completedAt)} />
            <ReadOnlyField label="Deadline" value={formatDateTimeIndia(task.deadline)} />
          </div>

          {(task.description || task.resultText) && (
            <div className="company-member-preview-detail-section">
              <h4>Task Notes</h4>
              {task.description ? (
                <div className="company-member-preview-detail-text-block">
                  <span>Task Description</span>
                  <p>{task.description}</p>
                </div>
              ) : null}
              {task.resultText ? (
                <div className="company-member-preview-detail-text-block">
                  <span>Result Notes</span>
                  <p>{task.resultText}</p>
                </div>
              ) : null}
            </div>
          )}

          <TaskArtifactsSection title="Input Attachments" items={task.attachments} onPreviewFile={setPreviewFile} />
          <TaskArtifactsSection title="Reference Links" items={task.links} type="links" />
          <TaskArtifactsSection title="Result Attachments" items={task.resultAttachments} onPreviewFile={setPreviewFile} />
          <TaskArtifactsSection title="Result Links" items={task.resultLinks} type="links" />

          {forwardHistory.length > 0 && (
            <div className="company-member-preview-detail-section">
              <h4>Forward History</h4>
              <div className="company-member-preview-journey-list">
                {forwardHistory.map((entry) => (
                  <div key={entry.id} className="company-member-preview-journey-item">
                    <strong>{entry.fromUser || 'Unknown'} → {entry.toUser || entry.toDepartment || 'Next owner'}</strong>
                    <span>{entry.reason || 'Forwarded without note'}</span>
                    <small>{formatDateTimeIndia(entry.createdAt)}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {previewFile ? (
        <FilePreviewModal
          file={previewFile}
          title={formatAttachmentName(previewFile)}
          subtitle={`${task.title || 'Task'}${task.taskNumber ? ` • ${task.taskNumber}` : ''}`}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
    </>
  );
}

function TaskList({
  tasks,
  emptyMessage,
  metaBuilder,
  scrollable = false,
  extraContentBuilder = null,
  actionMenuBuilder = null,
}) {
  const [openActionMenuId, setOpenActionMenuId] = useState(null);

  useEffect(() => {
    setOpenActionMenuId(null);
  }, [tasks]);

  if (tasks.length === 0) {
    return <div className="company-member-preview-empty-state">{emptyMessage}</div>;
  }

  return (
    <div className={`company-member-preview-task-list ${scrollable ? 'scrollable' : ''}`}>
      {tasks.map((task) => (
        <article key={task.id} className="company-member-preview-task-card">
          <div className="company-member-preview-task-card-head">
            <div>
              <h5>{task.title || 'Untitled task'}</h5>
              <p>{task.taskNumber || task.projectId || 'Task reference unavailable'}</p>
            </div>
            <div className="company-member-preview-task-card-head-right">
              <span className={`company-member-preview-task-status status-${String(task.status || 'unknown').toLowerCase()}`}>
                {formatTaskStatus(task.status)}
              </span>
              {typeof actionMenuBuilder === 'function' ? (
                <div className="company-member-preview-task-menu-wrap" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="company-member-preview-task-menu-trigger"
                    onClick={() => setOpenActionMenuId(openActionMenuId === task.id ? null : task.id)}
                    aria-label="Task options"
                  >
                    ⋮
                  </button>
                  {openActionMenuId === task.id && (
                    <div className="company-member-preview-task-menu">
                      {actionMenuBuilder(task, () => setOpenActionMenuId(null))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          <div className="company-member-preview-task-meta">
            {metaBuilder(task).map((item) => (
              <div key={`${task.id}-${item.label}`} className="company-member-preview-task-meta-item">
                <span>{item.label}</span>
                <strong>
                  {item.value === null || item.value === undefined || item.value === ''
                    ? 'N/A'
                    : item.value}
                </strong>
              </div>
            ))}
          </div>
          {typeof extraContentBuilder === 'function' ? extraContentBuilder(task) : null}
        </article>
      ))}
    </div>
  );
}

export default function CompanyMemberPreview({
  isOpen,
  member,
  selectedDepartment,
  activity = null,
  onClose,
}) {
  const [activeSection, setActiveSection] = useState('overview');
  const [taskState, setTaskState] = useState({
    loading: false,
    error: '',
    tasks: [],
  });
  const [workflowTask, setWorkflowTask] = useState(null);
  const [detailTask, setDetailTask] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setActiveSection('overview');
    }
  }, [isOpen, member?.id]);

  useEffect(() => {
    setWorkflowTask(null);
    setDetailTask(null);
  }, [isOpen, member?.id]);

  useEffect(() => {
    if (!isOpen || !member?.id) {
      setTaskState({
        loading: false,
        error: '',
        tasks: [],
      });
      return;
    }

    const cachedEntry = getTaskPanelCache(
      buildMemberTaskPreviewCacheKey(member.id),
      MEMBER_TASK_PREVIEW_CACHE_TTL_MS
    );

    setTaskState({
      loading: false,
      error: '',
      tasks: Array.isArray(cachedEntry?.tasks) ? cachedEntry.tasks : [],
    });
  }, [isOpen, member?.id]);

  useEffect(() => {
    if (!isOpen || !member?.id || !FUNCTIONAL_SECTION_IDS.has(activeSection)) return;

    let isCancelled = false;
    const cachedEntry = getTaskPanelCache(
      buildMemberTaskPreviewCacheKey(member.id),
      MEMBER_TASK_PREVIEW_CACHE_TTL_MS
    );
    const hasCachedTasks = Array.isArray(cachedEntry?.tasks);

    setTaskState((current) => ({
      ...current,
      loading: !hasCachedTasks,
      error: '',
      tasks: hasCachedTasks ? cachedEntry.tasks : current.tasks,
    }));

    const loadTasks = async () => {
      try {
        const tasks = await loadMemberPreviewTasks(member.id);
        if (isCancelled) return;
        setTaskState({
          loading: false,
          error: '',
          tasks,
        });
      } catch (error) {
        if (isCancelled) return;
        setTaskState({
          loading: false,
          error: error?.response?.data?.detail || 'Could not load task preview data.',
          tasks: [],
        });
      }
    };

    void loadTasks();

    return () => {
      isCancelled = true;
    };
  }, [activeSection, isOpen, member?.id]);

  const normalizedMember = useMemo(() => {
    if (!member) return null;
    return {
      ...member,
      department: member.department || selectedDepartment || 'N/A',
      position: member.position || 'Member',
      employeeId: member.employeeId || 'N/A',
      roles: Array.isArray(member.roles) && member.roles.length > 0 ? member.roles.join(', ') : 'User',
    };
  }, [member, selectedDepartment]);

  const hasActivity =
    !!activity &&
    Object.values(activity).some((value) => value !== null && value !== undefined && value !== '');

  const previewData = useMemo(() => {
    if (!normalizedMember) {
      return {
        inboxTasks: [],
        outboxTasks: [],
        trackingTasks: [],
        openTaskCount: 0,
        completedTaskCount: 0,
        trackingStatusCounts: [],
      };
    }

    const inboxTasks = taskState.tasks.filter((task) =>
      Array.isArray(task.assignedTo) && task.assignedTo.some((assignee) => assignee.id === normalizedMember.id)
    );
    const outboxTasks = taskState.tasks.filter(
      (task) => task.creatorId === normalizedMember.id || task.submittedBy === normalizedMember.id
    );

    const trackingMap = new Map();
    [...outboxTasks, ...inboxTasks].forEach((task) => {
      trackingMap.set(task.id, task);
    });
    const trackingTasks = Array.from(trackingMap.values()).sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    });

    const trackingStatusMap = trackingTasks.reduce((accumulator, task) => {
      const key = String(task.status || 'unknown').toLowerCase();
      accumulator.set(key, (accumulator.get(key) || 0) + 1);
      return accumulator;
    }, new Map());

    const trackingStatusCounts = Array.from(trackingStatusMap.entries())
      .map(([status, count]) => ({
        status,
        count,
      }))
      .sort((left, right) => right.count - left.count);

    const completedTaskCount = trackingTasks.filter((task) =>
      ['approved', 'completed'].includes(String(task.status || '').toLowerCase())
    ).length;

    return {
      inboxTasks,
      outboxTasks,
      trackingTasks,
      openTaskCount: Math.max(trackingTasks.length - completedTaskCount, 0),
      completedTaskCount,
      trackingStatusCounts,
    };
  }, [normalizedMember, taskState.tasks]);

  if (!isOpen || !normalizedMember) return null;

  const functionalItems = NAV_ITEMS.filter((item) => item.group === 'functional');
  const userItems = NAV_ITEMS.filter((item) => item.group === 'user');
  const activeItem = NAV_ITEMS.find((item) => item.id === activeSection) || NAV_ITEMS[0];
  const overviewTrackingTasks = previewData.trackingTasks.slice(0, 4);
  const buildTrackingTaskActions = (task, closeMenu) => (
    <>
      <button
        type="button"
        onClick={() => {
          closeMenu();
          setWorkflowTask(task);
        }}
      >
        View Tracking Phases
      </button>
      <button
        type="button"
        onClick={() => {
          closeMenu();
          setDetailTask(task);
        }}
      >
        View Task Details
      </button>
    </>
  );

  return (
    <>
      <div className="company-member-preview-backdrop" onClick={onClose} />
      <div
        className="company-member-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${normalizedMember.name} profile preview`}
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="company-member-preview-sidebar">
          <div className="company-member-preview-sidebar-header">
            <div className="company-member-preview-avatar-wrap">
              <UserAvatar avatar={normalizedMember.avatar} name={normalizedMember.name} size={72} />
            </div>
            <h3>{normalizedMember.name}</h3>
            <p>{normalizedMember.position}</p>
            <span>{normalizedMember.department}</span>
          </div>

          <nav className="company-member-preview-nav">
            <div className="company-member-preview-nav-group-title">Functional Menu</div>
            {functionalItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`company-member-preview-nav-item ${activeSection === item.id ? 'active' : ''}`}
                onClick={() => setActiveSection(item.id)}
              >
                {item.label}
              </button>
            ))}
            <div className="company-member-preview-nav-group-title">User Panel</div>
            {userItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`company-member-preview-nav-item ${activeSection === item.id ? 'active' : ''}`}
                onClick={() => setActiveSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="company-member-preview-sidebar-footer">
            Faculty can browse this employee view, but all actions stay read-only.
          </div>
        </aside>

        <section className="company-member-preview-content">
          <div className="company-member-preview-content-header">
            <div>
              <h2>{activeItem.label}</h2>
              <p>{activeItem.description}</p>
            </div>
            <button type="button" className="company-member-preview-close" onClick={onClose}>
              ✕
            </button>
          </div>

          {taskState.error && activeItem.group === 'functional' && (
            <div className="company-member-preview-inline-note">{taskState.error}</div>
          )}

          {activeSection === 'overview' && (
            <div className="company-member-preview-stack">
              <div className="company-member-preview-metrics-grid">
                <SummaryMetric label="Inbox Tasks" value={previewData.inboxTasks.length} tone="info" />
                <SummaryMetric label="Outbox Tasks" value={previewData.outboxTasks.length} tone="accent" />
                <SummaryMetric label="Tracking Tasks" value={previewData.trackingTasks.length} tone="success" />
                <SummaryMetric label="Open Tasks" value={previewData.openTaskCount} tone="warning" />
              </div>

              <div className="company-member-preview-section-grid">
                <div className="company-member-preview-card">
                  <h4>User Snapshot</h4>
                  <ReadOnlyField label="Name" value={normalizedMember.name} />
                  <ReadOnlyField label="Department" value={normalizedMember.department} />
                  <ReadOnlyField label="Position" value={normalizedMember.position} />
                  <ReadOnlyField label="Status" value={activity?.status || 'Unavailable'} />
                </div>
                <div className="company-member-preview-card">
                  <h4>Task Summary</h4>
                  <ReadOnlyField label="Created / Submitted" value={previewData.outboxTasks.length} />
                  <ReadOnlyField label="Assigned" value={previewData.inboxTasks.length} />
                  <ReadOnlyField label="Completed" value={previewData.completedTaskCount} />
                  <ReadOnlyField label="Last Seen" value={formatDateTimeIndia(activity?.lastSeen)} />
                </div>
              </div>

              <div className="company-member-preview-card company-member-preview-card-wide">
                <h4>Recent Tracking Items</h4>
                {taskState.loading ? (
                  <div className="company-member-preview-empty-state">Loading task preview...</div>
                ) : (
                  <TaskList
                    tasks={overviewTrackingTasks}
                    emptyMessage="No tracking items found for this employee."
                    actionMenuBuilder={buildTrackingTaskActions}
                    metaBuilder={(task) => [
                      { label: 'Priority', value: formatTaskStatus(task.priority) },
                      { label: 'Updated', value: formatTaskDate(task.updatedAt || task.createdAt) },
                      { label: 'Department', value: task.toDepartment || task.fromDepartment || normalizedMember.department },
                    ]}
                  />
                )}
              </div>
            </div>
          )}

          {activeSection === 'inbox' && (
            <div className="company-member-preview-stack">
              <div className="company-member-preview-metrics-grid company-member-preview-metrics-grid-compact">
                <SummaryMetric label="Assigned Tasks" value={previewData.inboxTasks.length} tone="info" />
                <SummaryMetric
                  label="Active Inbox Tasks"
                  value={previewData.inboxTasks.filter((task) => !['approved', 'completed'].includes(String(task.status || '').toLowerCase())).length}
                  tone="warning"
                />
              </div>
              {taskState.loading ? (
                <div className="company-member-preview-empty-state">Loading inbox preview...</div>
              ) : (
                <TaskList
                  tasks={previewData.inboxTasks}
                  emptyMessage="No inbox tasks found for this employee."
                  scrollable
                  metaBuilder={(task) => [
                    { label: 'From', value: task.creator?.name || 'Unknown' },
                    { label: 'Priority', value: formatTaskStatus(task.priority) },
                    { label: 'Updated', value: formatTaskDate(task.updatedAt || task.createdAt) },
                  ]}
                />
              )}
            </div>
          )}

          {activeSection === 'outbox' && (
            <div className="company-member-preview-stack">
              <div className="company-member-preview-metrics-grid company-member-preview-metrics-grid-compact">
                <SummaryMetric label="Created / Submitted" value={previewData.outboxTasks.length} tone="accent" />
                <SummaryMetric
                  label="Approved"
                  value={previewData.outboxTasks.filter((task) => String(task.status || '').toLowerCase() === 'approved').length}
                  tone="success"
                />
              </div>
              {taskState.loading ? (
                <div className="company-member-preview-empty-state">Loading outbox preview...</div>
              ) : (
                <TaskList
                  tasks={previewData.outboxTasks}
                  emptyMessage="No outbox tasks found for this employee."
                  scrollable
                  metaBuilder={(task) => [
                    { label: 'To', value: task.toDepartment || 'N/A' },
                    { label: 'Assigned', value: Array.isArray(task.assignedTo) ? task.assignedTo.length : 0 },
                    { label: 'Updated', value: formatTaskDate(task.updatedAt || task.createdAt) },
                  ]}
                />
              )}
            </div>
          )}

          {activeSection === 'tracking' && (
            <div className="company-member-preview-stack">
              <div className="company-member-preview-card company-member-preview-card-wide">
                <h4>Tracking Status Breakdown</h4>
                {taskState.loading ? (
                  <div className="company-member-preview-empty-state">Loading tracking summary...</div>
                ) : previewData.trackingStatusCounts.length > 0 ? (
                  <div className="company-member-preview-status-grid">
                    {previewData.trackingStatusCounts.map((item) => (
                      <SummaryMetric
                        key={item.status}
                        label={formatTaskStatus(item.status)}
                        value={item.count}
                        tone="default"
                      />
                    ))}
                  </div>
                ) : (
                  <div className="company-member-preview-empty-state">No tracking data found for this employee.</div>
                )}
              </div>

              {taskState.loading ? (
                <div className="company-member-preview-empty-state">Loading tracking tasks...</div>
              ) : (
                <TaskList
                  tasks={previewData.trackingTasks}
                  emptyMessage="No tracking tasks found for this employee."
                  scrollable
                  actionMenuBuilder={buildTrackingTaskActions}
                  metaBuilder={(task) => [
                    { label: 'Priority', value: formatTaskStatus(task.priority) },
                    { label: 'Workflow', value: formatTaskStatus(task.workflowStage || task.status) },
                    { label: 'Updated', value: formatTaskDate(task.updatedAt || task.createdAt) },
                  ]}
                  extraContentBuilder={(task) => <TrackingMetroLine task={task} />}
                />
              )}
            </div>
          )}

          {activeSection === 'profile' && (
            <div className="company-member-preview-section-grid">
              <div className="company-member-preview-card">
                <h4>Basic Profile</h4>
                <ReadOnlyField label="Full Name" value={normalizedMember.name} />
                <ReadOnlyField label="Email" value={normalizedMember.email} />
                <ReadOnlyField label="Position" value={normalizedMember.position} />
              </div>
              <div className="company-member-preview-card">
                <h4>Profile Status</h4>
                <ReadOnlyField label="Current Status" value={activity?.status || 'Unavailable'} />
                <ReadOnlyField label="Last Seen" value={formatDateTimeIndia(activity?.lastSeen)} />
                <ReadOnlyField label="Last Login" value={formatDateTimeIndia(activity?.loginTime)} />
              </div>
            </div>
          )}

          {activeSection === 'organization' && (
            <div className="company-member-preview-section-grid">
              <div className="company-member-preview-card">
                <h4>Organization Details</h4>
                <ReadOnlyField label="Department" value={normalizedMember.department} />
                <ReadOnlyField label="Employee ID" value={normalizedMember.employeeId} />
                <ReadOnlyField label="Assigned Roles" value={normalizedMember.roles} />
              </div>
              <div className="company-member-preview-card">
                <h4>Access Mode</h4>
                <ReadOnlyField label="Preview Type" value="Faculty read-only access" />
                <ReadOnlyField label="Editing" value="Disabled" />
                <ReadOnlyField label="Source" value="Workspace company tab" />
              </div>
            </div>
          )}

          {activeSection === 'activity' && (
            <div className="company-member-preview-card company-member-preview-card-wide">
              <h4>Activity Snapshot</h4>
              {hasActivity ? (
                <div className="company-member-preview-stats-grid">
                  <ReadOnlyField label="Session Duration" value={formatSeconds(activity?.totalSessionDuration || 0)} />
                  <ReadOnlyField label="Active Duration" value={formatSeconds(activity?.activeTime || 0)} />
                  <ReadOnlyField label="Idle Duration" value={formatSeconds(activity?.idleTime || 0)} />
                  <ReadOnlyField label="Away Duration" value={formatSeconds(activity?.awayTime || 0)} />
                  <ReadOnlyField label="Heartbeat Count" value={activity?.heartbeatCount ?? 0} />
                  <ReadOnlyField label="Productivity" value={`${activity?.productivity ?? 0}%`} />
                  <ReadOnlyField label="Tasks Done Today" value={activity?.tasksDone ?? 0} />
                  <ReadOnlyField label="Last Seen" value={formatDateTimeIndia(activity?.lastSeen)} />
                </div>
              ) : (
                <div className="company-member-preview-empty-state">
                  Live activity details are not available for this preview.
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      <TaskWorkflow
        task={workflowTask}
        isOpen={!!workflowTask}
        onClose={() => setWorkflowTask(null)}
      />
      <ReadOnlyTaskDetailsModal
        task={detailTask}
        onClose={() => setDetailTask(null)}
      />
    </>
  );
}
