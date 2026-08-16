import { useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import GenerationsBrowser from './GenerationsBrowser';
import FlowGenerationDrawer from './FlowGenerationDrawer';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
// Reuses the ChatGPT Capture Center's stylesheet + Kling's card/grid CSS,
// same as every other provider tab - see freepik-capture/FreepikExplorerBody.jsx's
// own comment for why each import exists. No ai-explorer/AiExplorerTab.css
// import - Flow has only one browse mode (no mode-switcher pills to style).
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';

/**
 * The Flow (labs.google/fx/tools/flow) Capture Center UI - mirrors
 * envato-capture/EnvatoExplorerBody.jsx's structure, leaner: Flow's backend
 * only exposes generations + events (no metrics/users/downloads/analytics/
 * linked-tasks endpoints yet - see providers/flow/README.md's "what this
 * pass deliberately does not include"), so there's no mode switcher, no
 * metrics band, no "By Employee" browse mode, and no task/client filter
 * dropdowns (nothing to populate them from).
 */
export default function FlowExplorerBody({ searchInput = '' }) {
  const { isAdmin } = usePermissions();
  const [openGenerationId, setOpenGenerationId] = useState(null);
  const [generationsTotal, setGenerationsTotal] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the Flow Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <div className="chatgpt-capture-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 'auto', flexWrap: 'wrap' }}>
          <span className="chatgpt-capture-panel-subhead">{generationsTotal} generation(s)</span>
        </div>
        <button
          type="button"
          className="chatgpt-capture-secondary-btn chatgpt-capture-devtools-toggle"
          onClick={() => setDrawerOpen(true)}
          aria-expanded={drawerOpen}
        >
          🛠 Developer Tools
        </button>
      </div>

      <GenerationsBrowser
        searchInput={searchInput}
        onOpenGeneration={setOpenGenerationId}
        onTotalChange={setGenerationsTotal}
      />

      <FlowGenerationDrawer generationId={openGenerationId} onClose={() => setOpenGenerationId(null)} />

      <DeveloperToolsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
