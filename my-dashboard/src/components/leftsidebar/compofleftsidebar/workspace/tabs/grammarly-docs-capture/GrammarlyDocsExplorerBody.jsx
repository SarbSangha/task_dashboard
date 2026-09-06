import { useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import GrammarlyDocsSessionsByPerson from './GrammarlyDocsSessionsByPerson';
// Reuses the ChatGPT Capture Center's stylesheet, same as every other
// provider tab - see splice-capture/SpliceExplorerBody.jsx's own comment for
// why this import exists.
import '../ChatGptCaptureCenterTab.css';
import './GrammarlyDocsCaptureCenterTab.css';

/**
 * The Grammarly Docs (coda.grammarly.com) Capture Center UI - how much
 * work got done, by person (see backend
 * providers/grammarly_docs/CAPTURE_CONTRACT.md for what this does and
 * deliberately does not capture yet: session presence only, no doc-creation
 * count, no document content). Single-mode browser, no
 * Downloads/Adaptations-style switcher, mirroring
 * splice-capture/SpliceExplorerBody.jsx's own shape - Grammarly Docs has
 * exactly one capture surface (sessions) at this stage.
 */
export default function GrammarlyDocsExplorerBody({ breadcrumbPrefix = [] }) {
  const { isAdmin } = usePermissions();
  const [searchInput, setSearchInput] = useState('');

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the Grammarly Docs Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      {breadcrumbPrefix.length > 0 && (
        <div className="chatgpt-capture-breadcrumb">
          {breadcrumbPrefix.map((crumb, index) => (
            <span key={crumb} className="chatgpt-capture-breadcrumb-crumb">
              {crumb}
              {index < breadcrumbPrefix.length - 1 ? ' / ' : ''}
            </span>
          ))}
        </div>
      )}

      <div className="chatgpt-capture-actions">
        <input
          type="text"
          className="chatgpt-capture-search-input"
          placeholder="Search by doc title, author, task, or client..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ minWidth: 260 }}
        />
      </div>

      <GrammarlyDocsSessionsByPerson searchInput={searchInput} />
    </div>
  );
}
