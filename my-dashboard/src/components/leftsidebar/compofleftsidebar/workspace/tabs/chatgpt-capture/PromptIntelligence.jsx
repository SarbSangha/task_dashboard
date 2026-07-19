import { useMemo } from 'react';
import AIAnalysisStatus from './AIAnalysisStatus';
import GenerationQuality from './GenerationQuality';
import { buildIntelligence, PROMPT_METRIC_SLOTS } from './intelligenceHelpers';

// Per-generation prompt intelligence. Splits two things clearly:
//   - Prompt signals: real, deterministic (keywords, length, which detail
//     categories the prompt mentions). Shown as facts.
//   - AI analysis: clarity/specificity/detail scores + a rewritten prompt.
//     These need a model, so they render as explicit "pending" placeholders -
//     no fabricated numbers.
export default function PromptIntelligence({ generation }) {
  const intel = useMemo(() => buildIntelligence(generation), [generation]);
  const { signals } = intel;

  return (
    <div className="cgpt-ai-card">
      <div className="cgpt-ai-card-head">
        <h6 className="cgpt-ai-card-title">🧠 Prompt Intelligence · #{generation.number}</h6>
        <AIAnalysisStatus status={intel.status} />
      </div>

      <div className="cgpt-ai-prompt">
        <span className="cgpt-ai-sub">Original prompt</span>
        <p className="cgpt-ai-prompt-text">{generation.promptText || <em className="muted">Prompt not captured</em>}</p>
      </div>

      {/* Real, deterministic signals */}
      <div className="cgpt-ai-signals">
        <span className="cgpt-ai-sub">Prompt signals</span>
        <div className="cgpt-ai-signal-row">
          <span className="cgpt-ai-signal">{signals.wordCount} words</span>
          <span className="cgpt-ai-signal">{signals.charCount} chars</span>
          {signals.keywords.map((kw) => <span key={kw} className="cgpt-gen-keyword">{kw}</span>)}
        </div>
        <div className="cgpt-ai-detail-checklist">
          {signals.presentCategories.map((c) => (
            <span key={c.key} className="cgpt-ai-detail ok" title="Mentioned in the prompt">✓ {c.label}</span>
          ))}
          {signals.missingCategories.map((c) => (
            <span key={c.key} className="cgpt-ai-detail missing" title="Not mentioned - consider adding">+ {c.label}</span>
          ))}
        </div>
      </div>

      {/* AI scores - pending placeholders (never faked) */}
      <div className="cgpt-ai-metrics">
        <span className="cgpt-ai-sub">AI analysis <span className="cgpt-ai-pending-tag">pending</span></span>
        {PROMPT_METRIC_SLOTS.map((slot) => (
          <div key={slot.key} className="cgpt-ai-bar-row">
            <span className="cgpt-ai-bar-label">{slot.label}</span>
            <span className="cgpt-ai-bar" aria-hidden="true"><span className="cgpt-ai-bar-fill pending" /></span>
            <span className="cgpt-ai-bar-value muted">—</span>
          </div>
        ))}
        <div className="cgpt-ai-suggestion">
          <span className="cgpt-ai-sub">Suggested improvement</span>
          {signals.missingCategories.length > 0 ? (
            <p className="cgpt-ai-suggestion-text">
              Consider specifying: {signals.missingCategories.map((c) => c.label.toLowerCase()).join(', ')}.
              <span className="cgpt-ai-pending-inline"> Full AI rewrite pending.</span>
            </p>
          ) : (
            <p className="cgpt-ai-suggestion-text muted">AI-generated rewrite pending.</p>
          )}
        </div>
      </div>

      <GenerationQuality />
    </div>
  );
}
