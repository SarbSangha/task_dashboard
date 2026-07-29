import MessageTimestamp from './MessageTimestamp';

// Minimal meta line under a message bubble: only the fields that exist, no
// avatar or name label - left/right bubble alignment already tells you who's
// speaking, same as chatgpt.com itself.
export default function MessageHeader({ model, timestamp, edited, status, role }) {
  return (
    <div className="cgpt-msg-meta">
      {model && role === 'assistant' && <span className="cgpt-msg-metachip">{model}</span>}
      {status && status.tone === 'error' && <span className={`cgpt-msg-status tone-${status.tone}`}>{status.label}</span>}
      {edited && <span className="chatgpt-capture-badge tone-warning">Edited</span>}
      <MessageTimestamp value={timestamp} />
    </div>
  );
}
