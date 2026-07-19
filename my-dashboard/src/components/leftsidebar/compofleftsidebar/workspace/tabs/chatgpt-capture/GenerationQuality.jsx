import { OUTPUT_METRIC_SLOTS } from './intelligenceHelpers';

// "Output Intelligence" for a generation's media - visual quality / prompt
// match / uniqueness. All require a model, so every slot is an explicit
// "Pending" placeholder (no fabricated values).
export default function GenerationQuality() {
  return (
    <div className="cgpt-ai-output">
      <span className="cgpt-ai-output-title">Output intelligence</span>
      <div className="cgpt-ai-metric-row">
        {OUTPUT_METRIC_SLOTS.map((slot) => (
          <div key={slot.key} className="cgpt-ai-metric">
            <span className="cgpt-ai-metric-label">{slot.label}</span>
            <span className="cgpt-ai-metric-pending">Pending</span>
          </div>
        ))}
      </div>
    </div>
  );
}
