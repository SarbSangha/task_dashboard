import FigmaUsageDashboard from './FigmaUsageDashboard';
// Same stylesheet set as every other provider tab - see
// cursor-capture/CursorExplorerBody.jsx.
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';

/**
 * The Figma Capture Center. Admin-only, like every other provider tab
 * (TrendingsPanel gates it): AI credits per prompt, person, file and account.
 */
export default function FigmaExplorerBody({ searchInput = '' }) {
  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <FigmaUsageDashboard searchInput={searchInput} />
    </div>
  );
}
