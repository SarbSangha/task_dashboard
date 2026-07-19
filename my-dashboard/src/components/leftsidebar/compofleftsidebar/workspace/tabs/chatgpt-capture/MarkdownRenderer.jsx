import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyTextToClipboard } from './chatgptCaptureUtils';

// Extracts the language + raw text from a markdown <pre>'s child <code>.
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

// Thin wrapper over the existing ReactMarkdown + remark-gfm setup - same
// engine, just an improved code-block presentation (language label + copy).
// Markdown parsing/behavior is otherwise unchanged.
export default function MarkdownRenderer({ children }) {
  return (
    <div className="chatgpt-capture-markdown cgpt-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
