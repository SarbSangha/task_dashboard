import { useEffect, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { claudeCaptureAPI } from '../../../../../../services/api';
import ClaudeConversationsByPerson from './ClaudeConversationsByPerson';
import { formatCount } from './claudeCaptureUtils';
// Reuses the ChatGPT Capture Center's stylesheet, same as every other
// provider tab - see splice-capture/SpliceExplorerBody.jsx's own comment for
// why this import exists.
import '../ChatGptCaptureCenterTab.css';
import './ClaudeCaptureCenterTab.css';

/**
 * The Claude (claude.ai) Capture Center UI - conversations captured by
 * person (see backend providers/claude/CAPTURE_CONTRACT.md for what this
 * captures: prompt/response text, full conversation history backfilled on
 * first open, no attachment/media binary capture yet). Single-mode browser,
 * no Downloads/Adaptations-style switcher, mirroring
 * grammarly-docs-capture/GrammarlyDocsExplorerBody.jsx's own shape - Claude
 * has exactly one capture surface (conversations) at this stage.
 */
export default function ClaudeExplorerBody({ breadcrumbPrefix = [] }) {
  const { isAdmin } = usePermissions();
  const [searchInput, setSearchInput] = useState('');
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    if (!isAdmin) return;
    claudeCaptureAPI.getMetrics()
      .then((response) => setMetrics(response.data))
      .catch(() => {
        // Metrics strip is a nice-to-have header, not load-bearing - a
        // failed fetch just leaves it hidden rather than blocking the page.
      });
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the Claude Capture Center.
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

      {metrics && (
        <div className="chatgpt-capture-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="chatgpt-capture-badge">{formatCount(metrics.conversationsCaptured)} conversations</span>
          <span className="chatgpt-capture-badge">{formatCount(metrics.promptsCaptured)} prompts</span>
          <span className="chatgpt-capture-badge">{formatCount(metrics.responsesCaptured)} responses</span>
          <span className="chatgpt-capture-badge">{formatCount(metrics.usersCaptured)} people</span>
        </div>
      )}

      <div className="chatgpt-capture-actions">
        <input
          type="text"
          className="chatgpt-capture-search-input"
          placeholder="Search by conversation title or message text..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ minWidth: 260 }}
        />
      </div>

      <ClaudeConversationsByPerson searchInput={searchInput} />
    </div>
  );
}
