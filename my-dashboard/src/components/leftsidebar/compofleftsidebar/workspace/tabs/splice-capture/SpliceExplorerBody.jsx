import { useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import SpliceDownloadsBrowser from './SpliceDownloadsBrowser';
// Reuses the ChatGPT Capture Center's stylesheet + Kling's card/grid CSS,
// same as every other provider tab - see freepik-capture/FreepikExplorerBody.jsx's
// own comment for why each import exists.
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';

/**
 * The Splice (splice.com) Capture Center UI. Splice is a sample/loop
 * library, not an AI generator - there is no adaptations/generations
 * concept and no quota field to surface, so this is intentionally a single-
 * mode browser with no Downloads/Adaptations-style switcher, matching the
 * shape epidemicsound-capture/EpidemicExplorerBody.jsx had before its
 * Adaptations mode was added.
 */
export default function SpliceExplorerBody({ searchInput = '' }) {
  const { isAdmin } = usePermissions();
  const [downloadsTotal, setDownloadsTotal] = useState(0);

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the Splice Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <div className="chatgpt-capture-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 'auto', flexWrap: 'wrap' }}>
          <span className="chatgpt-capture-panel-subhead">{downloadsTotal} download(s)</span>
        </div>
      </div>

      <SpliceDownloadsBrowser searchInput={searchInput} onTotalChange={setDownloadsTotal} />
    </div>
  );
}
