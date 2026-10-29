import CursorUsageDashboard from './CursorUsageDashboard';
// Same stylesheet set as every other provider tab - see
// splice-capture/SpliceExplorerBody.jsx.
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';

/**
 * The Cursor Capture Center. Admin-only, like every other provider tab
 * (TrendingsPanel gates it): the usage page, plus People & devices, where an
 * admin connects each person's computer with a one-time setup code.
 */
export default function CursorExplorerBody({ searchInput = '' }) {
  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <CursorUsageDashboard searchInput={searchInput} />
    </div>
  );
}
