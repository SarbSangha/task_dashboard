import ClaudeCodeUsageDashboard from './ClaudeCodeUsageDashboard';
// Same stylesheet set as every other provider tab - see
// cursor-capture/CursorExplorerBody.jsx.
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';

/**
 * The Claude Code Capture Center. Admin-only, like every other provider tab
 * (TrendingsPanel gates it): the usage page, plus Computers, which shows who
 * reports Claude Code and connects a computer the Cursor way.
 */
export default function ClaudeCodeExplorerBody({ searchInput = '' }) {
  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <ClaudeCodeUsageDashboard searchInput={searchInput} />
    </div>
  );
}
