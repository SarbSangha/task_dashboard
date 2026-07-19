import { useMemo, useState } from 'react';
import MediaTile from './MediaTile';
import { formatRelativeTime, sanitizeResponseText, copyTextToClipboard } from './chatgptCaptureUtils';
import { generationType, generationStatus, extractKeywords } from './mediaHelpers';

const RESPONSE_CLAMP = 260;

function GenerationCard({ generation, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const responseText = sanitizeResponseText(generation.responseText || '');
  const longResponse = responseText.length > RESPONSE_CLAMP;
  const shownResponse = expanded || !longResponse ? responseText : `${responseText.slice(0, RESPONSE_CLAMP)}…`;

  const type = generationType(generation.media);
  const status = generationStatus(generation.media);
  const keywords = useMemo(() => extractKeywords(generation.promptText), [generation.promptText]);
  const mediaNoun = generation.media.length === 1 ? 'asset' : 'assets';

  const handleCopy = async () => {
    if (!generation.promptText) return;
    const ok = await copyTextToClipboard(generation.promptText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <li className="cgpt-gen-card">
      <span className="cgpt-gen-node" aria-hidden="true" />
      <div className="cgpt-gen-card-inner">
        <div className="cgpt-gen-card-head">
          <button
            type="button"
            className="cgpt-gen-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand generation' : 'Collapse generation'}
            onClick={() => setCollapsed((v) => !v)}
          >
            <span className="cgpt-gen-caret" aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
            <span className="cgpt-gen-index">{generation.ungrouped ? 'Ungrouped media' : `Generation #${generation.number}`}</span>
          </button>
          {!generation.ungrouped && <span className="cgpt-gen-type"><span aria-hidden="true">{type.icon}</span> {type.label}</span>}
          <span className={`cgpt-gen-status tone-${status.tone}`}>{status.icon} {status.label}</span>
          <span className="cgpt-gen-head-spacer" />
          {generation.model && <span className="cgpt-gen-metachip">{generation.model}</span>}
          <span className="cgpt-gen-metachip">{generation.media.length} {mediaNoun}</span>
          {generation.responseTime && <span className="cgpt-gen-time">{formatRelativeTime(generation.responseTime)}</span>}
        </div>

        {!collapsed && (
          <div className="cgpt-gen-body">
            {!generation.ungrouped && (
              <>
                <div className="cgpt-gen-prompt">
                  <div className="cgpt-gen-role">
                    <span aria-hidden="true">👤</span> Prompt
                    {generation.promptText && (
                      <button type="button" className="cgpt-gen-copy" onClick={handleCopy}>{copied ? 'Copied ✓' : 'Copy'}</button>
                    )}
                  </div>
                  <p className="cgpt-gen-prompt-text">{generation.promptText || <em className="cgpt-gen-muted">Prompt not captured</em>}</p>
                  {generation.promptText && (
                    <div className="cgpt-gen-prompt-meta">
                      <span className="cgpt-gen-prompt-chars">{generation.promptText.length} chars</span>
                      {keywords.length > 0 && (
                        <span className="cgpt-gen-keywords">
                          {keywords.map((kw) => <span key={kw} className="cgpt-gen-keyword">{kw}</span>)}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {responseText ? (
                  <div className="cgpt-gen-response">
                    <div className="cgpt-gen-role"><span aria-hidden="true">🤖</span> ChatGPT response</div>
                    <p className="cgpt-gen-response-text">{shownResponse}</p>
                    {longResponse && (
                      <button type="button" className="cgpt-gen-showmore" onClick={() => setExpanded((v) => !v)}>
                        {expanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </div>
                ) : null}
              </>
            )}

            <div className="cgpt-gen-media">
              <div className="cgpt-gen-media-label">
                <span aria-hidden="true">🖼</span> Generated output
                <span className="cgpt-media-count">{generation.media.length}</span>
              </div>
              <div className="cgpt-gen-media-grid">
                {generation.media.map((asset) => (
                  <MediaTile key={asset.id} asset={asset} onOpen={onOpen} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

export default function GenerationTimelineView({ generations, onOpen }) {
  return (
    <ol className="cgpt-gen-list">
      {generations.map((generation) => (
        <GenerationCard
          key={generation.ungrouped ? 'ungrouped' : `${generation.index}-${generation.anchorMs}`}
          generation={generation}
          onOpen={onOpen}
        />
      ))}
    </ol>
  );
}
