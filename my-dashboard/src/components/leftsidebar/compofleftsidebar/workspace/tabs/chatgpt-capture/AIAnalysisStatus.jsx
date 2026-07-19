import { ANALYSIS_STATUS } from './intelligenceHelpers';

// Small status pill for AI analysis state. Defaults to 'pending' (🟡 Waiting)
// since there is no analysis backend yet - never shows a fabricated result.
export default function AIAnalysisStatus({ status = 'pending', label }) {
  const meta = ANALYSIS_STATUS[status] || ANALYSIS_STATUS.pending;
  return (
    <span className={`cgpt-ai-status tone-${meta.tone}`} title="AI analysis status">
      {meta.icon} {label || meta.label}
    </span>
  );
}
