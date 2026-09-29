import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomDialogs } from '../../../../../common/CustomDialogs';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { bufferAPI } from '../../../../../../services/api';
import { downloadBlobResponse } from '../../../../../../services/reports';
import { normalizeApiError } from './bufferCaptureUtils';
import BufferSheetExportModal from './BufferSheetExportModal';
import '../ChatGptCaptureCenterTab.css';
import './BufferPurposeSheet.css';

const SAVE_DEBOUNCE_MS = 600;

/**
 * Buffer's "Purpose Sheet" - a live version of the spreadsheet the team used
 * to keep by hand: rows grouped under a colored purpose/event header
 * (Janmashtami, Teacher's Day, ...) with Audio Name / Client / Editor Name
 * columns. Backed by BufferSheetPurpose/BufferSheetRow (backend/models_new.py)
 * - a plannable pair of tables, separate from the read-only cross-tool Feed
 * and from BufferSelfUploadDownload's after-the-fact download log.
 *
 * Access is layered, mirroring buffer_router.py's Purpose Sheet section:
 *  - anyone with Buffer access can VIEW this (the whole component renders),
 *  - only someone with the separate buffer_sheet_edit grant (or an admin)
 *    can create a purpose or edit a row's fields - canEdit below,
 *  - only an admin can delete a purpose or row - isAdmin below.
 * There is no "add a row by hand" control at all: every row is created
 * server-side by the Client/Purpose download gate (BufferDownloadGateModal),
 * so what shows up here is always traceable to an actual download.
 */
export default function BufferPurposeSheet() {
  const { showAlert, showConfirm, showPrompt } = useCustomDialogs();
  const { isAdmin, can } = usePermissions();
  const canEdit = isAdmin || can('edit_buffer_sheet');
  const [purposes, setPurposes] = useState([]);
  const [clientSuggestions, setClientSuggestions] = useState([]);
  const [editorSuggestions, setEditorSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newPurposeName, setNewPurposeName] = useState('');
  const [creatingPurpose, setCreatingPurpose] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // rowId -> { timer, pending: {field: value} } - lets each edited cell save
  // on a short delay instead of one request per keystroke, without losing
  // in-flight edits to a stale request the way an un-debounced save-on-blur
  // would if the user tabs through cells quickly.
  const pendingSavesRef = useRef(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await bufferAPI.getSheet();
      setPurposes(Array.isArray(response.purposes) ? response.purposes : []);
      setClientSuggestions(Array.isArray(response.clientSuggestions) ? response.clientSuggestions : []);
      setEditorSuggestions(Array.isArray(response.editorSuggestions) ? response.editorSuggestions : []);
    } catch (fetchError) {
      setError(normalizeApiError(fetchError, 'Unable to load the Purpose Sheet.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => {
    // Flush nothing on unmount - in-flight debounced saves already fired
    // their setTimeout independently of the component tree, so they still
    // land; this just stops us leaking the timer handles themselves.
    pendingSavesRef.current.forEach(({ timer }) => window.clearTimeout(timer));
    pendingSavesRef.current.clear();
  }, []);

  const handleAddPurpose = async (event) => {
    event.preventDefault();
    const name = newPurposeName.trim();
    if (!name || creatingPurpose) return;
    setCreatingPurpose(true);
    try {
      const response = await bufferAPI.createPurpose({ name });
      setPurposes((prev) => [...prev, response.purpose]);
      setNewPurposeName('');
    } catch (createError) {
      await showAlert(normalizeApiError(createError, 'Unable to create that purpose.'), { title: 'Add Purpose Failed' });
    } finally {
      setCreatingPurpose(false);
    }
  };

  const handleRenamePurpose = async (purpose) => {
    const name = await showPrompt('Rename this purpose', {
      title: 'Rename Purpose',
      defaultValue: purpose.name,
    });
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed === purpose.name) return;
    try {
      const response = await bufferAPI.updatePurpose(purpose.id, { name: trimmed });
      setPurposes((prev) => prev.map((p) => (p.id === purpose.id ? { ...p, name: response.purpose.name } : p)));
    } catch (renameError) {
      await showAlert(normalizeApiError(renameError, 'Unable to rename this purpose.'), { title: 'Rename Failed' });
    }
  };

  const handleDeletePurpose = async (purpose) => {
    const ok = await showConfirm(
      `Delete "${purpose.name}" and all ${purpose.rows.length} row(s) in it? This cannot be undone.`,
      { title: 'Delete Purpose' }
    );
    if (!ok) return;
    try {
      await bufferAPI.deletePurpose(purpose.id);
      setPurposes((prev) => prev.filter((p) => p.id !== purpose.id));
    } catch (deleteError) {
      await showAlert(normalizeApiError(deleteError, 'Unable to delete this purpose.'), { title: 'Delete Failed' });
    }
  };

  const applyLocalRowEdit = (purposeId, rowId, field, value) => {
    setPurposes((prev) =>
      prev.map((p) =>
        p.id !== purposeId
          ? p
          : { ...p, rows: p.rows.map((r) => (r.id === rowId ? { ...r, [field]: value } : r)) }
      )
    );
  };

  const flushRowSave = useCallback(async (rowId) => {
    const entry = pendingSavesRef.current.get(rowId);
    if (!entry) return;
    pendingSavesRef.current.delete(rowId);
    window.clearTimeout(entry.timer);
    if (Object.keys(entry.pending).length === 0) return;
    try {
      await bufferAPI.updateRow(rowId, entry.pending);
    } catch (saveError) {
      await showAlert(normalizeApiError(saveError, 'A row edit failed to save - please reload and retry.'), {
        title: 'Save Failed',
      });
    }
  }, [showAlert]);

  const scheduleRowSave = useCallback((purposeId, rowId, field, value) => {
    applyLocalRowEdit(purposeId, rowId, field, value);
    const existing = pendingSavesRef.current.get(rowId);
    if (existing) window.clearTimeout(existing.timer);
    const pending = { ...(existing?.pending || {}), [field]: value };
    const timer = window.setTimeout(() => flushRowSave(rowId), SAVE_DEBOUNCE_MS);
    pendingSavesRef.current.set(rowId, { timer, pending });
  }, [flushRowSave]);

  const handleRowFieldChange = (purposeId, rowId, field, value) => {
    if (field === 'audioName' && value.trim() === '') {
      // Required field - keep it editable locally, but don't schedule an
      // empty save (the backend rejects it); flushRowSave on blur will just
      // skip it if it's still empty then.
      applyLocalRowEdit(purposeId, rowId, field, value);
      return;
    }
    scheduleRowSave(purposeId, rowId, field, value);
  };

  const handleRowFieldBlur = (rowId) => {
    flushRowSave(rowId);
  };

  const handleDeleteRow = async (purposeId, row) => {
    const ok = await showConfirm(`Delete "${row.audioName}"?`, { title: 'Delete Row' });
    if (!ok) return;
    try {
      await bufferAPI.deleteRow(row.id);
      setPurposes((prev) =>
        prev.map((p) => (p.id === purposeId ? { ...p, rows: p.rows.filter((r) => r.id !== row.id) } : p))
      );
    } catch (deleteError) {
      await showAlert(normalizeApiError(deleteError, 'Unable to delete this row.'), { title: 'Delete Failed' });
    }
  };

  const handleExport = async (params) => {
    const response = await bufferAPI.exportSheet(params);
    downloadBlobResponse(response, 'Buffer-Sheet.xlsx');
  };

  const totalRows = useMemo(() => purposes.reduce((sum, p) => sum + p.rows.length, 0), [purposes]);

  return (
    <div className="bps-wrap">
      <datalist id="bps-client-options">
        {clientSuggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="bps-editor-options">
        {editorSuggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="bps-toolbar">
        {canEdit ? (
          <form className="bps-add-purpose" onSubmit={handleAddPurpose}>
            <input
              type="text"
              className="bps-add-purpose-input"
              placeholder="New purpose (e.g. Diwali)"
              value={newPurposeName}
              onChange={(event) => setNewPurposeName(event.target.value)}
              disabled={creatingPurpose}
            />
            <button type="submit" className="chatgpt-capture-secondary-btn" disabled={creatingPurpose || !newPurposeName.trim()}>
              + Add Purpose
            </button>
          </form>
        ) : (
          <span className="bps-view-only-note">View only - ask an admin for Purpose Sheet edit access to make changes.</span>
        )}

        <button
          type="button"
          className="chatgpt-capture-primary-btn"
          onClick={() => setExportModalOpen(true)}
          disabled={purposes.length === 0}
        >
          ⬇ Download
        </button>
      </div>

      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && purposes.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">🗂️</span>
          <strong>No purposes yet</strong>
          <p>
            {canEdit
              ? 'Add a purpose above (e.g. "Janmashtami") - rows fill in automatically as people download self-uploads for it.'
              : 'Nothing has been tracked here yet.'}
          </p>
        </div>
      )}

      {loading && <div className="bps-loading">Loading Purpose Sheet…</div>}

      {!loading &&
        purposes.map((purpose) => (
          <div key={purpose.id} className="bps-group" style={{ '--purpose-color': purpose.color }}>
            <div className="bps-group-header">
              {canEdit ? (
                <button type="button" className="bps-group-name" onClick={() => handleRenamePurpose(purpose)} title="Click to rename">
                  {purpose.name.toUpperCase()}
                </button>
              ) : (
                <span className="bps-group-name bps-group-name--readonly">{purpose.name.toUpperCase()}</span>
              )}
              {isAdmin && (
                <button
                  type="button"
                  className="bps-group-delete"
                  onClick={() => handleDeletePurpose(purpose)}
                  aria-label={`Delete ${purpose.name}`}
                  title="Delete this purpose"
                >
                  🗑
                </button>
              )}
            </div>

            <div className="bps-row bps-row-head">
              <div className="bps-cell">Audio Name</div>
              <div className="bps-cell">Client</div>
              <div className="bps-cell">Editor Name</div>
              <div className="bps-cell bps-cell-action" />
            </div>

            {purpose.rows.map((row) => (
              <div key={row.id} className="bps-row">
                <div className="bps-cell">
                  <input
                    type="text"
                    value={row.audioName}
                    readOnly={!canEdit}
                    onChange={(event) => handleRowFieldChange(purpose.id, row.id, 'audioName', event.target.value)}
                    onBlur={() => handleRowFieldBlur(row.id)}
                  />
                </div>
                <div className="bps-cell">
                  <input
                    type="text"
                    list="bps-client-options"
                    placeholder="—"
                    value={row.clientName || ''}
                    readOnly={!canEdit}
                    onChange={(event) => handleRowFieldChange(purpose.id, row.id, 'clientName', event.target.value)}
                    onBlur={() => handleRowFieldBlur(row.id)}
                  />
                </div>
                <div className="bps-cell">
                  <input
                    type="text"
                    list="bps-editor-options"
                    placeholder="—"
                    value={row.editorName || ''}
                    readOnly={!canEdit}
                    onChange={(event) => handleRowFieldChange(purpose.id, row.id, 'editorName', event.target.value)}
                    onBlur={() => handleRowFieldBlur(row.id)}
                  />
                </div>
                <div className="bps-cell bps-cell-action">
                  {isAdmin && (
                    <button
                      type="button"
                      className="bps-row-delete"
                      onClick={() => handleDeleteRow(purpose.id, row)}
                      aria-label={`Delete ${row.audioName}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}

            {purpose.rows.length === 0 && (
              <div className="bps-row-empty">No rows yet - one appears automatically the first time someone downloads a self-upload for this purpose.</div>
            )}
          </div>
        ))}

      {!loading && purposes.length > 0 && (
        <div className="bps-footer-note">{purposes.length} purpose(s), {totalRows} row(s) total.</div>
      )}

      {exportModalOpen && (
        <BufferSheetExportModal
          purposes={purposes}
          onClose={() => setExportModalOpen(false)}
          onExport={handleExport}
        />
      )}
    </div>
  );
}
