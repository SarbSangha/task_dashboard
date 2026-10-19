import React, { useState } from 'react';

const TOOL_DOMAINS = {
  kling: 'klingai.com',
  'kling ai': 'klingai.com',
  freepik: 'freepik.com',
  envato: 'envato.com',
  heygen: 'heygen.com',
  higgsfield: 'higgsfield.ai',
  elevenlabs: 'elevenlabs.io',
  flow: 'labs.google',
  suno: 'suno.com',
  'epidemic sound': 'epidemicsound.com',
  chatgpt: 'chatgpt.com',
  openai: 'openai.com',
  'dall-e': 'openai.com',
  claude: 'claude.ai',
  midjourney: 'midjourney.com',
  grammarly: 'grammarly.com',
  splice: 'splice.com',
  enhancor: 'enhancor.ai',
  canva: 'canva.com',
  runway: 'runwayml.com',
  gemini: 'gemini.google.com',
  perplexity: 'perplexity.ai',
  leonardo: 'leonardo.ai',
  pika: 'pika.art',
};

export const TOOL_COLORS = {
  Kling: '#10b981',
  Freepik: '#2b7de9',
  HeyGen: '#8b5cf6',
  ElevenLabs: '#a3a3a3',
  Suno: '#f97316',
  Higgsfield: '#14b8a6',
  Envato: '#84cc16',
  Flow: '#06b6d4',
  'Epidemic Sound': '#e11d48',
  ChatGPT: '#22c55e',
  Claude: '#d97757',
  Midjourney: '#6366f1',
  Grammarly: '#15c39a',
};

export const toolColor = (name) => TOOL_COLORS[name] || '#10b981';

export function toolDomain(name, websiteUrl) {
  const key = String(name || '').trim().toLowerCase();
  if (TOOL_DOMAINS[key]) return TOOL_DOMAINS[key];
  if (websiteUrl) {
    try {
      return new URL(websiteUrl).hostname.replace(/^www\./, '');
    } catch {
      /* fall through */
    }
  }
  return null;
}

export default function ToolLogo({ name, websiteUrl, size = 18, className = '' }) {
  const [failed, setFailed] = useState(false);
  const domain = toolDomain(name, websiteUrl);
  const style = { width: size, height: size, '--logo-color': toolColor(name) };

  if (!domain || failed) {
    return (
      <span className={`tool-logo tool-logo--fallback ${className}`} style={style} aria-hidden="true">
        {String(name || '?').charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className={`tool-logo ${className}`}
      style={style}
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
