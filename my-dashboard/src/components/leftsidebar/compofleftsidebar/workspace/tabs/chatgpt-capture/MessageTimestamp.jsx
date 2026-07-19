import { formatClockTime, formatAbsoluteTime } from './chatgptCaptureUtils';

// Compact per-message time ("10:32 AM"), full datetime on hover.
export default function MessageTimestamp({ value }) {
  const clock = formatClockTime(value);
  if (!clock) return null;
  return <time className="cgpt-msg-time" title={formatAbsoluteTime(value)}>{clock}</time>;
}
