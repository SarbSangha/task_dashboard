import { useState } from 'react';
import ChatGptExplorerBody from '../chatgpt-capture/ChatGptExplorerBody';
import './AiExplorerTab.css';

// Every provider RMW Eye captures conversations/generations from is meant to
// plug into this same shell eventually (see the AI Explorer plan) - listed
// here even before they're built so the switcher honestly shows what's
// coming rather than only ever showing the one provider that exists today.
const PROVIDERS = [
  { key: 'chatgpt', label: 'ChatGPT', icon: '🧠', enabled: true },
  { key: 'claude', label: 'Claude', icon: '🤖', enabled: false },
  { key: 'gemini', label: 'Gemini', icon: '✨', enabled: false },
  { key: 'kling', label: 'Kling', icon: '🎬', enabled: false },
  { key: 'midjourney', label: 'Midjourney', icon: '🖼️', enabled: false },
];

function ProviderSwitcher({ activeProvider, onSelect }) {
  return (
    <div className="ai-explorer-switcher" role="tablist" aria-label="AI provider">
      {PROVIDERS.map((provider) => (
        <button
          key={provider.key}
          type="button"
          role="tab"
          aria-selected={activeProvider === provider.key}
          className={`ai-explorer-provider-pill${activeProvider === provider.key ? ' active' : ''}${provider.enabled ? '' : ' disabled'}`}
          disabled={!provider.enabled}
          title={provider.enabled ? undefined : 'Coming soon'}
          onClick={() => provider.enabled && onSelect(provider.key)}
        >
          <span aria-hidden="true">{provider.icon}</span>
          {provider.label}
          {!provider.enabled && <span className="ai-explorer-soon-badge">Soon</span>}
        </button>
      ))}
    </div>
  );
}

export default function AiExplorerTab() {
  const [activeProvider, setActiveProvider] = useState('chatgpt');

  return (
    <div className="tab-content tab-content-projects ai-explorer-shell">
      <ProviderSwitcher activeProvider={activeProvider} onSelect={setActiveProvider} />
      <div className="ai-explorer-provider-panel">
        {activeProvider === 'chatgpt' && (
          <ChatGptExplorerBody breadcrumbPrefix={['AI Explorer', 'ChatGPT']} />
        )}
      </div>
    </div>
  );
}
