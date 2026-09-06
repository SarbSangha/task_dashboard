import { formatClockTime, formatAbsoluteTime } from './claudeCaptureUtils';

// Compact per-message time ("10:32 AM"), full datetime on hover. Local copy
// of chatgpt-capture/MessageTimestamp.jsx.
export default function MessageTimestamp({ value }) {
  const clock = formatClockTime(value);
  if (!clock) return null;
  return <time className="cgpt-msg-time" title={formatAbsoluteTime(value)}>{clock}</time>;
}
