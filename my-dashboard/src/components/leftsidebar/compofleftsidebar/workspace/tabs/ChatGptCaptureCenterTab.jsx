import ChatGptExplorerBody from './chatgpt-capture/ChatGptExplorerBody';

// The standalone "ChatGPT Capture" workspace tab. The actual UI lives in
// ChatGptExplorerBody so it can also be mounted as a provider panel inside
// the AI Explorer shell (see workspace/tabs/ai-explorer/AiExplorerTab.jsx)
// without duplicating any of its logic.
export default function ChatGptCaptureCenterTab() {
  return <ChatGptExplorerBody breadcrumbPrefix={['ChatGPT']} />;
}
