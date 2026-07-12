import { useState } from 'react';
import { getEventTypeMeta, formatAbsoluteTime, copyTextToClipboard } from './chatgptCaptureUtils';
import JsonViewer from './JsonViewer';

function CopyableField({ label, value, copyable }) {
  const [copied, setCopied] = useState(false);
  const hasValue = value && value !== '—';

  const handleCopy = async () => {
    if (!hasValue) return;
    const ok = await copyTextToClipboard(String(value));
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="chatgpt-capture-field">
      <span className="chatgpt-capture-field-label">{label}</span>
      <span className="chatgpt-capture-field-value-row">
        <span className="chatgpt-capture-field-value">{value}</span>
        {copyable && hasValue && (
          <button type="button" className="chatgpt-capture-copy-icon-btn" onClick={handleCopy} aria-label={`Copy ${label}`}>
            {copied ? '✓' : '⧉'}
          </button>
        )}
      </span>
    </div>
  );
}

export default function EventDetailPanel({ event }) {
  if (!event) return null;
  const meta = getEventTypeMeta(event.eventType);

  const fields = [
    { label: 'Event Type', value: `${meta.icon} ${meta.label}` },
    { label: 'Timestamp', value: formatAbsoluteTime(event.createdAt) },
    { label: 'Conversation ID', value: event.providerConversationId || '—', copyable: true },
    { label: 'Client Event ID', value: event.clientEventId || '—', copyable: true },
    { label: 'Provider Message ID', value: event.providerMessageId || '—' },
    { label: 'Capture Version', value: event.captureVersion ?? '—' },
    { label: 'Extension Version', value: event.extensionVersion || '—' },
    { label: 'Browser', value: event.browser || '—' },
    { label: 'Event Date', value: event.eventDate || '—' },
    { label: 'Queue Status', value: 'Delivered' },
  ];

  return (
    <div className="chatgpt-capture-event-detail">
      <div className="chatgpt-capture-event-detail-fields">
        {fields.map((field) => (
          <CopyableField key={field.label} label={field.label} value={field.value} copyable={field.copyable} />
        ))}
      </div>

      <JsonViewer data={event.payload} label="Payload JSON" />
      <JsonViewer
        data={{
          id: event.id,
          toolId: event.toolId,
          credentialId: event.credentialId,
          userId: event.userId,
          provider: event.provider,
          tabId: event.tabId,
          sessionId: event.sessionId,
          extensionSessionId: event.extensionSessionId,
        }}
        label="Raw Metadata"
        collapsedByDefault
      />
    </div>
  );
}
