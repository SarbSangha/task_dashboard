import { formatCount } from './chatgptCaptureUtils';

// Reusable stat row (Messages / Images / Files). `variant="tiles"` renders
// the larger header/overview tiles; the default compact inline form is used
// on the conversation cards. Reads only existing count fields.
export default function ConversationStats({ messages = 0, images = 0, files = 0, variant = 'inline' }) {
  const stats = [
    { key: 'messages', label: 'Messages', value: messages, icon: '💬' },
    { key: 'images', label: 'Images', value: images, icon: '🖼' },
    { key: 'files', label: 'Files', value: files, icon: '📄' },
  ];

  if (variant === 'tiles') {
    return (
      <div className="cgpt-stats-tiles">
        {stats.map((s) => (
          <div key={s.key} className="cgpt-stat-tile">
            <span className="cgpt-stat-tile-value">{formatCount(s.value)}</span>
            <span className="cgpt-stat-tile-label">{s.icon} {s.label}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="cgpt-stats-inline">
      {stats.map((s) => (
        <span key={s.key} className="cgpt-stat-inline" title={s.label}>
          <span aria-hidden="true">{s.icon}</span> {formatCount(s.value)}
        </span>
      ))}
    </div>
  );
}
