import ClaudeExplorerBody from './claude-capture/ClaudeExplorerBody';

// The standalone "Claude Capture" workspace tab - mirrors
// GrammarlyDocsCaptureCenterTab.jsx / ChatGptCaptureCenterTab.jsx exactly
// (see either file's own comment): the actual UI lives in ClaudeExplorerBody
// so it can be mounted elsewhere later without duplicating logic.
export default function ClaudeCaptureCenterTab() {
  return <ClaudeExplorerBody breadcrumbPrefix={['Claude']} />;
}
