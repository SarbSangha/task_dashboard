import MessageTimestamp from './MessageTimestamp';

const ROLE_META = {
  user: { icon: '👤', fallback: 'User' },
  assistant: { icon: '🤖', fallback: 'ChatGPT' },
  system: { icon: '📎', fallback: 'System' },
};

// Message header: avatar + display name + compact metadata (model, status)
// + timestamp. Only shows fields that exist - no technical noise.
export default function MessageHeader({ role, displayName, model, timestamp, edited, status }) {
  const meta = ROLE_META[role] || ROLE_META.system;
  return (
    <div className="cgpt-msg-head">
      <span className="cgpt-msg-avatar" aria-hidden="true">{meta.icon}</span>
      <span className="cgpt-msg-name">{displayName || meta.fallback}</span>
      {model && role === 'assistant' && <span className="cgpt-msg-metachip">{model}</span>}
      {status && <span className={`cgpt-msg-status tone-${status.tone}`}>{status.label}</span>}
      {edited && <span className="chatgpt-capture-badge tone-warning">Edited</span>}
      <span className="cgpt-msg-head-spacer" />
      <MessageTimestamp value={timestamp} />
    </div>
  );
}
