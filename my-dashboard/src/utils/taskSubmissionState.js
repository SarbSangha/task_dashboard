const asArray = (value) => (Array.isArray(value) ? value : []);

const idsMatch = (left, right) => (
  left != null
  && right != null
  && String(left) === String(right)
);

const hasResultPayload = (task = null) => (
  Boolean(`${task?.resultText || ''}`.trim())
  || asArray(task?.resultLinks).length > 0
  || asArray(task?.resultAttachments).length > 0
);

export const getWorkerSubmissionRows = (task = null) => (
  Array.isArray(task?.workerSubmissions?.workers) ? task.workerSubmissions.workers : []
);

export const hasMultipleTaskWorkers = (task = null) => {
  const workerRows = getWorkerSubmissionRows(task);
  const assignedRows = asArray(task?.assignedTo);
  return workerRows.length > 1 || assignedRows.length > 1;
};

export const getViewerSubmission = (task = null, currentUserId = null) => {
  const summary = task?.workerSubmissions || {};
  if (summary.viewerSubmission && typeof summary.viewerSubmission === 'object') {
    return summary.viewerSubmission;
  }

  const workerRows = getWorkerSubmissionRows(task);
  if (currentUserId != null) {
    const viewerRow = workerRows.find((worker) => idsMatch(worker?.id, currentUserId));
    if (viewerRow?.submitted && viewerRow?.submission && typeof viewerRow.submission === 'object') {
      return viewerRow.submission;
    }
  }

  if (workerRows.length <= 1) {
    const submittedRow = workerRows.find((worker) => worker?.submitted && worker?.submission);
    if (submittedRow?.submission && typeof submittedRow.submission === 'object') {
      return submittedRow.submission;
    }
  }

  if (currentUserId != null && idsMatch(task?.submittedBy, currentUserId) && hasResultPayload(task)) {
    return {
      outputText: task?.resultText || '',
      links: asArray(task?.resultLinks),
      attachments: asArray(task?.resultAttachments),
      submittedAt: task?.submittedAt || null,
      submittedByUserId: currentUserId,
    };
  }

  if (!hasMultipleTaskWorkers(task) && hasResultPayload(task)) {
    return {
      outputText: task?.resultText || '',
      links: asArray(task?.resultLinks),
      attachments: asArray(task?.resultAttachments),
      submittedAt: task?.submittedAt || null,
      submittedByUserId: task?.submittedBy || null,
    };
  }

  return null;
};

export const hasViewerSubmittedTaskPart = (task = null, currentUserId = null) => (
  Boolean(task?.workerSubmissions?.viewerSubmitted || getViewerSubmission(task, currentUserId))
);

export const hasViewerStartedTaskPart = (task = null, currentUserId = null) => {
  if (hasViewerSubmittedTaskPart(task, currentUserId)) return true;
  if (task?.workerSubmissions?.viewerStarted) return true;

  const workerRows = getWorkerSubmissionRows(task);
  if (currentUserId != null) {
    const viewerRow = workerRows.find((worker) => idsMatch(worker?.id, currentUserId));
    if (viewerRow?.started) return true;
  }

  return false;
};
