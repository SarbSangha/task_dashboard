import GrammarlyDocsExplorerBody from './grammarly-docs-capture/GrammarlyDocsExplorerBody';

// The standalone "Grammarly Docs Capture" workspace tab - mirrors
// ChatGptCaptureCenterTab.jsx exactly (see that file's own comment): the
// actual UI lives in GrammarlyDocsExplorerBody so it can be mounted
// elsewhere later without duplicating logic.
export default function GrammarlyDocsCaptureCenterTab() {
  return <GrammarlyDocsExplorerBody breadcrumbPrefix={['Grammarly Docs']} />;
}
