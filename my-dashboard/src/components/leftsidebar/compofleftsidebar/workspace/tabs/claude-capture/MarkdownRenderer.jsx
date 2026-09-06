import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyTextToClipboard } from './claudeCaptureUtils';

// Local copy of chatgpt-capture/MarkdownRenderer.jsx - same engine
// (ReactMarkdown + remark-gfm), same code-block presentation (language
// label + copy button). Claude's own captured text is already plain
// markdown (see backend providers/claude/CAPTURE_CONTRACT.md's
// contentParts "markdown" type), so no extra parsing is needed here.
function readCodeChild(children) {
  const codeEl = Array.isArray(children) ? children[0] : children;
  const props = codeEl?.props || {};
  const className = props.className || '';
  const langMatch = /language-([\w-]+)/.exec(className);
  const raw = Array.isArray(props.children) ? props.children.join('') : (props.children || '');
  return { language: langMatch ? langMatch[1] : '', code: `${raw}`.replace(/\n$/, '') };
}

function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  const { language, code } = readCodeChild(children);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="cgpt-code-block">
      <div className="cgpt-code-head">
        <span className="cgpt-code-lang">{language || 'code'}</span>
        <button type="button" className="cgpt-code-copy" onClick={handleCopy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <pre className="cgpt-code-pre"><code>{code}</code></pre>
    </div>
  );
}

export default function MarkdownRenderer({ children }) {
  return (
    <div className="chatgpt-capture-markdown cgpt-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
