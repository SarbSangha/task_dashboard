import MessageTimestamp from './MessageTimestamp';

// Minimal meta line under a message bubble: only the fields that exist, no
// avatar or name label - left/right bubble alignment already tells you who's
// speaking. Local copy of chatgpt-capture/MessageHeader.jsx.
export default function MessageHeader({ model, timestamp, status, role }) {
  return (
    <div className="cgpt-msg-meta">
      {model && role === 'assistant' && <span className="cgpt-msg-metachip">{model}</span>}
      {status && status.tone === 'error' && <span className={`cgpt-msg-status tone-${status.tone}`}>{status.label}</span>}
      <MessageTimestamp value={timestamp} />
    </div>
  );
}
