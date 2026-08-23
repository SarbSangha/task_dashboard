import { useCallback, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import EpidemicDownloadsBrowser from './EpidemicDownloadsBrowser';
import EpidemicAdaptationsBrowser from './EpidemicAdaptationsBrowser';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
// Reuses the ChatGPT Capture Center's stylesheet + Kling's card/grid CSS,
// same as every other provider tab - see freepik-capture/FreepikExplorerBody.jsx's
// own comment for why each import exists. ai-explorer/AiExplorerTab.css is
// now needed too (unlike this tab's original single-mode shape) - Adaptations
// (see EpidemicAdaptationCard.jsx's own header comment: a real prompt-based
// AI regeneration feature, not a download) means Downloads is no longer the
// only thing to browse, so this now needs the same ai-explorer-switcher
// mode-pill styling envato-capture/EnvatoExplorerBody.jsx's own
// Generations/Downloads switcher uses. No metrics band still - no
// GET /api/providers/epidemicsound/metrics endpoint.
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';
import '../ai-explorer/AiExplorerTab.css';

/**
 * The Epidemic Sound (epidemicsound.com) Capture Center UI. Epidemic Sound
 * is still a stock music/sound-effects LICENSING LIBRARY at its core -
 * Downloads (pre-made tracks/sound-effects a user downloads) stays the
 * default mode a user lands on, unchanged from before. Adaptations is a
 * second, explicitly-selected mode for Epidemic Sound's prompt-based AI
 * regeneration feature (see EpidemicAdaptationCard.jsx's own header
 * comment) - mirrors envato-capture/EnvatoExplorerBody.jsx's
 * sidebarMode/tablist/conditional-render pattern, simplified to just these
 * two modes with no "By Employee" sub-mode (this tab never had one).
 */
export default function EpidemicExplorerBody({ searchInput = '' }) {
  const { isAdmin } = usePermissions();
  const [sidebarMode, setSidebarMode] = useState('downloads'); // 'downloads' | 'adaptations'
  const [downloadsTotal, setDownloadsTotal] = useState(0);
  const [adaptationsTotal, setAdaptationsTotal] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleSwitchMode = useCallback((mode) => {
    setSidebarMode(mode);
  }, []);

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the Epidemic Sound Capture Center.
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
              aria-selected={sidebarMode === 'downloads'}
              className={`ai-explorer-provider-pill${sidebarMode === 'downloads' ? ' active' : ''}`}
              onClick={() => handleSwitchMode('downloads')}
            >
              Downloads
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarMode === 'adaptations'}
              className={`ai-explorer-provider-pill${sidebarMode === 'adaptations' ? ' active' : ''}`}
              onClick={() => handleSwitchMode('adaptations')}
            >
              Adaptations
            </button>
          </div>
          {sidebarMode === 'downloads' && (
            <span className="chatgpt-capture-panel-subhead">{downloadsTotal} download(s)</span>
          )}
          {sidebarMode === 'adaptations' && (
            <span className="chatgpt-capture-panel-subhead">{adaptationsTotal} adaptation(s)</span>
          )}
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

      {sidebarMode === 'adaptations' ? (
        <EpidemicAdaptationsBrowser searchInput={searchInput} onTotalChange={setAdaptationsTotal} />
      ) : (
        <EpidemicDownloadsBrowser searchInput={searchInput} onTotalChange={setDownloadsTotal} />
      )}

      <DeveloperToolsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
