// AI Intelligence data model + HONEST deterministic prompt signals.
//
// Hard rule (per product direction): never fabricate an AI score. Everything
// that needs a model - clarity, specificity, quality, prompt-match,
// uniqueness, golden prompt, similarity - stays `null` with status 'pending'
// until a real analysis backend fills it. Only rule-based, deterministic
// facts (keyword extraction, length, which detail categories the prompt
// mentions) are computed and shown here, clearly labelled as "signals", not
// scores.
import { extractKeywords } from './mediaHelpers';

// Detail categories a strong image prompt usually specifies. Presence is a
// deterministic keyword check - a hint, NOT an AI judgement.
const DETAIL_CATEGORIES = [
  { key: 'lighting', label: 'Lighting', words: ['light', 'lighting', 'golden hour', 'sunset', 'sunrise', 'backlit', 'shadow', 'shadows', 'neon', 'dim', 'bright'] },
  { key: 'camera', label: 'Camera / angle', words: ['angle', 'close-up', 'closeup', 'wide', 'aerial', 'portrait', 'macro', 'shot', 'lens', 'focal', 'bokeh', 'perspective'] },
  { key: 'style', label: 'Style', words: ['cinematic', 'photorealistic', 'realistic', 'oil painting', 'watercolor', 'anime', '3d', 'render', 'sketch', 'illustration', 'minimalist', 'style'] },
  { key: 'color', label: 'Color', words: ['color', 'colour', 'vibrant', 'monochrome', 'black and white', 'pastel', 'saturated', 'muted', 'tone'] },
  { key: 'mood', label: 'Mood', words: ['mood', 'dramatic', 'serene', 'moody', 'atmosphere', 'atmospheric', 'peaceful', 'eerie', 'epic'] },
];

export function analysePromptSignals(promptText) {
  const text = `${promptText || ''}`;
  const lower = text.toLowerCase();
  const present = [];
  const missing = [];
  for (const cat of DETAIL_CATEGORIES) {
    if (cat.words.some((w) => lower.includes(w))) present.push(cat);
    else missing.push(cat);
  }
  return {
    charCount: text.length,
    wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
    keywords: extractKeywords(text, 6),
    presentCategories: present,
    missingCategories: missing,
  };
}

// The frontend intelligence shape. AI-derived fields are null + status
// 'pending' (no analysis backend yet); `signals` holds the honest,
// deterministic facts.
export function buildIntelligence(generation) {
  return {
    status: 'pending',
    promptScore: null,
    qualityScore: null,
    goldenPrompt: null,
    similarity: null,
    signals: analysePromptSignals(generation?.promptText),
  };
}

// AI metric slots to render as "pending" placeholders (never faked).
export const PROMPT_METRIC_SLOTS = [
  { key: 'clarity', label: 'Clarity' },
  { key: 'specificity', label: 'Specificity' },
  { key: 'detail', label: 'Detail richness' },
];

export const OUTPUT_METRIC_SLOTS = [
  { key: 'visual', label: 'Visual quality' },
  { key: 'match', label: 'Prompt match' },
  { key: 'uniqueness', label: 'Uniqueness' },
];

export const ANALYSIS_STATUS = {
  pending: { tone: 'warning', icon: '🟡', label: 'Waiting' },
  running: { tone: 'warning', icon: '🟡', label: 'Analyzing' },
  completed: { tone: 'success', icon: '🟢', label: 'Completed' },
  failed: { tone: 'error', icon: '🔴', label: 'Failed' },
};
