import { useState } from 'react';
import { copyTextToClipboard } from './grammarlyDocsCaptureUtils';

// Local copy - mirrors chatgpt-capture/JsonViewer.jsx exactly (see this
// provider folder's own convention: each capture tab keeps its own copy
// rather than a cross-folder import, matching most of the other providers -
// see grammarlyDocsCaptureUtils.js's own header comment).
export default function JsonViewer({ data, label = 'JSON', collapsedByDefault = false }) {
  const [collapsed, setCollapsed] = useState(collapsedByDefault);
  const [copied, setCopied] = useState(false);

  const text = (() => {
    try {
      return JSON.stringify(data ?? {}, null, 2);
    } catch {
      return String(data);
    }
  })();

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(text);
    setCopied(ok);
    if (ok) {
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="chatgpt-capture-json-viewer">
      <div className="chatgpt-capture-json-viewer-head">
        <button
          type="button"
          className="chatgpt-capture-json-toggle"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
        >
          <span aria-hidden="true">{collapsed ? '▶' : '▼'}</span> {label}
        </button>
        <button type="button" className="chatgpt-capture-copy-btn" onClick={handleCopy}>
          {copied ? 'Copied ✓' : 'Copy JSON'}
        </button>
      </div>
      {!collapsed && (
        <pre className="chatgpt-capture-json-pre">
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}
