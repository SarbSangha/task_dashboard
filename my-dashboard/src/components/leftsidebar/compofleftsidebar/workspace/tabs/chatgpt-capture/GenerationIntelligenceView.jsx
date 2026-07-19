import GoldenPromptCard from './GoldenPromptCard';
import PromptComparison from './PromptComparison';
import PromptIntelligence from './PromptIntelligence';
import AIAnalysisStatus from './AIAnalysisStatus';

function SimilarityInsights({ mediaCount }) {
  return (
    <div className="cgpt-ai-card">
      <div className="cgpt-ai-card-head">
        <h6 className="cgpt-ai-card-title">🧬 Similarity &amp; Duplicates</h6>
        <AIAnalysisStatus status="pending" />
      </div>
      <p className="cgpt-ai-empty-line">No similarity analysis yet</p>
      <p className="cgpt-ai-hint">
        Once analysis runs, near-duplicate generations across the {mediaCount} captured asset{mediaCount === 1 ? '' : 's'} will be
        grouped with a similarity score and a "keep best output" suggestion.
      </p>
    </div>
  );
}

export default function GenerationIntelligenceView({ generations = [] }) {
  const promptGenerations = generations.filter((g) => !g.ungrouped && g.promptText);
  const mediaCount = generations.reduce((n, g) => n + g.media.length, 0);

  return (
    <div className="cgpt-ai-view">
      <div className="cgpt-ai-banner">
        <span className="cgpt-ai-banner-main">🤖 AI Intelligence</span>
        <span className="cgpt-ai-banner-note">Analysis layer scaffolding — scores populate when the analysis backend is connected.</span>
        <span className="cgpt-ai-banner-spacer" />
        <AIAnalysisStatus status="pending" label="Analysis pending" />
      </div>

      <div className="cgpt-ai-grid">
        <GoldenPromptCard promptCount={promptGenerations.length} />
        <SimilarityInsights mediaCount={mediaCount} />
      </div>

      <PromptComparison generations={generations} />

      {promptGenerations.length > 0 && (
        <div className="cgpt-ai-prompt-list">
          {promptGenerations.map((generation) => (
            <PromptIntelligence key={`${generation.index}-${generation.anchorMs}`} generation={generation} />
          ))}
        </div>
      )}
    </div>
  );
}
