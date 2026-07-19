import { useState } from 'react';
import { formatRelativeTime, copyTextToClipboard } from './chatgptCaptureUtils';
import { extractKeywords } from './mediaHelpers';

// Prompt-exploration view: one row per generation's prompt, with asset count,
// time, keywords and a copy action. Foundation for the future prompt
// intelligence layer (scores/golden prompts plug in here). Ungrouped media
// (no prompt) is intentionally excluded from this prompt-centric view.
const PROMPT_CLAMP = 220;

function PromptRow({ generation }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const keywords = extractKeywords(generation.promptText);
  const imageNoun = generation.media.length === 1 ? 'asset' : 'assets';
  const prompt = generation.promptText || '';
  const longPrompt = prompt.length > PROMPT_CLAMP;
  const shownPrompt = expanded || !longPrompt ? prompt : `${prompt.slice(0, PROMPT_CLAMP)}…`;

  const handleCopy = async () => {
    if (!prompt) return;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <li className="cgpt-prompt-row">
      <div className="cgpt-prompt-row-head">
        <span className="cgpt-gen-index">Generation #{generation.number}</span>
        {generation.model && <span className="cgpt-gen-metachip">{generation.model}</span>}
        <span className="cgpt-gen-head-spacer" />
        <span className="cgpt-gen-metachip">{generation.media.length} {imageNoun}</span>
        {generation.responseTime && <span className="cgpt-gen-time">{formatRelativeTime(generation.responseTime)}</span>}
      </div>
      <p className="cgpt-prompt-row-text">
        {prompt ? shownPrompt : <em className="cgpt-gen-muted">Prompt not captured</em>}
      </p>
      {longPrompt && (
        <button type="button" className="cgpt-gen-showmore" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="cgpt-prompt-row-foot">
        {prompt && <span className="cgpt-gen-prompt-chars">{prompt.length} chars</span>}
        {keywords.length > 0 && (
          <span className="cgpt-gen-keywords">
            {keywords.map((kw) => <span key={kw} className="cgpt-gen-keyword">{kw}</span>)}
          </span>
        )}
        {prompt && (
          <button type="button" className="cgpt-gen-copy" onClick={handleCopy}>{copied ? 'Copied ✓' : 'Copy prompt'}</button>
        )}
      </div>
    </li>
  );
}

export default function GenerationPromptView({ generations }) {
  const prompts = generations.filter((g) => !g.ungrouped);

  if (prompts.length === 0) {
    return (
      <div className="cgpt-media-empty compact">
        <span className="cgpt-media-empty-icon" aria-hidden="true">💬</span>
        <strong>No prompts available</strong>
        <p>Prompts that produced media appear here.</p>
      </div>
    );
  }

  return (
    <ol className="cgpt-prompt-list">
      {prompts.map((generation) => (
        <PromptRow key={`${generation.index}-${generation.anchorMs}`} generation={generation} />
      ))}
    </ol>
  );
}
