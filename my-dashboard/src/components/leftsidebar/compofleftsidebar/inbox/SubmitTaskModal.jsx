import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fileAPI, isRequestCanceled } from '../../../../services/api';
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from '../../../../utils/fileUploads';
import './InboxPanel.css';

const isWorkflowTask = (task) => Boolean(task?.workflowEnabled);

const getActiveStageLabel = (task) => {
  if (!isWorkflowTask(task)) return '';
  const order = Number(task?.currentStageOrder || 0);
  const title = `${task?.currentStageTitle || ''}`.trim();
  if (order && title) return `Stage ${order}: ${title}`;
  if (order) return `Stage ${order}`;
  return title;
};

const getViewerSubmission = (task = null) => {
  const summary = task?.workerSubmissions || {};
  if (summary.viewerSubmission && typeof summary.viewerSubmission === 'object') {
    return summary.viewerSubmission;
  }
  const workers = Array.isArray(summary.workers) ? summary.workers : [];
  if (workers.length <= 1) {
    return workers.find((worker) => worker?.submitted && worker?.submission)?.submission || null;
  }
  return null;
};

const createInitialState = (task = null) => ({
  resultText: getViewerSubmission(task)?.outputText || task?.resultText || '',
  comments: '',
  links: Array.isArray(getViewerSubmission(task)?.links)
    ? [...getViewerSubmission(task).links]
    : Array.isArray(task?.resultLinks)
      ? [...task.resultLinks]
      : [],
  linkInput: '',
  existingAttachments: Array.isArray(getViewerSubmission(task)?.attachments)
    ? [...getViewerSubmission(task).attachments]
    : Array.isArray(task?.resultAttachments)
      ? [...task.resultAttachments]
      : [],
  attachments: [],
  submitting: false,
  error: '',
  uploadProgress: {},
  uploadStatus: {},
});

const SubmitTaskModal = ({ isOpen, task, onClose, onSubmit }) => {
  const [formState, setFormState] = useState(() => createInitialState(task));
  const uploadControllersRef = useRef(new Map());
  const canceledUploadKeysRef = useRef(new Set());
  const attachmentKeyMapRef = useRef(new WeakMap());
  const attachmentKeySeqRef = useRef(0);

  const resetUploadState = useCallback(() => {
    uploadControllersRef.current.forEach((controller) => controller.abort());
    uploadControllersRef.current.clear();
    canceledUploadKeysRef.current.clear();
    attachmentKeyMapRef.current = new WeakMap();
    attachmentKeySeqRef.current = 0;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    resetUploadState();
    setFormState(createInitialState(task));
  }, [isOpen, resetUploadState, task]);

  useEffect(() => () => resetUploadState(), [resetUploadState]);

  if (!isOpen || !task) return null;

  const getAttachmentKey = (file) => {
    if (!file || typeof file !== 'object') {
      return `attachment-${attachmentKeySeqRef.current++}`;
    }
    if (!attachmentKeyMapRef.current.has(file)) {
      const name = getAttachmentDisplayName(file);
      const size = Number(file?.size || 0);
      const lastModified = Number(file?.lastModified || 0);
      const relativePath = `${file?.webkitRelativePath || file?.relativePath || ''}`;
      const nextKey = `${name}:${size}:${lastModified}:${relativePath}:${attachmentKeySeqRef.current++}`;
      attachmentKeyMapRef.current.set(file, nextKey);
    }
    return attachmentKeyMapRef.current.get(file);
  };

  const closeModal = () => {
    if (formState.submitting) return;
    resetUploadState();
    onClose?.();
  };

  const cancelAttachment = (index) => {
    setFormState((prev) => {
      const target = prev.attachments[index];
      if (!target) return prev;
      const key = getAttachmentKey(target);
      if (prev.submitting) {
        canceledUploadKeysRef.current.add(key);
        const activeController = uploadControllersRef.current.get(key);
        if (activeController) {
          activeController.abort();
        }
      }

      const nextUploadProgress = { ...prev.uploadProgress };
      const nextUploadStatus = { ...prev.uploadStatus };
      delete nextUploadProgress[key];
      delete nextUploadStatus[key];

      return {
        ...prev,
        attachments: prev.attachments.filter((_, itemIndex) => itemIndex !== index),
        uploadProgress: nextUploadProgress,
        uploadStatus: nextUploadStatus,
      };
    });
  };

  const addLink = () => {
    const value = (formState.linkInput || '').trim();
    if (!value) return;
    let normalized = value;
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    try {
      new URL(normalized);
    } catch {
      setFormState((prev) => ({ ...prev, error: 'Enter a valid link URL.' }));
      return;
    }
    setFormState((prev) => ({
      ...prev,
      links: [...prev.links, normalized],
      linkInput: '',
      error: '',
    }));
  };

  const removeLink = (index) => {
    setFormState((prev) => ({
      ...prev,
      links: prev.links.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const removeExistingAttachment = (index) => {
    setFormState((prev) => ({
      ...prev,
      existingAttachments: prev.existingAttachments.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const appendAttachments = (selectedFiles) => {
    const selected = Array.from(selectedFiles || []);
    if (!selected.length) return;
    setFormState((prev) => ({
      ...prev,
      attachments: mergeUniqueAttachments(prev.attachments, selected),
    }));
  };

  const openPicker = (mode) => {
    openSystemFilePicker({
      mode,
      onSelect: appendAttachments,
    });
  };

  const submitFromModal = async () => {
    const hasPayload =
      formState.resultText.trim() ||
      formState.links.length > 0 ||
      formState.existingAttachments.length > 0 ||
      formState.attachments.length > 0;
    if (!hasPayload) {
      setFormState((prev) => ({ ...prev, error: 'Add result text, links, or attachments before submitting.' }));
      return;
    }

    setFormState((prev) => ({ ...prev, submitting: true, error: '' }));
    try {
      let uploadedAttachments = [];
      const selectedAttachments = [...formState.attachments];
      if (selectedAttachments.length > 0) {
        for (let index = 0; index < selectedAttachments.length; index += 1) {
          const file = selectedAttachments[index];
          const key = getAttachmentKey(file);
          if (canceledUploadKeysRef.current.has(key)) {
            continue;
          }

          const controller = new AbortController();
          uploadControllersRef.current.set(key, controller);
          setFormState((prev) => ({
            ...prev,
            uploadProgress: {
              ...prev.uploadProgress,
              [key]: 0,
            },
            uploadStatus: {
              ...prev.uploadStatus,
              [key]: 'uploading',
            },
          }));

          try {
            const uploadRes = await fileAPI.uploadFiles([file], {
              signal: controller.signal,
              onFileProgress: ({ percent }) => {
                setFormState((prev) => ({
                  ...prev,
                  uploadProgress: {
                    ...prev.uploadProgress,
                    [key]: percent,
                  },
                }));
              },
            });
            uploadedAttachments = [...uploadedAttachments, ...(uploadRes?.data || [])];
            setFormState((prev) => ({
              ...prev,
              uploadProgress: {
                ...prev.uploadProgress,
                [key]: 100,
              },
              uploadStatus: {
                ...prev.uploadStatus,
                [key]: 'uploaded',
              },
            }));
          } catch (error) {
            if (isRequestCanceled(error)) {
              setFormState((prev) => ({
                ...prev,
                uploadStatus: {
                  ...prev.uploadStatus,
                  [key]: 'canceled',
                },
              }));
              continue;
            }
            throw error;
          } finally {
            uploadControllersRef.current.delete(key);
          }
        }
      }

      const hasFinalPayload =
        formState.resultText.trim() ||
        formState.links.length > 0 ||
        formState.existingAttachments.length > 0 ||
        uploadedAttachments.length > 0;
      if (!hasFinalPayload) {
        setFormState((prev) => ({
          ...prev,
          submitting: false,
          error: 'All selected uploads were canceled. Add result text, links, or keep at least one file.',
        }));
        return;
      }

      await onSubmit?.(task, {
        result_text: formState.resultText.trim(),
        comments: formState.comments.trim(),
        result_links: formState.links,
        result_attachments: [...formState.existingAttachments, ...uploadedAttachments],
      });

      resetUploadState();
      onClose?.();
    } catch (error) {
      setFormState((prev) => ({
        ...prev,
        submitting: false,
        error: error?.response?.data?.detail || error?.message || 'Submit failed',
      }));
    } finally {
      uploadControllersRef.current.clear();
      canceledUploadKeysRef.current.clear();
    }
  };

  return (
    <div className="forward-modal-overlay" onClick={formState.submitting ? undefined : closeModal}>
      <div className="submit-modal" onClick={(event) => event.stopPropagation()}>
        <h3>{getViewerSubmission(task) ? 'Edit Submitted Result' : (isWorkflowTask(task) ? 'Submit Stage Result' : 'Submit Task Result')}</h3>
        <p className="submit-modal-subtitle">{task?.title}</p>

        <div className="submit-task-info">
          <p><strong>Task ID:</strong> {task?.taskNumber || '-'}</p>
          <p><strong>Project ID:</strong> {task?.projectId || '-'}</p>
          <p><strong>Creator:</strong> {task?.creator?.name || 'Unknown'}</p>
          {isWorkflowTask(task) && (
            <p><strong>Active Stage:</strong> {getActiveStageLabel(task) || 'Current stage'}</p>
          )}
        </div>

        <label htmlFor="submit-result-text">
          {isWorkflowTask(task) ? 'Stage Output Details' : 'Result Details'}
        </label>
        <textarea
          id="submit-result-text"
          rows={4}
          value={formState.resultText}
          onChange={(event) => setFormState((prev) => ({ ...prev, resultText: event.target.value }))}
          placeholder={
            isWorkflowTask(task)
              ? 'Summarize what this stage completed, what the next stage should use, and any important handoff notes...'
              : 'Add result summary, steps completed, and outcome...'
          }
        />

        <label htmlFor="submit-result-notes">
          {isWorkflowTask(task) ? 'Handoff Note (optional)' : 'Submission Note (optional)'}
        </label>
        <textarea
          id="submit-result-notes"
          rows={2}
          value={formState.comments}
          onChange={(event) => setFormState((prev) => ({ ...prev, comments: event.target.value }))}
          placeholder="Optional note for reviewer..."
        />

        <label htmlFor="submit-link-input">Result Links</label>
        <div className="submit-link-row">
          <input
            id="submit-link-input"
            type="text"
            value={formState.linkInput}
            onChange={(event) => setFormState((prev) => ({ ...prev, linkInput: event.target.value }))}
            placeholder="https://example.com/file-or-resource"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addLink();
              }
            }}
          />
          <button type="button" onClick={addLink}>Add Link</button>
        </div>
        {formState.links.length > 0 && (
          <div className="submit-link-list">
            {formState.links.map((link, index) => (
              <div key={`${link}-${index}`} className="submit-link-item">
                <a href={link} target="_blank" rel="noreferrer">{link}</a>
                <button type="button" onClick={() => removeLink(index)}>Remove</button>
              </div>
            ))}
          </div>
        )}

        <label>Attach Files Or Folder (PDF, video, audio, docs)</label>
        <div className="submit-file-actions">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openPicker('files');
            }}
            disabled={formState.submitting}
          >
            Choose Files
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openPicker('folder');
            }}
            disabled={formState.submitting}
          >
            Choose Folder
          </button>
        </div>

        {formState.attachments.length > 0 && (
          <div className="submit-attachment-list">
            {formState.attachments.map((file, index) => {
              const attachmentKey = getAttachmentKey(file);
              const uploadStatus = formState.uploadStatus?.[attachmentKey] || (formState.submitting ? 'queued' : 'pending');
              const uploadProgress = formState.uploadProgress?.[attachmentKey] || 0;
              const uploadLabel = uploadStatus === 'uploading'
                ? `Uploading ${uploadProgress}%`
                : uploadStatus === 'uploaded'
                  ? 'Uploaded'
                  : uploadStatus === 'queued'
                    ? 'Queued'
                    : 'Ready';

              return (
                <div key={attachmentKey} className="submit-attachment-item">
                  <div className="submit-attachment-copy">
                    <span>{getAttachmentDisplayName(file)} ({Math.max(1, Math.round((file.size || 0) / 1024))} KB)</span>
                    <small>{uploadLabel}</small>
                  </div>
                  <button type="button" onClick={() => cancelAttachment(index)}>
                    {formState.submitting ? (uploadStatus === 'uploading' ? 'Cancel Upload' : 'Cancel File') : 'Remove'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {formState.existingAttachments.length > 0 && (
          <div className="submit-attachment-list">
            {formState.existingAttachments.map((file, index) => (
              <div key={`${getAttachmentDisplayName(file)}-${index}`} className="submit-attachment-item">
                <div className="submit-attachment-copy">
                  <span>{getAttachmentDisplayName(file)}</span>
                  <small>Already submitted</small>
                </div>
                <button type="button" onClick={() => removeExistingAttachment(index)} disabled={formState.submitting}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {formState.error && <p className="forward-modal-error">{formState.error}</p>}

        <div className="forward-modal-actions">
          <button type="button" onClick={closeModal} disabled={formState.submitting}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={formState.submitting}
            onClick={submitFromModal}
          >
            {formState.submitting ? 'Submitting...' : (getViewerSubmission(task) ? 'Update Submission' : (isWorkflowTask(task) ? 'Submit Stage' : 'Submit Result'))}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SubmitTaskModal;
