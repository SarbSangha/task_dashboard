import { useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import GenerationsBrowser from './GenerationsBrowser';
import ElevenLabsGenerationDrawer from './ElevenLabsGenerationDrawer';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
// Reuses the ChatGPT Capture Center's stylesheet + Kling's card/grid CSS,
// same as every other provider tab - see freepik-capture/FreepikExplorerBody.jsx's
// own comment for why each import exists. No ai-explorer/AiExplorerTab.css
// import - ElevenLabs has only one browse mode (no mode-switcher pills to
// style), same as Flow.
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';

/**
 * The ElevenLabs (elevenlabs.io) Capture Center UI - copied from
 * flow-capture/FlowExplorerBody.jsx: ElevenLabs' backend only exposes
 * generations + events (no metrics/users/analytics/linked-tasks endpoints
 * yet - see providers/elevenlabs/router.py's own docstring), so there's no
 * metrics band, no "By Employee" browse mode, and no task/client filter
 * dropdowns (nothing to populate them from).
 *
 * One mode switcher DOES exist though: Generations / Downloads. Unlike
 * Freepik's Downloads (a separate DownloadsBrowser reading a wholly
 * different table - stock-asset downloads, unrelated to generation), an
 * ElevenLabs "download" is always of a clip the user already generated, so
 * Downloads here is just GenerationsBrowser's own list filtered server-side
 * to rows with downloadedAt set (see GenerationsBrowser's downloadedOnly
 * prop) - one browser component, not two.
 */
export default function ElevenLabsExplorerBody({ searchInput = '' }) {
  const { isAdmin } = usePermissions();
  const [openGenerationId, setOpenGenerationId] = useState(null);
  const [generationsTotal, setGenerationsTotal] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState('generations'); // 'generations' | 'downloads'

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the ElevenLabs Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <div className="chatgpt-capture-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 'auto', flexWrap: 'wrap' }}>
          <div className="ai-explorer-switcher" role="tablist" aria-label="Browse mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'generations'}
              className={`ai-explorer-provider-pill${mode === 'generations' ? ' active' : ''}`}
              onClick={() => setMode('generations')}
            >
              Generations
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'downloads'}
              className={`ai-explorer-provider-pill${mode === 'downloads' ? ' active' : ''}`}
              onClick={() => setMode('downloads')}
            >
              Downloads
            </button>
          </div>
          <span className="chatgpt-capture-panel-subhead">
            {generationsTotal} {mode === 'downloads' ? 'download(s)' : 'generation(s)'}
          </span>
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
        key={mode}
        searchInput={searchInput}
        downloadedOnly={mode === 'downloads'}
        onOpenGeneration={setOpenGenerationId}
        onTotalChange={setGenerationsTotal}
      />

      <ElevenLabsGenerationDrawer generationId={openGenerationId} onClose={() => setOpenGenerationId(null)} />

      <DeveloperToolsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
