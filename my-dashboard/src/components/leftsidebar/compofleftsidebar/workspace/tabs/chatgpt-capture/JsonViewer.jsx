import { useState } from 'react';
import { copyTextToClipboard } from './chatgptCaptureUtils';

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
