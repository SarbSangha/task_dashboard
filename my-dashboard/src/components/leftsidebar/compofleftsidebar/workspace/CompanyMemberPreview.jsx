import React, { useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '../../../common/UserAvatar';
import { activityAPI, isRequestCanceled, taskAPI } from '../../../../services/api';
import { getTaskPanelCache, setTaskPanelCache } from '../../../../utils/taskPanelCache';
import { formatDateIndia, formatDateTimeIndia } from '../../../../utils/dateTime';
import { buildFileDownloadUrl, buildFileOpenUrl } from '../../../../utils/fileLinks';
import FilePreviewModal from '../../../common/FilePreviewModal';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import './CompanyMemberPreview.css';

const NAV_ITEMS = [
  { id: 'inbox', label: 'Inbox', group: 'functional', description: 'Tasks assigned to this employee.' },
  { id: 'outbox', label: 'Outbox', group: 'functional', description: 'Tasks created or submitted by this employee.' },
  { id: 'activity', label: 'Activity Snapshot', group: 'functional', description: 'Live activity metrics when available.' },
  { id: 'profile', label: 'Profile Settings', group: 'user', description: 'Read-only profile details.' },
  { id: 'organization', label: 'Organization Details', group: 'user', description: 'Department, role, and employee information.' },
];

const MEMBER_TASK_PREVIEW_CACHE_TTL_MS = 60 * 1000;
const TASK_DATA_SECTION_IDS = new Set(['inbox', 'outbox', 'activity']);
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

function getLocalDateInputValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatActivityDateLabel(value) {
  if (!value) return 'selected date';
  return formatDateIndia(`${value}T00:00:00`);
}

function isSameLocalDate(value, dateInputValue) {
  if (!value || !dateInputValue) return false;
  return getLocalDateInputValue(value) === dateInputValue;
}

function taskMatchesDateFilter(task, dateInputValue) {
  if (!dateInputValue) return true;
  return ['createdAt', 'updatedAt', 'submittedAt', 'completedAt', 'deadline'].some((key) =>
    isSameLocalDate(task?.[key], dateInputValue)
  );
}

function buildTaskSearchText(task) {
  const assignedNames = Array.isArray(task?.assignedTo)
    ? task.assignedTo.map((assignee) => assignee?.name).filter(Boolean).join(' ')
    : '';

  return [
    task?.title,
    task?.taskNumber,
    task?.projectId,
    task?.projectName,
    task?.customerName,
    task?.reference,
    task?.status,
    task?.workflowStage,
    task?.priority,
    task?.fromDepartment,
    task?.toDepartment,
    task?.creator?.name,
    assignedNames,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function taskMatchesSearch(task, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return true;
  return buildTaskSearchText(task).includes(normalizedQuery);
}

function isClosedTaskStatus(status) {
  return ['approved', 'completed', 'cancelled', 'rejected'].includes(String(status || '').toLowerCase());
}

function isSameUserId(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function hasMissedReceivedTaskDeadline(task, memberId, now = new Date()) {
  if (!task?.deadline) return false;
  const deadline = new Date(task.deadline);
  if (Number.isNaN(deadline.getTime())) return false;

  const submittedByMember = isSameUserId(task.submittedBy, memberId);
  const submittedAt = task.submittedAt ? new Date(task.submittedAt) : null;
  if (submittedByMember && submittedAt && !Number.isNaN(submittedAt.getTime())) {
    return submittedAt.getTime() > deadline.getTime();
  }

  if (isClosedTaskStatus(task.status)) return false;
  return deadline.getTime() < now.getTime();
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

function formatTaskPersonList(people = []) {
  const names = people
    .map((person) => `${person?.name || ''}`.trim())
    .filter(Boolean);

  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function getOutboxRecipientName(task, memberId) {
  const assignedPeople = Array.isArray(task?.assignedTo) ? task.assignedTo : [];
  const selectedMemberIsCreator = isSameUserId(task?.creatorId, memberId);
  const selectedMemberSubmitted = isSameUserId(task?.submittedBy, memberId);

  if (selectedMemberIsCreator) {
    const assignedNames = formatTaskPersonList(assignedPeople);
    if (assignedNames) return assignedNames;
  }

  if (selectedMemberSubmitted && !selectedMemberIsCreator) {
    const creatorName = `${task?.creator?.name || ''}`.trim();
    if (creatorName) return creatorName;
  }

  const latestForward = Array.isArray(task?.forwardHistory)
    ? [...task.forwardHistory].reverse().find((entry) => entry?.toUser || entry?.toDepartment) || null
    : null;

  return (
    formatTaskPersonList(assignedPeople) ||
    `${latestForward?.toUser || ''}`.trim() ||
    `${task?.toDepartment || ''}`.trim() ||
    'N/A'
  );
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
  const taskIdsSignature = useMemo(() => tasks.map((task) => task.id).join('|'), [tasks]);

  useEffect(() => {
    if (openActionMenuId && !tasks.some((task) => task.id === openActionMenuId)) {
      setOpenActionMenuId(null);
    }
  }, [openActionMenuId, taskIdsSignature, tasks]);

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
                    onClick={() => setOpenActionMenuId((currentMenuId) => (currentMenuId === task.id ? null : task.id))}
                    aria-label="Task options"
                    aria-expanded={openActionMenuId === task.id}
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
  const [activeSection, setActiveSection] = useState('inbox');
  const [taskState, setTaskState] = useState({
    loading: false,
    error: '',
    tasks: [],
  });
  const [taskSearchQuery, setTaskSearchQuery] = useState('');
  const [taskDateFilter, setTaskDateFilter] = useState('');
  const [activityDate, setActivityDate] = useState(getLocalDateInputValue);
  const [activitySnapshotState, setActivitySnapshotState] = useState({
    loading: false,
    error: '',
    data: null,
  });
  const [workflowTask, setWorkflowTask] = useState(null);
  const [detailTask, setDetailTask] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setActiveSection('inbox');
      setTaskSearchQuery('');
      setTaskDateFilter('');
      setActivityDate(getLocalDateInputValue());
      setActivitySnapshotState({
        loading: false,
        error: '',
        data: null,
      });
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
    if (!isOpen || !member?.id || !TASK_DATA_SECTION_IDS.has(activeSection)) return;

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

  const previewData = useMemo(() => {
    if (!normalizedMember) {
      return {
        inboxTasks: [],
        outboxTasks: [],
        trackingTasks: [],
        assignedTaskCount: 0,
        receivedTaskCount: 0,
        selfAssignedTaskCount: 0,
        deadlineMissedCount: 0,
        openTaskCount: 0,
        completedTaskCount: 0,
        trackingStatusCounts: [],
      };
    }

    const isAssignedToSelectedMember = (task) =>
      Array.isArray(task.assignedTo) &&
      task.assignedTo.some((assignee) => String(assignee.id) === String(normalizedMember.id));

    const inboxTasks = taskState.tasks.filter(isAssignedToSelectedMember);
    const createdTasks = taskState.tasks.filter((task) => task.creatorId === normalizedMember.id);
    const createdTasksForSelectedDate = createdTasks.filter((task) => isSameLocalDate(task.createdAt, activityDate));
    const selfAssignedTasksForSelectedDate = createdTasksForSelectedDate.filter(isAssignedToSelectedMember);
    const assignedTasksForSelectedDate = createdTasksForSelectedDate.filter((task) => !isAssignedToSelectedMember(task));
    const receivedTasksForSelectedDate = inboxTasks.filter((task) =>
      isSameLocalDate(task.createdAt, activityDate) &&
      String(task.creatorId) !== String(normalizedMember.id)
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
    const deadlineMissedCount = inboxTasks.filter((task) =>
      hasMissedReceivedTaskDeadline(task, normalizedMember.id)
    ).length;

    return {
      inboxTasks,
      outboxTasks,
      trackingTasks,
      assignedTaskCount: assignedTasksForSelectedDate.length,
      receivedTaskCount: receivedTasksForSelectedDate.length,
      selfAssignedTaskCount: selfAssignedTasksForSelectedDate.length,
      deadlineMissedCount,
      openTaskCount: Math.max(trackingTasks.length - completedTaskCount, 0),
      completedTaskCount,
      trackingStatusCounts,
    };
  }, [activityDate, normalizedMember, taskState.tasks]);

  useEffect(() => {
    if (!isOpen || !member?.id || activeSection !== 'activity' || !activityDate) return;

    const controller = new AbortController();
    const isToday = activityDate === getLocalDateInputValue();

    setActivitySnapshotState({
      loading: true,
      error: '',
      data: isToday ? activity : null,
    });

    const loadActivitySnapshot = async () => {
      try {
        const response = await activityAPI.userActivity(
          member.id,
          { date: activityDate },
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;

        setActivitySnapshotState({
          loading: false,
          error: '',
          data: response?.data || null,
        });
      } catch (error) {
        if (isRequestCanceled(error) || controller.signal.aborted) return;

        setActivitySnapshotState({
          loading: false,
          error: error?.response?.data?.detail || 'Could not load activity for the selected date.',
          data: isToday ? activity : null,
        });
      }
    };

    void loadActivitySnapshot();

    return () => {
      controller.abort();
    };
  }, [activeSection, activity, activityDate, isOpen, member?.id]);

  if (!isOpen || !normalizedMember) return null;

  const functionalItems = NAV_ITEMS.filter((item) => item.group === 'functional');
  const userItems = NAV_ITEMS.filter((item) => item.group === 'user');
  const activeItem = NAV_ITEMS.find((item) => item.id === activeSection) || NAV_ITEMS[0];
  const todayActivityDate = getLocalDateInputValue();
  const selectedActivity = activitySnapshotState.data || (activityDate === todayActivityDate ? activity : null);
  const hasActivitySnapshot =
    !!selectedActivity &&
    Object.values(selectedActivity).some((value) => value !== null && value !== undefined && value !== '');
  const selectedActivityDateLabel = formatActivityDateLabel(activityDate);
  const shouldShowTaskFilters = activeSection === 'inbox' || activeSection === 'outbox';
  const filterPreviewTasks = (tasks) =>
    tasks.filter((task) =>
      taskMatchesSearch(task, taskSearchQuery) &&
      taskMatchesDateFilter(task, taskDateFilter)
    );
  const filteredInboxTasks = filterPreviewTasks(previewData.inboxTasks);
  const filteredOutboxTasks = filterPreviewTasks(previewData.outboxTasks);
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
        <div className="company-member-preview-panel-body">
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
            {shouldShowTaskFilters ? (
              <div className="company-member-preview-header-tools">
                <div className="company-member-preview-header-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    type="search"
                    value={taskSearchQuery}
                    onChange={(event) => setTaskSearchQuery(event.target.value)}
                    placeholder="Search tasks, projects..."
                    aria-label={`Search ${activeItem.label.toLowerCase()} tasks`}
                  />
                </div>
                <label className="company-member-preview-header-date-filter">
                  <span>Date</span>
                  <input
                    type="date"
                    value={taskDateFilter}
                    onChange={(event) => setTaskDateFilter(event.target.value)}
                    aria-label={`Filter ${activeItem.label.toLowerCase()} tasks by date`}
                  />
                  {taskDateFilter ? (
                    <button type="button" onClick={() => setTaskDateFilter('')} aria-label="Clear date filter">
                      ×
                    </button>
                  ) : null}
                </label>
              </div>
            ) : null}
            <button type="button" className="company-member-preview-close" onClick={onClose}>
              ✕
            </button>
          </div>

          {taskState.error && activeItem.group === 'functional' && (
            <div className="company-member-preview-inline-note">{taskState.error}</div>
          )}

          {activeSection === 'inbox' && (
            <div className="company-member-preview-stack company-member-preview-task-section">
              <div className="company-member-preview-metrics-grid company-member-preview-metrics-grid-compact">
                <SummaryMetric label="Assigned Tasks" value={filteredInboxTasks.length} tone="info" />
                <SummaryMetric
                  label="Active Inbox Tasks"
                  value={filteredInboxTasks.filter((task) => !['approved', 'completed'].includes(String(task.status || '').toLowerCase())).length}
                  tone="warning"
                />
              </div>
              {taskState.loading ? (
                <div className="company-member-preview-empty-state">Loading inbox preview...</div>
              ) : (
                <TaskList
                  tasks={filteredInboxTasks}
                  emptyMessage="No inbox tasks found for this employee."
                  scrollable
                  actionMenuBuilder={buildTrackingTaskActions}
                  metaBuilder={(task) => [
                    { label: 'From', value: task.creator?.name || 'Unknown' },
                    { label: 'Workflow', value: formatTaskStatus(task.workflowStage || task.status) },
                    { label: 'Created', value: formatTaskDate(task.createdAt) },
                    { label: 'Updated', value: formatTaskDate(task.updatedAt || task.createdAt) },
                  ]}
                  extraContentBuilder={(task) => <TrackingMetroLine task={task} />}
                />
              )}
            </div>
          )}

          {activeSection === 'outbox' && (
            <div className="company-member-preview-stack company-member-preview-task-section">
              <div className="company-member-preview-metrics-grid company-member-preview-metrics-grid-compact">
                <SummaryMetric label="Created / Submitted" value={filteredOutboxTasks.length} tone="accent" />
                <SummaryMetric
                  label="Approved"
                  value={filteredOutboxTasks.filter((task) => String(task.status || '').toLowerCase() === 'approved').length}
                  tone="success"
                />
              </div>
              {taskState.loading ? (
                <div className="company-member-preview-empty-state">Loading outbox preview...</div>
              ) : (
                <TaskList
                  tasks={filteredOutboxTasks}
                  emptyMessage="No outbox tasks found for this employee."
                  scrollable
                  actionMenuBuilder={buildTrackingTaskActions}
                  metaBuilder={(task) => [
                    { label: 'To', value: getOutboxRecipientName(task, normalizedMember.id) },
                    { label: 'Workflow', value: formatTaskStatus(task.workflowStage || task.status) },
                    { label: 'Created', value: formatTaskDate(task.createdAt) },
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
              <div className="company-member-preview-card-heading-row">
                <div>
                  <h4>Activity Snapshot</h4>
                  <p>Showing recorded metrics for {selectedActivityDateLabel}.</p>
                </div>
                <label className="company-member-preview-date-control">
                  <span>Select Date</span>
                  <input
                    type="date"
                    value={activityDate}
                    max={todayActivityDate}
                    onChange={(event) => setActivityDate(event.target.value)}
                  />
                </label>
              </div>

              {activitySnapshotState.error ? (
                <div className="company-member-preview-inline-note">{activitySnapshotState.error}</div>
              ) : null}

              {activitySnapshotState.loading && !hasActivitySnapshot ? (
                <div className="company-member-preview-empty-state">
                  Loading activity for {selectedActivityDateLabel}...
                </div>
              ) : hasActivitySnapshot ? (
                <>
                  {activitySnapshotState.loading ? (
                    <div className="company-member-preview-subtle-note">
                      Refreshing activity for {selectedActivityDateLabel}...
                    </div>
                  ) : null}
                  {!selectedActivity?.id ? (
                    <div className="company-member-preview-subtle-note">
                      No activity row was recorded for {selectedActivityDateLabel}; showing zeroed metrics.
                    </div>
                  ) : null}
                  <div className="company-member-preview-stats-grid">
                    <ReadOnlyField label="Activity Date" value={formatDateIndia(selectedActivity?.date)} />
                    <ReadOnlyField label="Status" value={selectedActivity?.status || 'OFFLINE'} />
                    <ReadOnlyField label="Session Duration" value={formatSeconds(selectedActivity?.totalSessionDuration || 0)} />
                    <ReadOnlyField label="Active Duration" value={formatSeconds(selectedActivity?.activeTime || 0)} />
                    <ReadOnlyField label="Idle Duration" value={formatSeconds(selectedActivity?.idleTime || 0)} />
                    <ReadOnlyField label="Away Duration" value={formatSeconds(selectedActivity?.awayTime || 0)} />
                    <ReadOnlyField label="Heartbeat Count" value={selectedActivity?.heartbeatCount ?? 0} />
                    <ReadOnlyField label="Productivity" value={`${selectedActivity?.productivity ?? 0}%`} />
                    <ReadOnlyField label="Tasks Done" value={selectedActivity?.tasksDone ?? 0} />
                    <ReadOnlyField label="Tasks Assigned" value={previewData.assignedTaskCount} />
                    <ReadOnlyField label="Task Received" value={previewData.receivedTaskCount} />
                    <ReadOnlyField label="Self Assign Task" value={previewData.selfAssignedTaskCount} />
                    <ReadOnlyField label="Deadline Missed Till Today" value={previewData.deadlineMissedCount} />
                    <ReadOnlyField label="Last Seen" value={formatDateTimeIndia(selectedActivity?.lastSeen)} />
                  </div>
                </>
              ) : (
                <div className="company-member-preview-empty-state">
                  Activity details are not available for {selectedActivityDateLabel}.
                </div>
              )}
            </div>
          )}
          </section>
        </div>
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
