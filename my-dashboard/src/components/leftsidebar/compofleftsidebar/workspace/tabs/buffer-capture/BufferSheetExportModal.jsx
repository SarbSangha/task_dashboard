import { useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeApiError } from './bufferCaptureUtils';

/**
 * Download options for the Purpose Sheet export (GET
 * /api/buffer/sheet/export.xlsx) - which purpose groups, which columns, and
 * whether to skip rows nobody has assigned a client/editor to yet. Portaled
 * to document.body for the same containing-block reason as
 * BufferDownloadGateModal (this is mounted inside a `.kling-card`-style
 * transformed ancestor via BufferPurposeSheet -> BufferExplorerBody).
 */
export default function BufferSheetExportModal({ purposes, onClose, onExport }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(purposes.map((p) => p.id)));
  const [includeClient, setIncludeClient] = useState(true);
  const [includeEditor, setIncludeEditor] = useState(true);
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const allSelected = selectedIds.size === purposes.length;

  const toggleOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(purposes.map((p) => p.id)));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (selectedIds.size === 0) {
      setError('Pick at least one purpose to export.');
      return;
    }
    const columns = [];
    if (includeClient) columns.push('client');
    if (includeEditor) columns.push('editor');

    setExporting(true);
    setError('');
    try {
      await onExport({
        purposeIds: Array.from(selectedIds).join(','),
        columns: columns.join(','),
        onlyFilled,
      });
      onClose();
    } catch (exportError) {
      setError(normalizeApiError(exportError, 'Unable to export the sheet.'));
    } finally {
      setExporting(false);
    }
  };

  return createPortal(
    <div className="custom-dialog-overlay" onClick={onClose}>
      <form className="custom-dialog" onClick={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <div className="custom-dialog-title">Download Purpose Sheet</div>
        <div className="custom-dialog-message">Choose what to include in the .xlsx file.</div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Purposes</span>
            <button type="button" className="bps-export-toggle-all" onClick={toggleAll}>
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <div className="bps-export-purpose-list">
            {purposes.map((purpose) => (
              <label key={purpose.id} className="bps-export-purpose-item">
                <input
                  type="checkbox"
                  checked={selectedIds.has(purpose.id)}
                  onChange={() => toggleOne(purpose.id)}
                />
                <span className="bps-export-swatch" style={{ backgroundColor: purpose.color }} />
                {purpose.name} <span className="bps-export-count">({purpose.rows.length})</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Columns</div>
          <label className="bps-export-purpose-item">
            <input type="checkbox" checked disabled /> Audio Name (always included)
          </label>
          <label className="bps-export-purpose-item">
            <input type="checkbox" checked={includeClient} onChange={(event) => setIncludeClient(event.target.checked)} /> Client
          </label>
          <label className="bps-export-purpose-item">
            <input type="checkbox" checked={includeEditor} onChange={(event) => setIncludeEditor(event.target.checked)} /> Editor Name
          </label>
        </div>

        <label className="bps-export-purpose-item">
          <input type="checkbox" checked={onlyFilled} onChange={(event) => setOnlyFilled(event.target.checked)} />
          Only include rows with a Client or Editor Name set
        </label>

        {error && <div className="custom-dialog-message" style={{ color: 'var(--color-danger, #dc2626)' }}>{error}</div>}

        <div className="custom-dialog-actions">
          <button type="button" className="custom-dialog-btn secondary" onClick={onClose} disabled={exporting}>
            Cancel
          </button>
          <button type="submit" className="custom-dialog-btn primary" disabled={exporting}>
            {exporting ? 'Preparing…' : 'Download .xlsx'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
