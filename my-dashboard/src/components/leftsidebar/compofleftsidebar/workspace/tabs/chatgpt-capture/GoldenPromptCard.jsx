import AIAnalysisStatus from './AIAnalysisStatus';

// Placeholder architecture for the future "golden prompt" (the best-performing
// prompt derived after analyzing multiple generations). No value is invented -
// it shows the not-yet-generated state and what will populate it.
export default function GoldenPromptCard({ promptCount = 0 }) {
  return (
    <div className="cgpt-ai-card cgpt-golden">
      <div className="cgpt-ai-card-head">
        <h6 className="cgpt-ai-card-title">🏆 Golden Prompt</h6>
        <AIAnalysisStatus status="pending" />
      </div>
      <p className="cgpt-ai-empty-line">Not generated yet</p>
      <p className="cgpt-ai-hint">
        The system will derive the best-performing prompt after analyzing multiple generations in this conversation.
      </p>
      <div className="cgpt-ai-future">
        <div className="cgpt-ai-future-item">
          <span className="cgpt-ai-future-label">Prompts analyzed</span>
          <span className="cgpt-ai-future-value">{promptCount}</span>
        </div>
        <div className="cgpt-ai-future-item">
          <span className="cgpt-ai-future-label">Best prompt</span>
          <span className="cgpt-ai-future-value muted">Pending analysis</span>
        </div>
        <div className="cgpt-ai-future-item">
          <span className="cgpt-ai-future-label">Performance</span>
          <span className="cgpt-ai-future-value muted">—</span>
        </div>
      </div>
    </div>
  );
}
