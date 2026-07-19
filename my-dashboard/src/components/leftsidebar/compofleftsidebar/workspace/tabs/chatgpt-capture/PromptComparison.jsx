import { useState } from 'react';
import AIAnalysisStatus from './AIAnalysisStatus';

// Placeholder prompt-comparison. Lets a developer PICK two prompts now (real,
// client-side) but the scoring/quality verdict is an explicit pending state -
// no fabricated winner.
export default function PromptComparison({ generations = [] }) {
  const prompts = generations.filter((g) => !g.ungrouped && g.promptText);
  const [a, setA] = useState(prompts[0] ? String(prompts[0].number) : '');
  const [b, setB] = useState(prompts[1] ? String(prompts[1].number) : '');

  if (prompts.length < 2) {
    return (
      <div className="cgpt-ai-card">
        <div className="cgpt-ai-card-head">
          <h6 className="cgpt-ai-card-title">⚖️ Prompt Comparison</h6>
          <AIAnalysisStatus status="pending" />
        </div>
        <p className="cgpt-ai-hint">At least two prompts are needed to compare. Generate more in this conversation.</p>
      </div>
    );
  }

  const byNumber = (n) => prompts.find((p) => String(p.number) === n);
  const pa = byNumber(a);
  const pb = byNumber(b);

  const Picker = ({ value, onChange, label }) => (
    <label className="cgpt-cmp-picker">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {prompts.map((p) => (
          <option key={p.number} value={String(p.number)}>Generation #{p.number}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="cgpt-ai-card">
      <div className="cgpt-ai-card-head">
        <h6 className="cgpt-ai-card-title">⚖️ Prompt Comparison</h6>
        <AIAnalysisStatus status="pending" />
      </div>
      <div className="cgpt-cmp-pickers">
        <Picker value={a} onChange={setA} label="Prompt A" />
        <Picker value={b} onChange={setB} label="Prompt B" />
      </div>
      <div className="cgpt-cmp-grid">
        {[pa, pb].map((p, i) => (
          <div key={i} className="cgpt-cmp-col">
            <span className="cgpt-cmp-tag">{i === 0 ? 'A' : 'B'} · #{p?.number}</span>
            <p className="cgpt-cmp-prompt">{p?.promptText}</p>
            <div className="cgpt-cmp-metrics">
              <span>Score <strong className="muted">?</strong></span>
              <span>Assets <strong>{p?.media?.length ?? 0}</strong></span>
            </div>
          </div>
        ))}
      </div>
      <p className="cgpt-ai-hint">Output-quality comparison will appear when AI analysis is available.</p>
    </div>
  );
}
