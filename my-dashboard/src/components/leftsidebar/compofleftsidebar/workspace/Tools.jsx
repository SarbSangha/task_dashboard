import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authAPI, isRequestCanceled, itToolsAPI } from '../../../../services/api';
import './Tools.css';

const EXTENSION_LAUNCH_EVENT = 'rmw:tool-hub-extension-launch';
const EXTENSION_LAUNCH_STORED_EVENT = 'rmw:tool-hub-extension-launch-stored';
const EXTENSION_LAUNCH_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH';
const EXTENSION_LAUNCH_STORED_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH_STORED';
const EXTENSION_WINDOW_LAUNCH_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_WINDOW_LAUNCH';
const EXTENSION_WINDOW_LAUNCH_RESULT_EVENT = 'rmw:tool-hub-extension-window-launch-result';
const EXTENSION_WINDOW_LAUNCH_RESULT_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_WINDOW_LAUNCH_RESULT';
const FLOW_DIRECT_ROUTE_URL = 'https://labs.google/fx/tools/flow';
const buildDateInputValue = (offsetDays = 0) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const EMPTY_USAGE_FILTERS = {
  toolSlug: 'kling-ai',
  dateFrom: buildDateInputValue(0),
  dateTo: buildDateInputValue(0),
  userId: '',
  credentialId: '',
};

const EMPTY_LAUNCH_HISTORY_SUMMARY = {
  launchCount: 0,
  userCount: 0,
  toolCount: 0,
  lastLaunchedAt: null,
};

const ASSIGNMENT_USER_PAGE_SIZE = 20;

const Icons = {
  Search: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
  Zap: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 14.71 13.5 3l-2.25 9H20L10.5 21l2.25-9H4Z" />
    </svg>
  ),
  Image: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  ),
  Cpu: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
    </svg>
  ),
  Edit: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  Shield: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  ),
  AlertCircle: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  Globe: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20" />
      <path d="M12 2a15.3 15.3 0 0 0 0 20" />
    </svg>
  ),
};

const EMPTY_TOOL_FORM = {
  name: '',
  category: 'Generative AI',
  website_url: '',
  login_url: '',
  icon: 'Globe',
  launch_mode: 'manual_credential',
  auto_login_action_url: '',
  auto_login_method: 'POST',
  auto_login_username_field: 'email',
  auto_login_password_field: 'password',
  description: '',
};

const EMPTY_CREDENTIAL_FORM = {
  toolId: '',
  credential_id: '',
  scope: 'company',
  user_ids: [],
  assigned_user_ids: [],
  login_method: 'email_password',
  login_identifier: '',
  password: '',
  backup_codes: '',
  totp_secret: '',
  notes: '',
};
const USAGE_REPORT_REFRESH_MS = 15000;

const EMPTY_MAILBOX_FORM = {
  toolId: '',
  mailbox_id: '',
  email_address: '',
  app_password: '',
  otp_sender_filter: '',
  otp_subject_pattern: '',
  otp_regex: '\\b(\\d{4,8})\\b',
  auth_link_host: '',
  auth_link_pattern: '',
};

const EMPTY_MAILBOX_META = {
  exists: false,
  appPasswordSet: false,
};

const updateToolFormField = (setToolForm, setError, key, value) => {
  setToolForm((current) => ({ ...current, [key]: value }));
  setError('');
};

const normalizeToolSlug = (value) => {
  const normalized = `${value || ''}`.trim().toLowerCase();
  const slugified = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slugified === 'chat-gpt') return 'chatgpt';
  if (['enhencor', 'enhencer', 'enhancer'].includes(slugified)) return 'enhancor';
  if (['eleven-labs', 'eleven-lab'].includes(slugified)) return 'elevenlabs';
  if (slugified === 'pintrest') return 'pinterest';
  return slugified;
};

const supportsSharedCompanyCredentialAssignments = (value) => {
  const normalizedToolSlug = normalizeToolSlug(typeof value === 'string' ? value : value?.slug);
  return Boolean(normalizedToolSlug && normalizedToolSlug !== 'tool');
};

const toolSupportsPasswordOptionalCredential = (value) => {
  const normalizedToolSlug = normalizeToolSlug(typeof value === 'string' ? value : value?.slug || value?.name);
  return normalizedToolSlug === 'claude';
};

const toolSupportsCredentialLoginMethodSelection = (value) => {
  const normalizedToolSlug = normalizeToolSlug(typeof value === 'string' ? value : value?.slug || value?.name);
  return normalizedToolSlug === 'behance'
    || normalizedToolSlug === 'chatgpt'
    || normalizedToolSlug === 'enhancor'
    || normalizedToolSlug === 'elevenlabs'
    || normalizedToolSlug === 'flow'
    || normalizedToolSlug === 'freepik'
    || normalizedToolSlug === 'genspark'
    || normalizedToolSlug === 'heygen'
    || normalizedToolSlug === 'pinterest'
    || normalizedToolSlug === 'kling-ai'
    || normalizedToolSlug === 'klingai'
    || normalizedToolSlug === 'kling'
    || normalizedToolSlug === 'suno'
    || normalizedToolSlug === 'epidemic-sound'
    || normalizedToolSlug === 'splice';
};

const getDefaultCredentialLoginMethod = (value) => {
  const normalizedToolSlug = normalizeToolSlug(typeof value === 'string' ? value : value?.slug || value?.name);
  if (normalizedToolSlug === 'kling-ai' || normalizedToolSlug === 'klingai' || normalizedToolSlug === 'kling') {
    return 'email_password';
  }
  return 'email_password';
};

const shouldLaunchExtensionToolInIncognito = (toolSlug, loginMethod) => {
  const normalizedToolSlug = normalizeToolSlug(toolSlug);
  const normalizedLoginMethod = `${loginMethod || ''}`.trim().toLowerCase();
  if (normalizedToolSlug === 'canva') return true;
  if (normalizedToolSlug === 'elevenlabs') return true;
  // Email/password tools that launch in a normal window otherwise leave the
  // shared session in the profile after the window closes. Launch them in
  // incognito so the browser isolates and auto-clears the session on close.
  if (normalizedToolSlug === 'envato') return true;
  if (normalizedToolSlug === 'grammarly') return true;
  if (normalizedToolSlug === 'higgsfield') return true;
  return normalizedLoginMethod === 'google';
};

const toolSupportsAuthenticatorSeed = (toolSlug, loginMethod = '') => {
  const normalizedToolSlug = normalizeToolSlug(toolSlug);
  const normalizedLoginMethod = `${loginMethod || ''}`.trim().toLowerCase();
  if (normalizedToolSlug === 'flow' || normalizedToolSlug === 'chatgpt') {
    return true;
  }
  return toolSupportsCredentialLoginMethodSelection(normalizedToolSlug) && normalizedLoginMethod === 'google';
};

const getAuthenticatorSeedToolLabel = (toolSlug) => {
  const normalizedToolSlug = normalizeToolSlug(toolSlug);
  if (normalizedToolSlug === 'chatgpt') return 'ChatGPT';
  if (normalizedToolSlug === 'behance') return 'Behance';
  if (normalizedToolSlug === 'flow') return 'Flow';
  if (normalizedToolSlug === 'enhancor') return 'Enhancor';
  if (normalizedToolSlug === 'elevenlabs') return 'ElevenLabs';
  if (normalizedToolSlug === 'freepik') return 'Freepik';
  if (normalizedToolSlug === 'genspark') return 'Genspark';
  if (normalizedToolSlug === 'heygen') return 'HeyGen';
  if (normalizedToolSlug === 'pinterest') return 'Pinterest';
  if (normalizedToolSlug === 'kling' || normalizedToolSlug === 'kling-ai' || normalizedToolSlug === 'klingai') return 'Kling';
  if (normalizedToolSlug === 'suno') return 'Suno';
  if (normalizedToolSlug === 'epidemic-sound') return 'Epidemic Sound';
  if (normalizedToolSlug === 'splice') return 'Splice';
  return 'Google';
};

const getSharedCredentialLabels = (toolValue) => {
  const isStringValue = typeof toolValue === 'string';
  const normalizedToolSlug = normalizeToolSlug(isStringValue ? toolValue : toolValue?.slug);
  const displayName = isStringValue
    ? (normalizedToolSlug === 'behance'
      ? 'Behance'
      : normalizedToolSlug === 'chatgpt'
      ? 'ChatGPT'
      : normalizedToolSlug === 'flow'
        ? 'Flow'
        : normalizedToolSlug === 'canva'
          ? 'Canva'
        : normalizedToolSlug === 'elevenlabs'
          ? 'ElevenLabs'
          : normalizedToolSlug === 'pinterest'
            ? 'Pinterest'
            : 'tool')
    : (toolValue?.name || (normalizedToolSlug === 'behance'
      ? 'Behance'
      : normalizedToolSlug === 'chatgpt'
      ? 'ChatGPT'
      : normalizedToolSlug === 'flow'
        ? 'Flow'
        : normalizedToolSlug === 'canva'
          ? 'Canva'
          : normalizedToolSlug === 'elevenlabs'
            ? 'ElevenLabs'
            : normalizedToolSlug === 'pinterest'
              ? 'Pinterest'
            : 'tool'));
  if (normalizedToolSlug === 'chatgpt') {
    return {
      singular: 'login',
      plural: 'logins',
      addAction: 'Add new ChatGPT login',
      listTitle: 'Saved ChatGPT logins',
      assignTitle: 'Assign this ChatGPT login',
      dialogTitle: 'Assign ChatGPT Login',
      emptyState: 'Save the first ChatGPT login to start building user assignments.',
      saveNotice: 'ChatGPT login saved. You can now see which users are assigned to this login from the saved login list.',
      updateAction: 'Update ChatGPT Login',
    };
  }
  return {
    singular: 'credential',
    plural: 'credentials',
    addAction: `Add new ${displayName} credential`,
    listTitle: `Saved ${displayName} credentials`,
    assignTitle: `Assign this ${displayName} credential`,
    dialogTitle: `Assign ${displayName} Credential`,
    emptyState: `Save the first ${displayName} login to start building user assignments.`,
    saveNotice: `${displayName} credential saved. You can now see which users are assigned to this login from the saved credential list.`,
    updateAction: `Update ${displayName} Credential`,
  };
};

const copyToClipboard = async (value) => {
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  return false;
};

const waitForExtensionLaunchStored = (toolSlug) => new Promise((resolve) => {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  if (!normalizedSlug) {
    resolve({ ok: false, stored: false, error: 'Missing tool slug for extension launch.' });
    return;
  }

  let settled = false;
  const cleanup = () => {
    window.removeEventListener(EXTENSION_LAUNCH_STORED_EVENT, handleStored);
    window.removeEventListener('message', handleMessage);
    window.clearTimeout(timerId);
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(result);
  };
  const handleStored = (event) => {
    const storedSlug = normalizeToolSlug(event.detail?.toolSlug);
    if (storedSlug === normalizedSlug) {
      finish({ ok: true, stored: true, error: '' });
    }
  };
  const handleMessage = (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== 'rmw-tool-hub-extension') return;
    if (event.data?.type !== EXTENSION_LAUNCH_STORED_MESSAGE_TYPE) return;
    const storedSlug = normalizeToolSlug(event.data?.toolSlug);
    if (storedSlug === normalizedSlug) {
      finish({ ok: true, stored: true, error: '' });
    }
  };
  const timerId = window.setTimeout(() => {
    finish({
      ok: false,
      stored: false,
      error: 'Extension bridge did not respond on this dashboard URL. Reload the extension and open the dashboard on a supported domain.',
    });
  }, 2500);

  window.addEventListener(EXTENSION_LAUNCH_STORED_EVENT, handleStored);
  window.addEventListener('message', handleMessage);
});

const openToolInIncognitoWindow = (launchDetail) => new Promise((resolve) => {
  const normalizedSlug = normalizeToolSlug(launchDetail?.toolSlug);
  const toolName = `${launchDetail?.toolName || ''}`.trim() || (
    normalizedSlug === 'behance'
    ? 'Behance'
    : normalizedSlug === 'chatgpt'
    ? 'ChatGPT'
    : normalizedSlug === 'flow'
      ? 'Flow'
      : normalizedSlug === 'enhancor'
        ? 'Enhancor'
      : normalizedSlug === 'freepik'
        ? 'Freepik'
        : normalizedSlug === 'elevenlabs'
          ? 'ElevenLabs'
          : normalizedSlug === 'pinterest'
            ? 'Pinterest'
          : 'this tool'
  );
  if (!normalizedSlug || !launchDetail?.launchUrl) {
    resolve({ ok: false, error: `${toolName} launch details are incomplete.` });
    return;
  }

  let settled = false;
  const cleanup = () => {
    window.removeEventListener(EXTENSION_WINDOW_LAUNCH_RESULT_EVENT, handleResult);
    window.removeEventListener('message', handleMessage);
    window.clearTimeout(timerId);
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(result);
  };
  const handleResult = (event) => {
    const resultSlug = normalizeToolSlug(event.detail?.toolSlug);
    if (resultSlug !== normalizedSlug) return;
    finish({
      ok: Boolean(event.detail?.ok),
      error: `${event.detail?.error || ''}`.trim(),
    });
  };
  const handleMessage = (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== 'rmw-tool-hub-extension') return;
    if (event.data?.type !== EXTENSION_WINDOW_LAUNCH_RESULT_MESSAGE_TYPE) return;
    const resultSlug = normalizeToolSlug(event.data?.toolSlug);
    if (resultSlug !== normalizedSlug) return;
    finish({
      ok: Boolean(event.data?.ok),
      error: `${event.data?.error || ''}`.trim(),
    });
  };
  const timerId = window.setTimeout(() => {
    finish({
      ok: false,
      error: `${toolName} incognito launch timed out. Check whether the extension is loaded and allowed in incognito.`,
    });
  }, 5000);

  window.addEventListener(EXTENSION_WINDOW_LAUNCH_RESULT_EVENT, handleResult);
  window.addEventListener('message', handleMessage);
  window.postMessage({
    source: 'rmw-tool-hub-page',
    type: EXTENSION_WINDOW_LAUNCH_MESSAGE_TYPE,
    ...launchDetail,
  }, window.location.origin);
});

const buildExtensionLaunchUrl = (launchUrl, extensionTicket, toolSlug, usageTrackingTicket = '') => {
  if (!launchUrl || (!extensionTicket && !usageTrackingTicket)) return launchUrl;

  try {
    const url = new URL(launchUrl, window.location.origin);
    const normalizedToolSlug = normalizeToolSlug(toolSlug);
    if (extensionTicket) {
      url.searchParams.set('rmw_extension_ticket', extensionTicket);
    }
    if (usageTrackingTicket) {
      url.searchParams.set('rmw_usage_ticket', usageTrackingTicket);
    }
    if (normalizedToolSlug) {
      url.searchParams.set('rmw_tool_slug', normalizedToolSlug);
    }
    const params = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    if (extensionTicket) {
      params.set('rmw_extension_ticket', extensionTicket);
    }
    if (usageTrackingTicket) {
      params.set('rmw_usage_ticket', usageTrackingTicket);
    }
    if (normalizedToolSlug) {
      params.set('rmw_tool_slug', normalizedToolSlug);
    }
    url.hash = params.toString();
    return url.toString();
  } catch {
    return launchUrl;
  }
};

const resolveExtensionLaunchUrl = (launchUrl, extensionTicket, toolSlug, usageTrackingTicket = '') => {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  const nextLaunchUrl = normalizedSlug === 'flow' ? FLOW_DIRECT_ROUTE_URL : launchUrl;
  return buildExtensionLaunchUrl(nextLaunchUrl, extensionTicket, normalizedSlug, usageTrackingTicket);
};

const formatUsageNumber = (value) => {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? numericValue.toFixed(numericValue % 1 === 0 ? 0 : 2) : '0';
};

const formatUsageDate = (value) => {
  if (!value) return 'N/A';
  const normalizedValue = `${value}`;
  const dateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]), 12, 0, 0, 0)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
};

const formatUsageDateTime = (value) => {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const parseUsageDateValue = (value) => {
  if (!value) return null;
  const normalizedValue = `${value}`;
  const dateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]), 12, 0, 0, 0)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const toUsageDateKey = (value) => {
  const parsed = parseUsageDateValue(value);
  if (!parsed) return '';
  const year = parsed.getFullYear();
  const month = `${parsed.getMonth() + 1}`.padStart(2, '0');
  const day = `${parsed.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatUsageShortDate = (value) => {
  const parsed = parseUsageDateValue(value);
  if (!parsed) return formatUsageDate(value);
  return parsed.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
};

const getUsageAxisLabelLines = (value, maxCharsPerLine = 12, maxLines = 2) => {
  const normalized = `${value || ''}`.trim();
  if (!normalized) return ['Unknown'];

  const words = normalized.split(/\s+/).filter(Boolean);
  const lines = [];

  if (words.length > 1) {
    let currentLine = '';
    words.forEach((word) => {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (candidate.length <= maxCharsPerLine || !currentLine) {
        currentLine = candidate;
        return;
      }
      lines.push(currentLine);
      currentLine = word;
    });
    if (currentLine) lines.push(currentLine);
  } else {
    for (let index = 0; index < normalized.length; index += maxCharsPerLine) {
      lines.push(normalized.slice(index, index + maxCharsPerLine));
    }
  }

  if (lines.length <= maxLines) return lines;
  const visibleLines = lines.slice(0, maxLines);
  visibleLines[maxLines - 1] = `${visibleLines[maxLines - 1].slice(0, Math.max(maxCharsPerLine - 1, 1))}…`;
  return visibleLines;
};

const getUsageChartAxisMax = (values = [], minimum = 1) => {
  const rawMax = Math.max(minimum, ...values.map((value) => Number(value || 0)));
  if (rawMax <= minimum) return minimum;

  const withHeadroom = rawMax * 1.15;
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(withHeadroom)));
  const normalized = withHeadroom / magnitude;

  let niceNormalized = 1;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 2.5) niceNormalized = 2.5;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;

  return niceNormalized * magnitude;
};

const getUsageDateRangeKeys = (dateFrom, dateTo) => {
  const start = parseUsageDateValue(dateFrom);
  const end = parseUsageDateValue(dateTo);
  if (!start || !end || start > end) return [];

  const values = [];
  const cursor = new Date(start);
  let guard = 0;

  while (cursor <= end && guard < 1100) {
    values.push(toUsageDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }

  return values;
};

const formatUsageCredentialTitle = (credentialLabel, credentialId) => {
  const normalizedLabel = `${credentialLabel || ''}`.trim();
  const numericCredentialId = Number(credentialId || 0);
  if (normalizedLabel && numericCredentialId > 0) {
    return `${normalizedLabel} (Credential #${numericCredentialId})`;
  }
  if (normalizedLabel) return normalizedLabel;
  if (numericCredentialId > 0) return `Credential #${numericCredentialId}`;
  return 'No credential';
};

const formatUsageCredentialMeta = (credentialId, credentialScope) => {
  const numericCredentialId = Number(credentialId || 0);
  return [
    numericCredentialId > 0 ? `ID ${numericCredentialId}` : '',
    `${credentialScope || ''}`.trim(),
  ].filter(Boolean).join(' · ');
};

const resolveCurrentCreditsValue = (summary, recentEvents = []) => {
  if (summary?.currentCredits != null) {
    return summary.currentCredits;
  }
  for (const event of recentEvents) {
    if (event?.creditsAfter != null) return event.creditsAfter;
    if (event?.creditsBefore != null) return event.creditsBefore;
    if (event?.metadata?.currentCredits != null) return event.metadata.currentCredits;
  }
  return null;
};

const getUsageTimestamp = (value) => {
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

const getUsageUserLabel = (entry) => entry?.userName || entry?.userEmail || `User #${entry?.userId}`;

const getUsageUserKey = (entry) => {
  const numericUserId = Number(entry?.userId || 0);
  if (numericUserId > 0) return `user:${numericUserId}`;
  return `user:${`${entry?.userEmail || entry?.userName || 'unknown'}`.trim().toLowerCase()}`;
};

const getUsageCredentialKey = (entry) => {
  const numericCredentialId = Number(entry?.credentialId || 0);
  if (numericCredentialId > 0) return `credential:${numericCredentialId}`;
  return `credential:none:${`${entry?.credentialLabel || 'No credential'}`.trim().toLowerCase() || 'no-credential'}`;
};

const isKlingUsageTool = (tool) => {
  const normalizedToolSlug = normalizeToolSlug(typeof tool === 'string' ? tool : tool?.slug);
  return normalizedToolSlug === 'kling' || normalizedToolSlug === 'kling-ai' || normalizedToolSlug === 'klingai';
};

const normalizeUsageCredentialLabel = (value) => `${value || ''}`.trim().toLowerCase();

const resolveUsageCredentialLabel = (entry, credentialLabelMap) => {
  const numericCredentialId = Number(entry?.credentialId || 0);
  const mappedLabel = numericCredentialId > 0 ? `${credentialLabelMap.get(numericCredentialId) || ''}`.trim() : '';
  if (mappedLabel) return mappedLabel;
  return `${entry?.credentialLabel || ''}`.trim();
};

const hasDisplayableUsageCredential = (entry) => {
  const numericCredentialId = Number(entry?.credentialId || 0);
  if (numericCredentialId > 0) return true;
  return Boolean(normalizeUsageCredentialLabel(entry?.credentialLabel));
};

const getUsageEventMetadata = (event) => (
  event?.metadata && typeof event.metadata === 'object' ? event.metadata : {}
);

const getUsageEventPrompt = (event) => (
  `${event?.promptText || getUsageEventMetadata(event)?.promptCapture?.text || ''}`.trim()
);

const getUsageEventSettings = (event) => {
  const metadata = getUsageEventMetadata(event);
  const settings = metadata.generationSettings && typeof metadata.generationSettings === 'object'
    ? metadata.generationSettings
    : {};
  return [
    settings.generationMode || metadata.generationMode || event?.metadata?.rawGenerationMode,
    settings.modelLabel || event?.modelLabel,
    settings.resolutionLabel || event?.resolutionLabel,
    settings.durationLabel || event?.durationLabel,
    settings.aspectRatioLabel || metadata.aspectRatioLabel,
    settings.outputCount ? `${settings.outputCount} output${Number(settings.outputCount) === 1 ? '' : 's'}` : '',
    settings.nativeAudio ? 'Native audio' : '',
    settings.multiShot ? 'Multi-shot' : '',
  ].filter(Boolean);
};

const getUsageEventMediaAssets = (event, role) => {
  const mediaAssets = getUsageEventMetadata(event)?.mediaAssets;
  if (!Array.isArray(mediaAssets)) return [];
  const resolveAssetUrl = (asset) => `${
    asset.permanentUrl
      || asset.openUrl
      || asset.downloadUrl
      || asset.upload?.openUrl
      || asset.upload?.url
      || asset.storageUrl
      || asset.rawUrl
      || asset.url
      || ''
  }`.trim();
  const normalizedAssets = mediaAssets
    .filter((asset) => asset && typeof asset === 'object' && resolveAssetUrl(asset))
    .map((asset) => {
      const resolvedUrl = resolveAssetUrl(asset);
      const generatedOriginFrame = /output(?:[_\-.]|%)/i.test(resolvedUrl) && /\.origin(?:[?#]|$)/i.test(resolvedUrl);
      return {
        ...asset,
        url: resolvedUrl,
        assetRole: generatedOriginFrame ? 'output' : asset.assetRole,
      };
    })
    .filter((asset) => {
      const assetRole = `${asset.assetRole || ''}`.trim().toLowerCase();
      if (role === 'input') return assetRole === 'input';
      if (role === 'output') return assetRole !== 'input';
      return true;
    });
  const stableUrls = new Set(normalizedAssets
    .filter((asset) => /^https?:\/\//i.test(asset.url))
    .map((asset) => `${asset.blobUrl || ''}`.trim())
    .filter(Boolean));
  const hasAuthoritativeOutput = role === 'output' && normalizedAssets.some((asset) => {
    const source = `${asset.source || ''}`.trim().toLowerCase();
    return source && !['dom', 'blob_source'].includes(source) && /^https?:\/\//i.test(asset.url);
  });
  return normalizedAssets
    .filter((asset) => {
      if (!hasAuthoritativeOutput) return true;
      const source = `${asset.source || ''}`.trim().toLowerCase();
      return !['dom', 'blob_source'].includes(source) && !/^blob:/i.test(asset.url);
    })
    .filter((asset) => !/^blob:/i.test(asset.url) || !stableUrls.has(`${asset.url || asset.blobUrl || ''}`.trim()))
    .sort((left, right) => {
      const score = (asset) => {
        if (asset.permanentUrl || asset.openUrl || asset.upload?.url || asset.storageUrl) return 0;
        if (/^https?:\/\//i.test(asset.url) && `${asset.assetType || asset.mimetype || ''}`.toLowerCase().includes('video')) return 1;
        if (/^https?:\/\//i.test(asset.url)) return 2;
        return 3;
      };
      return score(left) - score(right);
    });
};

const formatUsageAssetLabel = (asset, index) => {
  const type = `${asset?.assetType || asset?.mimetype || ''}`.toLowerCase().includes('video') ? 'Video' : 'Image';
  const source = `${asset?.source || ''}`.trim();
  return `${type} ${index + 1}${source ? ` - ${source.replace(/_/g, ' ')}` : ''}`;
};

const downloadBlobResponse = (response, fallbackFilename) => {
  const blob = response?.data;
  if (!blob) return;
  const disposition = `${response?.headers?.['content-disposition'] || ''}`;
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const filename = filenameMatch ? decodeURIComponent(filenameMatch[1].replace(/"$/g, '')) : fallbackFilename;
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || fallbackFilename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
};

const compareUsageAggregateTotals = (left, right) => {
  if (Number(right?.creditsBurned || 0) !== Number(left?.creditsBurned || 0)) {
    return Number(right?.creditsBurned || 0) - Number(left?.creditsBurned || 0);
  }
  if (Number(right?.expectedCredits || 0) !== Number(left?.expectedCredits || 0)) {
    return Number(right?.expectedCredits || 0) - Number(left?.expectedCredits || 0);
  }
  if (Number(right?.generateClicks || 0) !== Number(left?.generateClicks || 0)) {
    return Number(right?.generateClicks || 0) - Number(left?.generateClicks || 0);
  }
  return getUsageTimestamp(right?.lastEventAt) - getUsageTimestamp(left?.lastEventAt);
};

const USAGE_USER_CHART_COLORS = [
  'var(--tools-chart-series-1)',
  'var(--tools-chart-series-2)',
  'var(--tools-chart-series-3)',
  'var(--tools-chart-series-4)',
  'var(--tools-chart-series-5)',
  'var(--tools-chart-series-6)',
  'var(--tools-chart-series-7)',
];

function UsageCreditsLineChart({ data = [], loading = false }) {
  if (loading) {
    return <div className="it-usage-chart-empty">Loading credit trend...</div>;
  }

  if (!data.length) {
    return <div className="it-usage-chart-empty">No credit burn found for the selected dates.</div>;
  }

  const width = 760;
  const height = 280;
  const padding = { top: 20, right: 18, bottom: 38, left: 74 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const hasPositiveValues = data.some((item) => Number(item.creditsBurned || 0) > 0);
  const maxValue = hasPositiveValues
    ? getUsageChartAxisMax(data.map((item) => Number(item.creditsBurned || 0)), 1)
    : 1;
  const xStep = data.length === 1 ? 0 : plotWidth / (data.length - 1);

  const points = data.map((item, index) => {
    const creditsBurned = Number(item.creditsBurned || 0);
    const x = data.length === 1 ? padding.left + (plotWidth / 2) : padding.left + (index * xStep);
    const y = padding.top + plotHeight - ((creditsBurned / maxValue) * plotHeight);
    return {
      ...item,
      creditsBurned,
      x,
      y,
    };
  });

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x} ${padding.top + plotHeight} L ${points[0].x} ${padding.top + plotHeight} Z`
    : '';
  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = (3 - index) / 3;
    return {
      key: `tick-${index}`,
      value: hasPositiveValues ? maxValue * ratio : 0,
      y: padding.top + plotHeight - (ratio * plotHeight),
    };
  });
  const labelStride = data.length <= 7 ? 1 : Math.ceil(data.length / 6);

  return (
    <div className="it-usage-line-chart" role="img" aria-label="Line chart showing credits burned by date">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="usageCreditsAreaFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--tools-chart-line)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--tools-chart-line)" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {yTicks.map((tick) => (
          <g key={tick.key}>
            <line
              x1={padding.left}
              y1={tick.y}
              x2={width - padding.right}
              y2={tick.y}
              className="it-usage-line-grid"
            />
            <text x={padding.left - 12} y={tick.y + 4} textAnchor="end" className="it-usage-line-axis-label">
              {formatUsageNumber(tick.value)}
            </text>
          </g>
        ))}

        <line
          x1={padding.left}
          y1={padding.top + plotHeight}
          x2={width - padding.right}
          y2={padding.top + plotHeight}
          className="it-usage-line-axis"
        />

        {areaPath && <path d={areaPath} className="it-usage-line-area" />}
        <path d={linePath} className="it-usage-line-path" />

        {points.map((point, index) => (
          <g key={`usage-point-${point.date}-${index}`}>
            <circle cx={point.x} cy={point.y} r="4.5" className="it-usage-line-point" />
            <title>{`${formatUsageDate(point.date)}: ${formatUsageNumber(point.creditsBurned)} credits`}</title>
          </g>
        ))}

        {points.map((point, index) => {
          const shouldRenderLabel = index === 0 || index === points.length - 1 || index % labelStride === 0;
          if (!shouldRenderLabel) return null;
          return (
            <text
              key={`usage-label-${point.date}-${index}`}
              x={point.x}
              y={height - 12}
              textAnchor="middle"
              className="it-usage-line-axis-label"
            >
              {formatUsageShortDate(point.date)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function UsageCreditsBarChart({ data = [], loading = false }) {
  if (loading) {
    return <div className="it-usage-chart-empty">Loading user credit bars...</div>;
  }

  if (!data.length) {
    return <div className="it-usage-chart-empty">No user credit burn found for the selected filter.</div>;
  }

  const maxValue = getUsageChartAxisMax(data.map((item) => Number(item.creditsBurned || 0)), 1);

  return (
    <div className="it-usage-user-bars" role="img" aria-label="Bar graph showing credits burned by user">
      {data.map((entry) => {
        const widthPercent = maxValue > 0 ? (Number(entry.creditsBurned || 0) / maxValue) * 100 : 0;
        const visibleWidth = entry.creditsBurned > 0 ? Math.max(widthPercent, 5) : 0;
        const label = getUsageUserLabel(entry);
        const emailLabel = entry.userName && entry.userEmail && entry.userName !== entry.userEmail ? entry.userEmail : '';

        return (
          <div key={entry.key} className="it-usage-user-bar-row">
            <div className="it-usage-user-bar-head">
              <div className="it-usage-user-bar-labels">
                <strong title={label}>{label}</strong>
                {emailLabel && <small title={emailLabel}>{emailLabel}</small>}
              </div>
              <span>{formatUsageNumber(entry.creditsBurned)} credits</span>
            </div>
            <div className="it-usage-user-bar-track">
              <div className="it-usage-user-bar-fill" style={{ width: `${visibleWidth}%` }} />
            </div>
            <div className="it-usage-user-bar-meta">
              <small>{entry.generateClicks} clicks</small>
              <small>{formatUsageDateTime(entry.lastEventAt)}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UsageDailyBarChart({ data = [], loading = false }) {
  if (loading) {
    return <div className="it-usage-chart-empty">Loading daily consumption bars...</div>;
  }

  if (!data.length) {
    return <div className="it-usage-chart-empty">No day-level consumption found for the selected dates.</div>;
  }

  const width = 760;
  const height = 300;
  const padding = { top: 20, right: 18, bottom: 46, left: 74 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = getUsageChartAxisMax(data.map((item) => Number(item.creditsBurned || 0)), 1);
  const gap = data.length > 1 ? 14 : 0;
  const barWidth = Math.max(28, Math.min(72, (plotWidth - (gap * Math.max(data.length - 1, 0))) / Math.max(data.length, 1)));
  const totalBarsWidth = (barWidth * data.length) + (gap * Math.max(data.length - 1, 0));
  const startX = padding.left + Math.max((plotWidth - totalBarsWidth) / 2, 0);

  const bars = data.map((item, index) => {
    const creditsBurned = Number(item.creditsBurned || 0);
    const barHeight = maxValue > 0 ? (creditsBurned / maxValue) * plotHeight : 0;
    const x = startX + (index * (barWidth + gap));
    const y = padding.top + plotHeight - barHeight;
    return {
      ...item,
      creditsBurned,
      x,
      y,
      barHeight,
    };
  });

  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = (3 - index) / 3;
    return {
      key: `day-bar-tick-${index}`,
      value: maxValue * ratio,
      y: padding.top + plotHeight - (ratio * plotHeight),
    };
  });
  const minimumLabelY = padding.top + 12;

  return (
    <div className="it-usage-line-chart" role="img" aria-label="Bar chart showing daily credit consumption">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="usageDayBarFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--tools-chart-bar-start)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--tools-chart-bar-end)" stopOpacity="0.88" />
          </linearGradient>
        </defs>

        {yTicks.map((tick) => (
          <g key={tick.key}>
            <line
              x1={padding.left}
              y1={tick.y}
              x2={width - padding.right}
              y2={tick.y}
              className="it-usage-line-grid"
            />
            <text x={padding.left - 12} y={tick.y + 4} textAnchor="end" className="it-usage-line-axis-label">
              {formatUsageNumber(tick.value)}
            </text>
          </g>
        ))}

        <line
          x1={padding.left}
          y1={padding.top + plotHeight}
          x2={width - padding.right}
          y2={padding.top + plotHeight}
          className="it-usage-line-axis"
        />

        {bars.map((bar, index) => (
          <g key={`daily-bar-${bar.date}-${index}`}>
            <rect
              x={bar.x}
              y={bar.y}
              width={barWidth}
              height={Math.max(bar.barHeight, 0)}
              rx="10"
              className="it-usage-day-bar"
            />
            <text
              x={bar.x + (barWidth / 2)}
              y={Math.max(bar.y - 14, minimumLabelY)}
              textAnchor="middle"
              className="it-usage-line-axis-label"
            >
              {formatUsageNumber(bar.creditsBurned)}
            </text>
            <text
              x={bar.x + (barWidth / 2)}
              y={height - 14}
              textAnchor="middle"
              className="it-usage-line-axis-label"
            >
              {formatUsageShortDate(bar.date)}
            </text>
            <title>{`${formatUsageDate(bar.date)}: ${formatUsageNumber(bar.creditsBurned)} credits`}</title>
          </g>
        ))}
      </svg>
    </div>
  );
}

function UsageSingleDayUserBarChart({ data = [], selectedDate = '', loading = false }) {
  if (loading) {
    return <div className="it-usage-chart-empty">Loading daily user credit chart...</div>;
  }

  if (!data.length) {
    return <div className="it-usage-chart-empty">No user credit burn found for {formatUsageDate(selectedDate)}.</div>;
  }

  const width = Math.max(760, 150 + (data.length * 96));
  const height = 390;
  const padding = { top: 22, right: 18, bottom: 132, left: 74 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = getUsageChartAxisMax(data.map((item) => Number(item.creditsBurned || 0)), 1);
  const gap = data.length > 1 ? 16 : 0;
  const barWidth = Math.max(34, Math.min(58, (plotWidth - (gap * Math.max(data.length - 1, 0))) / Math.max(data.length, 1)));
  const totalBarsWidth = (barWidth * data.length) + (gap * Math.max(data.length - 1, 0));
  const startX = padding.left + Math.max((plotWidth - totalBarsWidth) / 2, 0);

  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = (3 - index) / 3;
    return {
      key: `single-day-user-tick-${index}`,
      value: maxValue * ratio,
      y: padding.top + plotHeight - (ratio * plotHeight),
    };
  });

  return (
    <div className="it-usage-scroll-chart">
      <div className="it-usage-line-chart" role="img" aria-label="Bar chart showing credits burned by user for the selected day">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMinYMin meet"
          style={{ width: `${width}px`, height: `${height}px` }}
        >
          {yTicks.map((tick) => (
            <g key={tick.key}>
              <line
                x1={padding.left}
                y1={tick.y}
                x2={width - padding.right}
                y2={tick.y}
                className="it-usage-line-grid"
              />
              <text x={padding.left - 12} y={tick.y + 4} textAnchor="end" className="it-usage-line-axis-label">
                {formatUsageNumber(tick.value)}
              </text>
            </g>
          ))}

          <line
            x1={padding.left}
            y1={padding.top + plotHeight}
            x2={width - padding.right}
            y2={padding.top + plotHeight}
            className="it-usage-line-axis"
          />

          {data.map((userEntry, index) => {
            const creditsBurned = Number(userEntry.creditsBurned || 0);
            const barHeight = maxValue > 0 ? (creditsBurned / maxValue) * plotHeight : 0;
            const x = startX + (index * (barWidth + gap));
            const y = padding.top + plotHeight - barHeight;
            const labelLines = getUsageAxisLabelLines(userEntry.label, 12, 2);

            return (
              <g key={`single-day-user-bar-${userEntry.key}-${index}`}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(barHeight, 0)}
                  rx="10"
                  fill={USAGE_USER_CHART_COLORS[index % USAGE_USER_CHART_COLORS.length]}
                  className="it-usage-day-bar"
                >
                  <title>{`${userEntry.label}: ${formatUsageNumber(creditsBurned)} credits on ${formatUsageDate(selectedDate)}`}</title>
                </rect>
                <text
                  x={x + (barWidth / 2)}
                  y={Math.max(y - 8, padding.top + 10)}
                  textAnchor="middle"
                  className="it-usage-line-axis-label"
                >
                  {formatUsageNumber(creditsBurned)}
                </text>
                <text
                  x={x + (barWidth / 2)}
                  y={height - padding.bottom + 20}
                  textAnchor="middle"
                  className="it-usage-line-axis-label"
                  aria-label={userEntry.label}
                >
                  {labelLines.map((line, lineIndex) => (
                    <tspan
                      key={`${userEntry.key}-label-${lineIndex}`}
                      x={x + (barWidth / 2)}
                      dy={lineIndex === 0 ? 0 : 14}
                    >
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

const TOOL_ADMIN_SECTIONS = [
  { key: 'assigned', label: 'Tool' },
  { key: 'access', label: 'Access' },
  { key: 'add', label: 'Add Tool' },
];

const WORKPLACE_TOOLS_EMPTY_STATE_TITLE = 'No Active Tasks';
const WORKPLACE_TOOLS_EMPTY_STATE_COPY = "You don't have any active tasks assigned to you.";
const WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP = 'Workplace tools become available automatically as soon as a new active task is assigned.';
const WORKPLACE_TOOLS_ACCESS_CHECK_ERROR = 'Unable to verify Workplace tools access right now.';

const isWorkplaceToolsAccessDeniedError = (error) => (
  error?.response?.status === 403
  && /active inbox task|workplace tools/i.test(`${error?.response?.data?.detail || ''}`)
);

export default function Tools({ view = 'tools' }) {
  const activeView = view === 'credits' ? 'credits' : view === 'charts' ? 'charts' : 'tools';
  const isUsageDashboardView = activeView === 'credits' || activeView === 'charts';
  const containerRef = useRef(null);
  const headerRef = useRef(null);
  const usageRefreshControllerRef = useRef(null);
  const [tools, setTools] = useState([]);
  const [users, setUsers] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [toolsAccess, setToolsAccess] = useState({
    loading: true,
    checked: false,
    canAccess: false,
    isError: false,
    message: '',
  });
  const [toolsAccessRetryCount, setToolsAccessRetryCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mailboxBusy, setMailboxBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [toolAdminSection, setToolAdminSection] = useState('assigned');
  const [selectedTool, setSelectedTool] = useState(null);
  const [launchingToolId, setLaunchingToolId] = useState('');
  const [editToolId, setEditToolId] = useState('');
  const [toolForm, setToolForm] = useState(EMPTY_TOOL_FORM);
  const [credentialForm, setCredentialForm] = useState(EMPTY_CREDENTIAL_FORM);
  const [mailboxForm, setMailboxForm] = useState(EMPTY_MAILBOX_FORM);
  const [mailboxMeta, setMailboxMeta] = useState(EMPTY_MAILBOX_META);
  const [mailboxEntries, setMailboxEntries] = useState([]);
  const [launchResult, setLaunchResult] = useState(null);
  const [toolCredentialsByToolId, setToolCredentialsByToolId] = useState({});
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentSavingKey, setAssignmentSavingKey] = useState('');
  const [assignmentUserPage, setAssignmentUserPage] = useState(0);
  const [sharedCredentialAssignmentPicker, setSharedCredentialAssignmentPicker] = useState(null);
  const [usageFilters, setUsageFilters] = useState(EMPTY_USAGE_FILTERS);
  const [usageUserDayChartDate, setUsageUserDayChartDate] = useState(EMPTY_USAGE_FILTERS.dateTo || EMPTY_USAGE_FILTERS.dateFrom);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageRows, setUsageRows] = useState([]);
  const [usageUserDayRows, setUsageUserDayRows] = useState([]);
  const [usageUserDayLoading, setUsageUserDayLoading] = useState(false);
  const [usageExporting, setUsageExporting] = useState(false);
  const [usageRawExporting, setUsageRawExporting] = useState(false);
  const [launchHistoryLoading, setLaunchHistoryLoading] = useState(false);
  const [launchHistoryRows, setLaunchHistoryRows] = useState([]);
  const [launchHistorySummary, setLaunchHistorySummary] = useState(EMPTY_LAUNCH_HISTORY_SUMMARY);
  const [usageSummary, setUsageSummary] = useState({
    generateClicks: 0,
    userCount: 0,
    creditsBurned: 0,
    expectedCredits: 0,
    currentCredits: null,
  });
  const [recentUsageEvents, setRecentUsageEvents] = useState([]);
  const resolvedCurrentCredits = useMemo(
    () => resolveCurrentCreditsValue(usageSummary, recentUsageEvents),
    [usageSummary, recentUsageEvents],
  );

  const applyToolsAccessStatus = useCallback((response) => {
    const canAccess = !!response?.canAccessTools;
    const message = `${response?.message || ''}`.trim();
    setToolsAccess({
      loading: false,
      checked: true,
      canAccess,
      isError: false,
      message,
    });
    return canAccess;
  }, []);

  const handleProtectedToolsError = useCallback((err, fallbackMessage = '') => {
    if (!isWorkplaceToolsAccessDeniedError(err)) {
      return false;
    }

    setError('');
    setNotice('');
    setLoading(false);
    setUsageLoading(false);
    setLaunchHistoryLoading(false);
    setUsageUserDayLoading(false);
    setToolsAccess({
      loading: false,
      checked: true,
      canAccess: false,
      isError: false,
      message: err?.response?.data?.detail || fallbackMessage || WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP,
    });
    return true;
  }, []);

  const loadToolCredentials = useCallback(async (toolList, signal, { manageLoading = true } = {}) => {
    if (signal?.aborted) return;
    if (!toolList.length) {
      setToolCredentialsByToolId({});
      return;
    }

    if (manageLoading) {
      setAssignmentLoading(true);
    }
    try {
      const results = await Promise.all(
        toolList.map(async (tool) => {
          try {
            const response = await itToolsAPI.getToolCredentials(tool.id);
            return [`${tool.id}`, response.credentials || []];
          } catch {
            return [`${tool.id}`, []];
          }
        })
      );

      if (!signal?.aborted) {
        setToolCredentialsByToolId(Object.fromEntries(results));
      }
    } finally {
      if (manageLoading && !signal?.aborted) {
        setAssignmentLoading(false);
      }
    }
  }, []);

  const refreshToolCredentialCache = useCallback(async (toolId) => {
    const response = await itToolsAPI.getToolCredentials(toolId);
    setToolCredentialsByToolId((current) => ({
      ...current,
      [`${toolId}`]: response.credentials || [],
    }));
  }, []);

  const loadTools = useCallback(async (signal) => {
    if (signal?.aborted) return;
    setLoading(true);
    setError('');
    try {
      const response = await itToolsAPI.listTools({ signal });
      if (signal?.aborted) return;
      const nextTools = response.tools || [];
      setTools(nextTools);
      setIsAdmin(!!response.isAdmin);
      if (response.isAdmin) {
        const inlineCredentialSummaries = response.credentialSummariesByToolId || null;
        setAssignmentLoading(true);
        if (inlineCredentialSummaries && typeof inlineCredentialSummaries === 'object') {
          setToolCredentialsByToolId(inlineCredentialSummaries);
        } else {
          setToolCredentialsByToolId({});
        }
        void (async () => {
          try {
            const userResponse = await authAPI.getAdminAllUsers({ signal });
            if (signal?.aborted) return;
            setUsers((userResponse.users || []).filter((user) => !user.isDeleted));
            if (!(inlineCredentialSummaries && typeof inlineCredentialSummaries === 'object')) {
              await loadToolCredentials(nextTools, signal, { manageLoading: false });
            }
          } catch (err) {
            if (isRequestCanceled(err) || signal?.aborted) return;
            if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
            setError(err?.response?.data?.detail || 'Unable to load IT tools.');
          } finally {
            if (!signal?.aborted) {
              setAssignmentLoading(false);
            }
          }
        })();
      } else if (!signal?.aborted) {
        setUsers([]);
        setToolCredentialsByToolId({});
      }
    } catch (err) {
      if (isRequestCanceled(err) || signal?.aborted) return;
      if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
      setError(err?.response?.data?.detail || 'Unable to load IT tools.');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [handleProtectedToolsError, loadToolCredentials]);

  useEffect(() => {
    const controller = new AbortController();

    setToolsAccess((current) => ({
      ...current,
      loading: true,
      checked: false,
      isError: false,
    }));
    setError('');

    void itToolsAPI.getAccessStatus({ signal: controller.signal }).then((response) => {
      if (controller.signal.aborted) return;
      applyToolsAccessStatus(response);
    }).catch((err) => {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
      setToolsAccess({
        loading: false,
        checked: true,
        canAccess: false,
        isError: true,
        message: err?.response?.data?.detail || WORKPLACE_TOOLS_ACCESS_CHECK_ERROR,
      });
    });

    return () => {
      controller.abort();
    };
  }, [applyToolsAccessStatus, handleProtectedToolsError, toolsAccessRetryCount]);

  useEffect(() => {
    if (toolsAccess.loading || !toolsAccess.canAccess) {
      setLoading(false);
      return undefined;
    }
    if (activeView !== 'tools') {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    void loadTools(controller.signal);

    return () => {
      controller.abort();
    };
  }, [activeView, loadTools, toolsAccess.canAccess, toolsAccess.loading]);

  useEffect(() => {
    const rootElement = containerRef.current;
    const headerElement = headerRef.current;
    if (!rootElement) return undefined;

    const isScrollableElement = (element) => {
      if (!element || element === document.body) return false;
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY || style.overflow;
      return /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight;
    };

    let scrollContainer = rootElement.parentElement;
    while (scrollContainer && !isScrollableElement(scrollContainer)) {
      scrollContainer = scrollContainer.parentElement;
    }

    const scrollTarget = scrollContainer || window;
    const getScrollTop = () => (
      scrollTarget === window
        ? (window.scrollY || window.pageYOffset || 0)
        : (scrollTarget.scrollTop || 0)
    );

    let lastScrollY = getScrollTop();
    let headerVisible = true;

    const setHeaderVisibleClass = (visible) => {
      if (headerVisible === visible) return;
      headerVisible = visible;
      if (!headerElement) return;
      headerElement.classList.toggle('is-visible', visible);
      headerElement.classList.toggle('is-hidden', !visible);
    };

    const handleScroll = () => {
      const currentScrollY = getScrollTop();
      const scrollDelta = currentScrollY - lastScrollY;

      if (currentScrollY <= 12) {
        setHeaderVisibleClass(true);
      } else if (scrollDelta > 6) {
        setHeaderVisibleClass(false);
      } else if (scrollDelta < -6) {
        setHeaderVisibleClass(true);
      }

      lastScrollY = currentScrollY;
    };

    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollTarget.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    if (toolsAccess.loading || !toolsAccess.canAccess) return undefined;
    if (!isUsageDashboardView) return undefined;

    const controller = new AbortController();
    setError('');
    setLoading(false);

    void authAPI.getAdminAllUsers({ signal: controller.signal }).then((response) => {
      if (controller.signal.aborted) return;
      setUsers((response.users || []).filter((user) => !user.isDeleted));
      setIsAdmin(true);
    }).catch((err) => {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
      if (err?.response?.status === 401 || err?.response?.status === 403) {
        setIsAdmin(false);
        setUsers([]);
        return;
      }
      console.warn('Unable to load credit filters:', err?.response?.data || err);
      setUsers([]);
    });

    return () => {
      controller.abort();
    };
  }, [activeView, handleProtectedToolsError, isUsageDashboardView, toolsAccess.canAccess, toolsAccess.loading]);

  useEffect(() => {
    if (toolsAccess.loading || !toolsAccess.canAccess) return undefined;
    if (!isUsageDashboardView) return undefined;

    const controller = new AbortController();
    void itToolsAPI.listTools({ signal: controller.signal }).then((response) => {
      if (controller.signal.aborted) return;
      if (Array.isArray(response.tools)) {
        setTools(response.tools);
      }
      if (response.credentialSummariesByToolId && typeof response.credentialSummariesByToolId === 'object') {
        setToolCredentialsByToolId(response.credentialSummariesByToolId);
      }
      if (typeof response.isAdmin === 'boolean') {
        setIsAdmin(response.isAdmin);
      }
    }).catch((err) => {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
      setError(err?.response?.data?.detail || 'Unable to load Kling credential mails.');
    });

    return () => {
      controller.abort();
    };
  }, [activeView, handleProtectedToolsError, isUsageDashboardView, toolsAccess.canAccess, toolsAccess.loading]);

  useEffect(() => {
    if (toolsAccess.loading || !toolsAccess.canAccess) return undefined;
    if (!isUsageDashboardView) return undefined;
    const controller = new AbortController();
    setUsageLoading(true);
    void itToolsAPI.getUsageReport({
      tool_slug: usageFilters.toolSlug,
      date_from: usageFilters.dateFrom,
      date_to: usageFilters.dateTo,
      user_id: usageFilters.userId || undefined,
      signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) return;
      if (typeof response.isAdmin === 'boolean') {
        setIsAdmin(response.isAdmin);
      }
      setUsageRows(response.rows || []);
      setUsageSummary(response.summary || {
        generateClicks: 0,
        userCount: 0,
        creditsBurned: 0,
        expectedCredits: 0,
        currentCredits: null,
      });
      setRecentUsageEvents(response.recentEvents || []);
    }).catch((err) => {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
      setError(err?.response?.data?.detail || 'Unable to load Kling usage report.');
    }).finally(() => {
      if (!controller.signal.aborted) {
        setUsageLoading(false);
      }
    });

    return () => controller.abort();
  }, [activeView, handleProtectedToolsError, isUsageDashboardView, toolsAccess.canAccess, toolsAccess.loading, usageFilters.toolSlug, usageFilters.dateFrom, usageFilters.dateTo, usageFilters.userId]);

  useEffect(() => {
    if (toolsAccess.loading || !toolsAccess.canAccess) return undefined;
    if (activeView !== 'credits' || !isAdmin) return undefined;
    const controller = new AbortController();
    setLaunchHistoryLoading(true);
    void itToolsAPI.getLaunchHistory({
      date_from: usageFilters.dateFrom,
      date_to: usageFilters.dateTo,
      user_id: usageFilters.userId || undefined,
      signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) return;
      setLaunchHistoryRows(response.rows || []);
      setLaunchHistorySummary(response.summary || EMPTY_LAUNCH_HISTORY_SUMMARY);
    }).catch((err) => {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
      setError(err?.response?.data?.detail || 'Unable to load all tool launch history.');
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLaunchHistoryLoading(false);
      }
    });

    return () => controller.abort();
  }, [activeView, handleProtectedToolsError, isAdmin, toolsAccess.canAccess, toolsAccess.loading, usageFilters.dateFrom, usageFilters.dateTo, usageFilters.userId]);

  useEffect(() => {
    if (toolsAccess.loading || !toolsAccess.canAccess) return undefined;
    if (!isUsageDashboardView) return undefined;

    const refreshUsage = () => {
      if (usageRefreshControllerRef.current) return usageRefreshControllerRef.current;
      const controller = new AbortController();
      usageRefreshControllerRef.current = controller;
      void itToolsAPI.getUsageReport({
        tool_slug: usageFilters.toolSlug,
        date_from: usageFilters.dateFrom,
        date_to: usageFilters.dateTo,
        user_id: usageFilters.userId || undefined,
        signal: controller.signal,
      }).then((response) => {
        if (controller.signal.aborted) return;
        if (typeof response.isAdmin === 'boolean') {
          setIsAdmin(response.isAdmin);
        }
        setUsageRows(response.rows || []);
        setUsageSummary(response.summary || {
          generateClicks: 0,
          userCount: 0,
          creditsBurned: 0,
          expectedCredits: 0,
          currentCredits: null,
        });
        setRecentUsageEvents(response.recentEvents || []);
      }).catch((err) => {
        if (isRequestCanceled(err) || controller.signal.aborted) return;
        if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
        setError(err?.response?.data?.detail || 'Unable to refresh Kling usage report.');
      }).finally(() => {
        if (usageRefreshControllerRef.current === controller) {
          usageRefreshControllerRef.current = null;
        }
      });
      if (activeView === 'credits' && isAdmin) {
        void itToolsAPI.getLaunchHistory({
          date_from: usageFilters.dateFrom,
          date_to: usageFilters.dateTo,
          user_id: usageFilters.userId || undefined,
        }).then((response) => {
          setLaunchHistoryRows(response.rows || []);
          setLaunchHistorySummary(response.summary || EMPTY_LAUNCH_HISTORY_SUMMARY);
        }).catch((err) => {
          if (isRequestCanceled(err)) return;
          if (handleProtectedToolsError(err, WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP)) return;
          setError(err?.response?.data?.detail || 'Unable to refresh all tool launch history.');
        });
      }
      return controller;
    };

    const intervalId = window.setInterval(() => {
      refreshUsage();
    }, USAGE_REPORT_REFRESH_MS);

    const handleFocus = () => {
      refreshUsage();
    };

    window.addEventListener('focus', handleFocus);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      usageRefreshControllerRef.current?.abort();
      usageRefreshControllerRef.current = null;
    };
  }, [activeView, handleProtectedToolsError, isAdmin, isUsageDashboardView, toolsAccess.canAccess, toolsAccess.loading, usageFilters.toolSlug, usageFilters.dateFrom, usageFilters.dateTo, usageFilters.userId]);

  const handleExportKlingUsage = async () => {
    setError('');
    setUsageExporting(true);
    try {
      const response = await itToolsAPI.exportKlingUsageReport({
        date_from: usageFilters.dateFrom,
        date_to: usageFilters.dateTo,
        user_id: usageFilters.userId || undefined,
        credential_id: usageFilters.credentialId || undefined,
      });
      const fromLabel = usageFilters.dateFrom || 'all';
      const toLabel = usageFilters.dateTo || fromLabel;
      downloadBlobResponse(response, `kling-usage-${fromLabel}-to-${toLabel}.xlsx`);
    } catch (err) {
      setError(err?.response?.data?.detail || 'Unable to export Kling usage report.');
    } finally {
      setUsageExporting(false);
    }
  };

  const handleExportKlingRawUsage = async () => {
    setError('');
    setUsageRawExporting(true);
    try {
      const response = await itToolsAPI.exportKlingRawUsageReport({
        date_from: usageFilters.dateFrom,
        date_to: usageFilters.dateTo,
        user_id: usageFilters.userId || undefined,
        credential_id: usageFilters.credentialId || undefined,
      });
      const fromLabel = usageFilters.dateFrom || 'all';
      const toLabel = usageFilters.dateTo || fromLabel;
      downloadBlobResponse(response, `kling-raw-usage-${fromLabel}-to-${toLabel}.xlsx`);
    } catch (err) {
      setError(err?.response?.data?.detail || 'Unable to export raw Kling usage report.');
    } finally {
      setUsageRawExporting(false);
    }
  };

  const categories = useMemo(() => {
    return ['All', ...new Set(tools.map((tool) => tool.category || 'General'))];
  }, [tools]);

  const sortedUsers = useMemo(() => {
    return [...users].sort((left, right) => {
      const leftLabel = `${left?.name || ''} ${left?.email || ''}`.trim().toLowerCase();
      const rightLabel = `${right?.name || ''} ${right?.email || ''}`.trim().toLowerCase();
      return leftLabel.localeCompare(rightLabel);
    });
  }, [users]);

  const toolById = useMemo(() => {
    const nextMap = new Map();
    tools.forEach((tool) => {
      nextMap.set(Number(tool.id), tool);
    });
    return nextMap;
  }, [tools]);

  const klingCredentialSummaries = useMemo(() => {
    return tools
      .filter((tool) => isKlingUsageTool(tool))
      .flatMap((tool) => toolCredentialsByToolId[`${tool.id}`] || [])
      .filter((summary) => Number(summary?.id || 0) > 0)
      .filter((summary) => Boolean(summary?.isActive))
      .filter((summary) => Boolean(normalizeUsageCredentialLabel(summary?.loginIdentifierPreview)));
  }, [toolCredentialsByToolId, tools]);

  const klingCredentialLabelMap = useMemo(() => {
    const nextMap = new Map();
    klingCredentialSummaries.forEach((summary) => {
      const numericCredentialId = Number(summary?.id || 0);
      const loginIdentifierPreview = normalizeUsageCredentialLabel(summary?.loginIdentifierPreview);
      if (numericCredentialId > 0 && loginIdentifierPreview) {
        nextMap.set(numericCredentialId, loginIdentifierPreview);
      }
    });
    return nextMap;
  }, [klingCredentialSummaries]);

  const normalizedUsageRows = useMemo(() => {
    return usageRows.map((row) => ({
      ...row,
      credentialLabel: resolveUsageCredentialLabel(row, klingCredentialLabelMap),
    }));
  }, [klingCredentialLabelMap, usageRows]);

  const normalizedRecentUsageEvents = useMemo(() => {
    return recentUsageEvents.map((event) => ({
      ...event,
      credentialLabel: resolveUsageCredentialLabel(event, klingCredentialLabelMap),
    }));
  }, [klingCredentialLabelMap, recentUsageEvents]);

  const usageCredentialOptions = useMemo(() => {
    const optionMap = new Map();
    const addOption = (credentialId, credentialLabel = '') => {
      const numericCredentialId = Number(credentialId || 0);
      if (numericCredentialId <= 0) return;
      const label = normalizeUsageCredentialLabel(credentialLabel);
      if (!label || optionMap.has(label)) return;
      optionMap.set(label, {
        value: `${numericCredentialId}`,
        label,
      });
    };

    klingCredentialSummaries.forEach((summary) => {
      addOption(summary.id, summary.loginIdentifierPreview);
    });

    return Array.from(optionMap.values()).sort((left, right) => left.label.localeCompare(right.label));
  }, [klingCredentialSummaries]);

  const availableUsageCredentialIds = useMemo(() => {
    return new Set(usageCredentialOptions.map((option) => option.value));
  }, [usageCredentialOptions]);

  const filteredUsageRows = useMemo(() => {
    const normalizedCredentialId = `${usageFilters.credentialId || ''}`.trim();
    if (!normalizedCredentialId) return normalizedUsageRows;
    if (!availableUsageCredentialIds.has(normalizedCredentialId)) return normalizedUsageRows;
    return normalizedUsageRows.filter((row) => `${row.credentialId || ''}` === normalizedCredentialId);
  }, [availableUsageCredentialIds, normalizedUsageRows, usageFilters.credentialId]);

  const filteredRecentUsageEvents = useMemo(() => {
    const normalizedCredentialId = `${usageFilters.credentialId || ''}`.trim();
    if (!normalizedCredentialId) return normalizedRecentUsageEvents;
    if (!availableUsageCredentialIds.has(normalizedCredentialId)) return normalizedRecentUsageEvents;
    return normalizedRecentUsageEvents.filter((event) => `${event.credentialId || ''}` === normalizedCredentialId);
  }, [availableUsageCredentialIds, normalizedRecentUsageEvents, usageFilters.credentialId]);

  useEffect(() => {
    const normalizedCredentialId = `${usageFilters.credentialId || ''}`.trim();
    if (!normalizedCredentialId) return;
    if (availableUsageCredentialIds.has(normalizedCredentialId)) return;
    setUsageFilters((current) => {
      if (!current.credentialId || availableUsageCredentialIds.has(`${current.credentialId}`.trim())) {
        return current;
      }
      return {
        ...current,
        credentialId: '',
      };
    });
  }, [availableUsageCredentialIds, usageFilters.credentialId]);

  const displayableUsageRows = useMemo(() => {
    return filteredUsageRows.filter((row) => hasDisplayableUsageCredential(row));
  }, [filteredUsageRows]);

  const usageBreakdown = useMemo(() => {
    const userMap = new Map();
    const credentialMap = new Map();
    const trackedCredentialIds = new Set();

    const matrixRows = [...displayableUsageRows]
      .map((row) => ({
        ...row,
        generateClicks: Number(row.generateClicks || 0),
        creditsBurned: Number(row.creditsBurned || 0),
        expectedCredits: Number(row.expectedCredits || 0),
      }))
      .sort((left, right) => {
        const totalsComparison = compareUsageAggregateTotals(left, right);
        if (totalsComparison !== 0) return totalsComparison;
        return getUsageUserLabel(left).localeCompare(getUsageUserLabel(right));
      });

    matrixRows.forEach((row) => {
      const userKey = getUsageUserKey(row);
      const credentialKey = getUsageCredentialKey(row);
      const numericCredentialId = Number(row.credentialId || 0);
      const lastEventTime = getUsageTimestamp(row.lastEventAt);

      if (numericCredentialId > 0) {
        trackedCredentialIds.add(numericCredentialId);
      }

      if (!userMap.has(userKey)) {
        userMap.set(userKey, {
          key: userKey,
          userId: row.userId,
          userName: row.userName || '',
          userEmail: row.userEmail || '',
          generateClicks: 0,
          creditsBurned: 0,
          expectedCredits: 0,
          lastEventAt: row.lastEventAt || '',
          lastEventTime,
          credentials: new Map(),
        });
      }

      const userEntry = userMap.get(userKey);
      userEntry.generateClicks += Number(row.generateClicks || 0);
      userEntry.creditsBurned += Number(row.creditsBurned || 0);
      userEntry.expectedCredits += Number(row.expectedCredits || 0);
      if (lastEventTime >= userEntry.lastEventTime) {
        userEntry.lastEventTime = lastEventTime;
        userEntry.lastEventAt = row.lastEventAt || userEntry.lastEventAt;
      }

      if (!userEntry.credentials.has(credentialKey)) {
        userEntry.credentials.set(credentialKey, {
          key: credentialKey,
          credentialId: row.credentialId,
          credentialLabel: row.credentialLabel || '',
          credentialScope: row.credentialScope || '',
          generateClicks: 0,
          creditsBurned: 0,
          expectedCredits: 0,
          lastEventAt: row.lastEventAt || '',
          lastEventTime,
        });
      }

      const userCredentialEntry = userEntry.credentials.get(credentialKey);
      userCredentialEntry.generateClicks += Number(row.generateClicks || 0);
      userCredentialEntry.creditsBurned += Number(row.creditsBurned || 0);
      userCredentialEntry.expectedCredits += Number(row.expectedCredits || 0);
      if (lastEventTime >= userCredentialEntry.lastEventTime) {
        userCredentialEntry.lastEventTime = lastEventTime;
        userCredentialEntry.lastEventAt = row.lastEventAt || userCredentialEntry.lastEventAt;
      }

      if (!credentialMap.has(credentialKey)) {
        credentialMap.set(credentialKey, {
          key: credentialKey,
          credentialId: row.credentialId,
          credentialLabel: row.credentialLabel || '',
          credentialScope: row.credentialScope || '',
          generateClicks: 0,
          creditsBurned: 0,
          expectedCredits: 0,
          lastEventAt: row.lastEventAt || '',
          lastEventTime,
          users: new Map(),
        });
      }

      const credentialEntry = credentialMap.get(credentialKey);
      credentialEntry.generateClicks += Number(row.generateClicks || 0);
      credentialEntry.creditsBurned += Number(row.creditsBurned || 0);
      credentialEntry.expectedCredits += Number(row.expectedCredits || 0);
      if (lastEventTime >= credentialEntry.lastEventTime) {
        credentialEntry.lastEventTime = lastEventTime;
        credentialEntry.lastEventAt = row.lastEventAt || credentialEntry.lastEventAt;
      }

      if (!credentialEntry.users.has(userKey)) {
        credentialEntry.users.set(userKey, {
          key: userKey,
          userId: row.userId,
          userName: row.userName || '',
          userEmail: row.userEmail || '',
          generateClicks: 0,
          creditsBurned: 0,
          expectedCredits: 0,
          lastEventAt: row.lastEventAt || '',
          lastEventTime,
        });
      }

      const credentialUserEntry = credentialEntry.users.get(userKey);
      credentialUserEntry.generateClicks += Number(row.generateClicks || 0);
      credentialUserEntry.creditsBurned += Number(row.creditsBurned || 0);
      credentialUserEntry.expectedCredits += Number(row.expectedCredits || 0);
      if (lastEventTime >= credentialUserEntry.lastEventTime) {
        credentialUserEntry.lastEventTime = lastEventTime;
        credentialUserEntry.lastEventAt = row.lastEventAt || credentialUserEntry.lastEventAt;
      }
    });

    return {
      matrixRows,
      byUser: Array.from(userMap.values())
        .map((entry) => ({
          ...entry,
          credentialCount: entry.credentials.size,
          credentials: Array.from(entry.credentials.values())
            .sort(compareUsageAggregateTotals)
            .map((credentialEntry) => {
              const nextCredentialEntry = { ...credentialEntry };
              delete nextCredentialEntry.lastEventTime;
              return nextCredentialEntry;
            }),
        }))
        .sort(compareUsageAggregateTotals)
        .map((entry) => {
          const nextEntry = { ...entry };
          delete nextEntry.lastEventTime;
          return nextEntry;
        }),
      byCredential: Array.from(credentialMap.values())
        .map((entry) => ({
          ...entry,
          userCount: entry.users.size,
          users: Array.from(entry.users.values())
            .sort((left, right) => {
              const totalsComparison = compareUsageAggregateTotals(left, right);
              if (totalsComparison !== 0) return totalsComparison;
              return getUsageUserLabel(left).localeCompare(getUsageUserLabel(right));
            })
            .map((userEntry) => {
              const nextUserEntry = { ...userEntry };
              delete nextUserEntry.lastEventTime;
              return nextUserEntry;
            }),
        }))
        .sort((left, right) => {
          const totalsComparison = compareUsageAggregateTotals(left, right);
          if (totalsComparison !== 0) return totalsComparison;
          return formatUsageCredentialTitle(left.credentialLabel, left.credentialId)
            .localeCompare(formatUsageCredentialTitle(right.credentialLabel, right.credentialId));
        })
        .map((entry) => {
          const nextEntry = { ...entry };
          delete nextEntry.lastEventTime;
          return nextEntry;
        }),
      trackedCredentialCount: trackedCredentialIds.size,
    };
  }, [displayableUsageRows]);

  const usageSummaryForDisplay = useMemo(() => {
    const hasAnyFilteredData = filteredUsageRows.length > 0 || filteredRecentUsageEvents.length > 0;
    if (!hasAnyFilteredData) {
      return {
        generateClicks: 0,
        creditsBurned: 0,
        currentCredits: null,
      };
    }

    let generateClicks = 0;
    let creditsBurned = 0;

    displayableUsageRows.forEach((row) => {
      generateClicks += Number(row.generateClicks || 0);
      creditsBurned += Number(row.creditsBurned || 0);
    });

    const filteredCurrentCredits = resolveCurrentCreditsValue({ currentCredits: null }, filteredRecentUsageEvents);

    return {
      generateClicks,
      creditsBurned,
      currentCredits: filteredCurrentCredits != null ? filteredCurrentCredits : resolvedCurrentCredits,
    };
  }, [displayableUsageRows, filteredRecentUsageEvents, filteredUsageRows.length, resolvedCurrentCredits]);

  const usageCharts = useMemo(() => {
    const dailyMap = new Map();
    const userMap = new Map();
    const dailyUserMap = new Map();

    displayableUsageRows.forEach((row) => {
      const dateKey = toUsageDateKey(row.date);
      const creditsBurned = Number(row.creditsBurned || 0);
      const generateClicks = Number(row.generateClicks || 0);
      const lastEventAt = row.lastEventAt || '';
      const lastEventTime = getUsageTimestamp(lastEventAt);

      if (dateKey) {
        const dailyEntry = dailyMap.get(dateKey) || {
          date: dateKey,
          creditsBurned: 0,
          generateClicks: 0,
        };
        dailyEntry.creditsBurned += creditsBurned;
        dailyEntry.generateClicks += generateClicks;
        dailyMap.set(dateKey, dailyEntry);

        if (!dailyUserMap.has(dateKey)) {
          dailyUserMap.set(dateKey, new Map());
        }
        const perDayUserMap = dailyUserMap.get(dateKey);
        const userKey = getUsageUserKey(row);
        if (!perDayUserMap.has(userKey)) {
          perDayUserMap.set(userKey, {
            key: userKey,
            userId: row.userId,
            userName: row.userName || '',
            userEmail: row.userEmail || '',
            creditsBurned: 0,
          });
        }
        const perDayUserEntry = perDayUserMap.get(userKey);
        perDayUserEntry.creditsBurned += creditsBurned;
      }

      const userKey = getUsageUserKey(row);
      if (!userMap.has(userKey)) {
        userMap.set(userKey, {
          key: userKey,
          userId: row.userId,
          userName: row.userName || '',
          userEmail: row.userEmail || '',
          creditsBurned: 0,
          generateClicks: 0,
          lastEventAt,
          lastEventTime,
        });
      }

      const userEntry = userMap.get(userKey);
      userEntry.creditsBurned += creditsBurned;
      userEntry.generateClicks += generateClicks;
      if (lastEventTime >= userEntry.lastEventTime) {
        userEntry.lastEventAt = lastEventAt;
        userEntry.lastEventTime = lastEventTime;
      }
    });

    const requestedDateKeys = getUsageDateRangeKeys(usageFilters.dateFrom, usageFilters.dateTo);
    const sortedKnownDateKeys = Array.from(dailyMap.keys()).sort((left, right) => left.localeCompare(right));
    const dailySeries = (requestedDateKeys.length ? requestedDateKeys : sortedKnownDateKeys).map((dateKey) => {
      const dayEntry = dailyMap.get(dateKey);
      return {
        date: dateKey,
        creditsBurned: Number(dayEntry?.creditsBurned || 0),
        generateClicks: Number(dayEntry?.generateClicks || 0),
      };
    });

    const userSeries = Array.from(userMap.values())
      .sort((left, right) => {
        const totalsComparison = compareUsageAggregateTotals(left, right);
        if (totalsComparison !== 0) return totalsComparison;
        return getUsageUserLabel(left).localeCompare(getUsageUserLabel(right));
      })
      .map((entry) => {
        const nextEntry = { ...entry };
        delete nextEntry.lastEventTime;
        return nextEntry;
      });

    const userDailySeriesByDate = new Map(
      dailySeries.map((dayEntry) => {
        const perDayEntries = Array.from((dailyUserMap.get(dayEntry.date) || new Map()).values())
          .map((entry) => ({
            ...entry,
            label: getUsageUserLabel(entry),
            shortLabel: getUsageUserLabel(entry).slice(0, 18),
            creditsBurned: Number(entry.creditsBurned || 0),
          }))
          .sort((left, right) => {
            if (Number(right.creditsBurned || 0) !== Number(left.creditsBurned || 0)) {
              return Number(right.creditsBurned || 0) - Number(left.creditsBurned || 0);
            }
            return getUsageUserLabel(left).localeCompare(getUsageUserLabel(right));
          });
        return [dayEntry.date, perDayEntries];
      })
    );

    const peakDay = dailySeries.reduce((best, current) => {
      if (!best || current.creditsBurned > best.creditsBurned) return current;
      return best;
    }, null);

    const totalCreditsBurned = dailySeries.reduce((sum, item) => sum + Number(item.creditsBurned || 0), 0);

    return {
      dailySeries,
      userSeries,
      totalCreditsBurned,
      selectedDayCount: dailySeries.length,
      averageDailyBurn: dailySeries.length ? totalCreditsBurned / dailySeries.length : 0,
      peakDay,
      topUser: userSeries[0] || null,
      availableDateKeys: dailySeries.map((entry) => entry.date),
      userDailySeriesByDate,
    };
  }, [displayableUsageRows, usageFilters.dateFrom, usageFilters.dateTo]);

  const usageChartRangeLabel = useMemo(() => {
    if (usageFilters.dateFrom && usageFilters.dateTo) {
      return `${formatUsageDate(usageFilters.dateFrom)} to ${formatUsageDate(usageFilters.dateTo)}`;
    }
    if (usageFilters.dateFrom) return `From ${formatUsageDate(usageFilters.dateFrom)}`;
    if (usageFilters.dateTo) return `Until ${formatUsageDate(usageFilters.dateTo)}`;
    return 'All recorded dates';
  }, [usageFilters.dateFrom, usageFilters.dateTo]);

  useEffect(() => {
    const normalizedCurrent = toUsageDateKey(usageUserDayChartDate);
    if (normalizedCurrent) return;

    const normalizedDateTo = toUsageDateKey(usageFilters.dateTo);
    const normalizedDateFrom = toUsageDateKey(usageFilters.dateFrom);
    const nextDate = normalizedDateTo || normalizedDateFrom;
    if (nextDate) {
      setUsageUserDayChartDate(nextDate);
    }
  }, [usageFilters.dateFrom, usageFilters.dateTo, usageUserDayChartDate]);

  useEffect(() => {
    if (activeView !== 'charts' || !isAdmin) return undefined;
    const selectedDateKey = toUsageDateKey(usageUserDayChartDate);
    if (!selectedDateKey) {
      setUsageUserDayRows([]);
      setUsageUserDayLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setUsageUserDayLoading(true);
    void itToolsAPI.getUsageReport({
      tool_slug: usageFilters.toolSlug,
      date_from: selectedDateKey,
      date_to: selectedDateKey,
      user_id: usageFilters.userId || undefined,
      signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) return;
      setUsageUserDayRows(response.rows || []);
    }).catch((err) => {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      setError(err?.response?.data?.detail || 'Unable to load day-wise user credit chart.');
      setUsageUserDayRows([]);
    }).finally(() => {
      if (!controller.signal.aborted) {
        setUsageUserDayLoading(false);
      }
    });

    return () => controller.abort();
  }, [activeView, isAdmin, usageFilters.toolSlug, usageFilters.userId, usageUserDayChartDate]);

  const normalizedUsageUserDayRows = useMemo(() => {
    return usageUserDayRows.map((row) => ({
      ...row,
      credentialLabel: resolveUsageCredentialLabel(row, klingCredentialLabelMap),
    }));
  }, [klingCredentialLabelMap, usageUserDayRows]);

  const filteredUsageUserDayRows = useMemo(() => {
    const normalizedCredentialId = `${usageFilters.credentialId || ''}`.trim();
    if (!normalizedCredentialId) return normalizedUsageUserDayRows;
    if (!availableUsageCredentialIds.has(normalizedCredentialId)) return normalizedUsageUserDayRows;
    return normalizedUsageUserDayRows.filter((row) => `${row.credentialId || ''}` === normalizedCredentialId);
  }, [availableUsageCredentialIds, normalizedUsageUserDayRows, usageFilters.credentialId]);

  const selectedUsageUserDaySeries = useMemo(() => {
    const userMap = new Map();

    filteredUsageUserDayRows.forEach((row) => {
      const userKey = getUsageUserKey(row);
      const creditsBurned = Number(row.creditsBurned || 0);
      const generateClicks = Number(row.generateClicks || 0);

      if (!userMap.has(userKey)) {
        userMap.set(userKey, {
          key: userKey,
          userId: row.userId,
          userName: row.userName || '',
          userEmail: row.userEmail || '',
          label: getUsageUserLabel(row),
          shortLabel: getUsageUserLabel(row).slice(0, 18),
          creditsBurned: 0,
          generateClicks: 0,
        });
      }

      const userEntry = userMap.get(userKey);
      userEntry.creditsBurned += creditsBurned;
      userEntry.generateClicks += generateClicks;
    });

    return Array.from(userMap.values()).sort((left, right) => {
      if (Number(right.creditsBurned || 0) !== Number(left.creditsBurned || 0)) {
        return Number(right.creditsBurned || 0) - Number(left.creditsBurned || 0);
      }
      return `${left.label || ''}`.localeCompare(`${right.label || ''}`);
    });
  }, [filteredUsageUserDayRows]);

  const selectedUsageUserDayTotal = useMemo(() => (
    selectedUsageUserDaySeries.reduce((sum, entry) => sum + Number(entry.creditsBurned || 0), 0)
  ), [selectedUsageUserDaySeries]);

  const filteredTools = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return tools.filter((tool) => {
      const matchesSearch =
        !query ||
        tool.name?.toLowerCase().includes(query) ||
        tool.category?.toLowerCase().includes(query);
      const matchesCategory = selectedCategory === 'All' || tool.category === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [searchQuery, selectedCategory, tools]);

  const accessMatrixTools = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return tools;
    return tools.filter((tool) => (
      tool.name?.toLowerCase().includes(query)
      || tool.category?.toLowerCase().includes(query)
    ));
  }, [searchQuery, tools]);

  const activeCredentialTool = useMemo(() => {
    const toolId = `${credentialForm.toolId || selectedTool?.id || ''}`.trim();
    if (!toolId) return null;
    return tools.find((tool) => `${tool.id}` === toolId) || null;
  }, [credentialForm.toolId, selectedTool, tools]);

  const activeCredentialToolSlug = normalizeToolSlug(activeCredentialTool?.slug);
  const activeCredentialLoginMethod = credentialForm.login_method || getDefaultCredentialLoginMethod(activeCredentialToolSlug);
  const showToolTotpSecretField = toolSupportsAuthenticatorSeed(activeCredentialToolSlug, activeCredentialLoginMethod);
  const showFlowBackupCodesField = activeCredentialToolSlug === 'flow';
  const activeCredentialPasswordOptional = toolSupportsPasswordOptionalCredential(activeCredentialToolSlug)
    || (toolSupportsCredentialLoginMethodSelection(activeCredentialToolSlug) && activeCredentialLoginMethod === 'google');
  const activeCredentialShouldHidePasswordField = toolSupportsPasswordOptionalCredential(activeCredentialToolSlug);
  const totpSecretToolLabel = getAuthenticatorSeedToolLabel(activeCredentialToolSlug);
  const activeCredentialToolSummaries = useMemo(() => {
    const toolId = `${activeCredentialTool?.id || ''}`.trim();
    if (!toolId) return [];
    return toolCredentialsByToolId[toolId] || [];
  }, [activeCredentialTool, toolCredentialsByToolId]);
  const activeSharedCompanyCredentials = useMemo(() => {
    if (!supportsSharedCompanyCredentialAssignments(activeCredentialToolSlug)) return [];
    return activeCredentialToolSummaries.filter(
      (summary) => summary.scope === 'company'
        && Boolean(summary?.isActive)
        && Boolean(
          summary?.hasApiKey
          || (
            summary?.hasLoginIdentifier
            && (
              summary?.hasPassword
              || toolSupportsPasswordOptionalCredential(activeCredentialTool)
              || (
                toolSupportsCredentialLoginMethodSelection(activeCredentialTool)
                && (summary?.loginMethod || getDefaultCredentialLoginMethod(activeCredentialTool)) === 'google'
              )
            )
          )
        )
    );
  }, [activeCredentialToolSlug, activeCredentialToolSummaries, activeCredentialTool]);
  const selectedSharedCredentialSummary = useMemo(() => {
    const credentialId = Number(credentialForm.credential_id || 0);
    if (!credentialId) return null;
    return activeSharedCompanyCredentials.find((summary) => Number(summary.id) === credentialId) || null;
  }, [activeSharedCompanyCredentials, credentialForm.credential_id]);
  const sharedCredentialLabels = useMemo(
    () => getSharedCredentialLabels(activeCredentialTool || activeCredentialToolSlug),
    [activeCredentialTool, activeCredentialToolSlug],
  );

  const credentialDirectory = useMemo(() => {
    return tools.reduce((accumulator, tool) => {
      const summaries = toolCredentialsByToolId[`${tool.id}`] || [];
      const directory = {
        company: null,
        companyList: [],
        users: {},
      };

      summaries.forEach((summary) => {
        if (summary.scope === 'company') {
          directory.companyList.push(summary);
          if (!directory.company) {
            directory.company = summary;
          }
          return;
        }
        if (summary.scope === 'user' && summary.userId && !directory.users[summary.userId]) {
          directory.users[summary.userId] = summary;
        }
      });

      accumulator[tool.id] = directory;
      return accumulator;
    }, {});
  }, [toolCredentialsByToolId, tools]);

  const hasStoredUsableCredentialSummary = (summary, toolValue = null) => {
    const loginMethod = summary?.loginMethod || getDefaultCredentialLoginMethod(toolValue);
    const passwordOptional = toolSupportsPasswordOptionalCredential(toolValue)
      || (toolSupportsCredentialLoginMethodSelection(toolValue) && loginMethod === 'google');
    return Boolean(
      summary
      && (
        summary.hasApiKey
        || (
          summary.hasLoginIdentifier
          && (summary.hasPassword || passwordOptional)
        )
      )
    );
  };

  const hasActiveUsableCredentialSummary = (summary, toolValue = null) => {
    return Boolean(summary?.isActive) && hasStoredUsableCredentialSummary(summary, toolValue);
  };

  const getLinkedCompanyCredentialSummary = (directory, userCredential) => {
    if (!userCredential?.linkedCredentialId) return null;
    return (directory.companyList || []).find(
      (summary) => Number(summary.id) === Number(userCredential.linkedCredentialId),
    ) || null;
  };

  const getAssignedSharedCredentialSummary = (toolId, userId) => {
    const tool = toolById.get(Number(toolId));
    if (!supportsSharedCompanyCredentialAssignments(tool)) {
      return null;
    }

    const directory = credentialDirectory[toolId] || { companyList: [], users: {} };
    const userCredential = directory.users[userId];
    return getLinkedCompanyCredentialSummary(directory, userCredential);
  };

  const isSharedCredentialAssignmentMode = (toolId) => {
    const tool = toolById.get(Number(toolId));
    const normalizedToolSlug = normalizeToolSlug(tool?.slug);
    if (!supportsSharedCompanyCredentialAssignments(normalizedToolSlug)) {
      return false;
    }

    const directory = credentialDirectory[toolId] || { companyList: [] };
    const companyList = directory.companyList || [];
    return companyList.length > 1 || companyList.some((summary) => (summary.assignedUserIds || []).length > 0);
  };

  const isUserAssignedToTool = (toolId, userId) => {
    const directory = credentialDirectory[toolId] || { company: null, companyList: [], users: {} };
    const userCredential = directory.users[userId];
    const linkedCompanyCredential = getLinkedCompanyCredentialSummary(directory, userCredential);
    const sharedCredentialAssignmentMode = isSharedCredentialAssignmentMode(toolId);
    const tool = toolById.get(Number(toolId)) || null;

    if (userCredential) {
      if (!userCredential.isActive) {
        return false;
      }
      if (hasActiveUsableCredentialSummary(linkedCompanyCredential, tool)) {
        return true;
      }
      if (hasStoredUsableCredentialSummary(userCredential, tool)) {
        return true;
      }
      return false;
    }

    if (sharedCredentialAssignmentMode) {
      return false;
    }
    return false;
  };

  const loadSharedCredentialIntoForm = (summary) => {
    if (!summary) return;
    setCredentialForm({
      ...EMPTY_CREDENTIAL_FORM,
      toolId: `${summary.toolId || activeCredentialTool?.id || ''}`,
      credential_id: `${summary.id}`,
      scope: 'company',
      login_method: summary.loginMethod || getDefaultCredentialLoginMethod(activeCredentialToolSlug),
      assigned_user_ids: (summary.assignedUserIds || []).map((value) => `${value}`),
      login_identifier: summary.loginIdentifierPreview || '',
      notes: summary.notes || '',
    });
  };

  const resetSharedCredentialSelection = () => {
    const toolId = credentialForm.toolId || selectedTool?.id || activeCredentialTool?.id || '';
    setCredentialForm((current) => ({
      ...EMPTY_CREDENTIAL_FORM,
      toolId: `${toolId || ''}`,
      scope: current.scope || 'company',
      login_method: getDefaultCredentialLoginMethod(activeCredentialToolSlug),
    }));
  };

  const openSharedCredentialAssignmentPicker = (tool, user, activeCompanyCredentials) => {
    const currentAssignment = getAssignedSharedCredentialSummary(tool.id, user.id);
    const defaultCredentialId = currentAssignment
      ? `${currentAssignment.id}`
      : activeCompanyCredentials.length === 1
        ? `${activeCompanyCredentials[0].id}`
        : '';
    setSharedCredentialAssignmentPicker({
      tool,
      user,
      options: activeCompanyCredentials,
      selectedCredentialId: defaultCredentialId,
      currentCredentialId: currentAssignment ? `${currentAssignment.id}` : '',
    });
  };

  const closeSharedCredentialAssignmentPicker = () => {
    setSharedCredentialAssignmentPicker(null);
  };

  const handleConfirmSharedCredentialAssignment = async () => {
    if (!sharedCredentialAssignmentPicker?.tool || !sharedCredentialAssignmentPicker?.user) {
      return;
    }

    const tool = sharedCredentialAssignmentPicker.tool;
    const user = sharedCredentialAssignmentPicker.user;
    const toolId = Number(tool.id);
    const userId = Number(user.id);
    const credentialId = Number(sharedCredentialAssignmentPicker.selectedCredentialId || 0);
    const labels = getSharedCredentialLabels(tool);

    if (!credentialId) {
      setError(`Choose the saved ${tool.name} ${labels.singular} you want to assign.`);
      return;
    }

    setAssignmentSavingKey(`${toolId}:${userId}`);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.upsertCredential(toolId, {
        scope: 'user',
        user_id: userId,
        linked_credential_id: credentialId,
        is_active: true,
      });
      await refreshToolCredentialCache(toolId);
      const chosenCredential = (sharedCredentialAssignmentPicker.options || []).find((item) => Number(item.id) === credentialId);
      setNotice(`${tool.name} now uses ${chosenCredential?.loginIdentifierPreview || `${labels.singular} #${credentialId}`} for ${user.name || user.email}.`);
      closeSharedCredentialAssignmentPicker();
    } catch (err) {
      setError(err?.response?.data?.detail || `Failed to assign the ${tool.name} ${labels.singular}.`);
    } finally {
      setAssignmentSavingKey('');
    }
  };

  const handleRemoveSharedCredentialAssignment = async () => {
    if (!sharedCredentialAssignmentPicker?.tool || !sharedCredentialAssignmentPicker?.user) {
      return;
    }

    const tool = sharedCredentialAssignmentPicker.tool;
    const user = sharedCredentialAssignmentPicker.user;
    const toolId = Number(tool.id);
    const userId = Number(user.id);

    setAssignmentSavingKey(`${toolId}:${userId}`);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.upsertCredential(toolId, {
        scope: 'user',
        user_id: userId,
        is_active: false,
      });
      await refreshToolCredentialCache(toolId);
      setNotice(`${tool.name} access removed from ${user.name || user.email}.`);
      closeSharedCredentialAssignmentPicker();
    } catch (err) {
      setError(err?.response?.data?.detail || `Failed to remove the ${tool.name} assignment.`);
    } finally {
      setAssignmentSavingKey('');
    }
  };

  const handleToggleAssignment = async (tool, user) => {
    const toolId = Number(tool.id);
    const userId = Number(user.id);
    const directory = credentialDirectory[toolId] || { company: null, companyList: [], users: {} };
    const userCredential = directory.users[userId];
    const linkedCompanyCredential = getLinkedCompanyCredentialSummary(directory, userCredential);
    const normalizedToolSlug = normalizeToolSlug(tool?.slug);
    const currentlyAssigned = isUserAssignedToTool(toolId, userId);
    const activeCompanyCredentials = (directory.companyList || []).filter((summary) => hasActiveUsableCredentialSummary(summary, tool));
    const hasDirectUserCredential = Boolean(
      userCredential?.isActive
      && !linkedCompanyCredential
      && hasStoredUsableCredentialSummary(userCredential, tool)
    );
    const hasSourceCredential = hasStoredUsableCredentialSummary(userCredential, tool) || activeCompanyCredentials.length > 0;

      if (!currentlyAssigned && !hasSourceCredential) {
        setSelectedTool(tool);
        setToolAdminSection('add');
        setCredentialForm({
          ...EMPTY_CREDENTIAL_FORM,
          toolId: `${toolId}`,
          scope: 'user',
          login_method: getDefaultCredentialLoginMethod(tool),
          user_ids: [`${userId}`],
        });
        setError('');
        setNotice(`No credential source is ready for ${tool.name} yet. The password form is now set to Specific user for ${user.name || user.email}. When you save it, the credential will also be kept in the company library so you can reuse it later.`);
        window.requestAnimationFrame(() => {
          const credentialFormElement = document.querySelector('[data-tool-credential-form="true"]');
          credentialFormElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        return;
    }

    if (
      supportsSharedCompanyCredentialAssignments(normalizedToolSlug)
      && activeCompanyCredentials.length > 0
      && !hasDirectUserCredential
    ) {
      openSharedCredentialAssignmentPicker(tool, user, activeCompanyCredentials);
      return;
    }

    setAssignmentSavingKey(`${toolId}:${userId}`);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.upsertCredential(toolId, {
        scope: 'user',
        user_id: userId,
        is_active: !currentlyAssigned,
      });
      await refreshToolCredentialCache(toolId);
      setNotice(`${tool.name} access ${currentlyAssigned ? 'removed from' : 'granted to'} ${user.name || user.email}.`);
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to update tool access.');
    } finally {
      setAssignmentSavingKey('');
    }
  };

  const assignmentColumns = useMemo(() => accessMatrixTools, [accessMatrixTools]);
  const assignmentColumnKey = useMemo(
    () => assignmentColumns.map((tool) => `${tool.id}`).join('|'),
    [assignmentColumns],
  );
  const assignmentPageCount = Math.max(Math.ceil(sortedUsers.length / ASSIGNMENT_USER_PAGE_SIZE), 1);
  const normalizedAssignmentUserPage = Math.min(assignmentUserPage, assignmentPageCount - 1);
  const assignmentPageStart = normalizedAssignmentUserPage * ASSIGNMENT_USER_PAGE_SIZE;
  const assignmentPageEnd = Math.min(assignmentPageStart + ASSIGNMENT_USER_PAGE_SIZE, sortedUsers.length);
  const assignmentVisibleUsers = useMemo(
    () => sortedUsers.slice(assignmentPageStart, assignmentPageEnd),
    [assignmentPageEnd, assignmentPageStart, sortedUsers],
  );
  const assignmentColumnMetaById = useMemo(() => {
    return assignmentColumns.reduce((accumulator, tool) => {
      const directory = credentialDirectory[tool.id] || { company: null, companyList: [] };
      const companyList = directory.companyList || [];
      const normalizedToolSlug = normalizeToolSlug(tool?.slug);
      const supportsSharedAssignments = supportsSharedCompanyCredentialAssignments(normalizedToolSlug);
      const readyCredentialCount = companyList.filter((summary) => hasActiveUsableCredentialSummary(summary, tool)).length;
      const companyReady = readyCredentialCount > 0;
      const labels = supportsSharedAssignments ? getSharedCredentialLabels(tool) : null;
      accumulator[tool.id] = {
        companyReady,
        readyCredentialCount,
        supportsSharedAssignments,
        label: companyReady
          ? supportsSharedAssignments
            ? `${readyCredentialCount} ${labels.singular}${readyCredentialCount === 1 ? '' : 's'} ready`
            : 'Company ready'
          : supportsSharedAssignments
            ? `Needs ${labels.singular}`
            : 'Needs credential',
      };
      return accumulator;
    }, {});
  }, [assignmentColumns, credentialDirectory]);

  useEffect(() => {
    setAssignmentUserPage(0);
  }, [activeView, assignmentColumnKey, sortedUsers.length]);

  const handleEditToolChange = (toolId) => {
    setEditToolId(toolId);
    setError('');
    setNotice('');
    const tool = tools.find((item) => `${item.id}` === `${toolId}`);
    if (!tool) {
      setToolForm(EMPTY_TOOL_FORM);
      return;
    }
    const autoLogin = tool.autoLogin || {};
    setToolForm({
      name: tool.name || '',
      category: tool.category || 'General',
      website_url: tool.websiteUrl || '',
      login_url: tool.loginUrl || '',
      icon: tool.icon || 'Globe',
      launch_mode: tool.launchMode || 'manual_credential',
      auto_login_action_url: autoLogin.actionUrl || '',
      auto_login_method: autoLogin.method || 'POST',
      auto_login_username_field: autoLogin.usernameField || 'email',
      auto_login_password_field: autoLogin.passwordField || 'password',
      description: tool.description || '',
    });
  };

  const selectMailboxEntry = (toolId, entry) => {
    const normalizedToolId = `${toolId || ''}`.trim();
    if (!normalizedToolId || !entry) {
      setMailboxForm({ ...EMPTY_MAILBOX_FORM, toolId: normalizedToolId });
      setMailboxMeta(EMPTY_MAILBOX_META);
      return;
    }

    setMailboxForm({
      toolId: normalizedToolId,
      mailbox_id: `${entry.id || ''}`,
      email_address: entry.email_address || '',
      app_password: '',
      otp_sender_filter: entry.otp_sender_filter || '',
      otp_subject_pattern: entry.otp_subject_pattern || '',
      otp_regex: entry.otp_regex || EMPTY_MAILBOX_FORM.otp_regex,
      auth_link_host: entry.auth_link_host || '',
      auth_link_pattern: entry.auth_link_pattern || '',
    });
    setMailboxMeta({
      exists: true,
      appPasswordSet: !!entry.app_password_set,
    });
  };

  const startNewMailboxEntry = (toolId) => {
    const normalizedToolId = `${toolId || mailboxForm.toolId || ''}`.trim();
    setMailboxForm({
      ...EMPTY_MAILBOX_FORM,
      toolId: normalizedToolId,
    });
    setMailboxMeta(EMPTY_MAILBOX_META);
  };

  const loadMailboxConfig = async (toolId, preferredMailboxId = '') => {
    const normalizedToolId = `${toolId || ''}`.trim();
    if (!normalizedToolId) {
      setMailboxForm(EMPTY_MAILBOX_FORM);
      setMailboxMeta(EMPTY_MAILBOX_META);
      setMailboxEntries([]);
      return;
    }

    setMailboxBusy(true);
    setError('');
    try {
      const response = await itToolsAPI.listMailboxConfigs(normalizedToolId);
      const nextEntries = Array.isArray(response?.mailboxes) ? response.mailboxes : [];
      setMailboxEntries(nextEntries);
      if (!nextEntries.length) {
        startNewMailboxEntry(normalizedToolId);
        return;
      }

      const normalizedPreferredMailbox = `${preferredMailboxId || ''}`.trim().toLowerCase();
      const preferredEntry = nextEntries.find((entry) => {
        const entryId = `${entry.id || ''}`.trim().toLowerCase();
        const entryEmail = `${entry.email_address || ''}`.trim().toLowerCase();
        return entryId === normalizedPreferredMailbox || entryEmail === normalizedPreferredMailbox;
      })
        || nextEntries[0];
      selectMailboxEntry(normalizedToolId, preferredEntry);
    } catch (err) {
      if (err?.response?.status === 404) {
        setMailboxEntries([]);
        startNewMailboxEntry(normalizedToolId);
        return;
      }
      setError(err?.response?.data?.detail || 'Unable to load OTP mailbox settings.');
    } finally {
      setMailboxBusy(false);
    }
  };

  const handleSaveTool = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (editToolId) {
        await itToolsAPI.updateTool(editToolId, toolForm);
        setNotice('Tool setup updated.');
      } else {
        await itToolsAPI.createTool(toolForm);
        setNotice('Tool added to IT Profile.');
      }
      setToolForm(EMPTY_TOOL_FORM);
      setEditToolId('');
      await loadTools();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save tool.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTool = async () => {
    if (!editToolId) return;
    const toolName = toolForm.name || 'this tool';
    const confirmed = window.confirm(`Delete ${toolName} from the Tool Hub?`);
    if (!confirmed) return;

    setSaving(true);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.deleteTool(editToolId);
      setToolForm(EMPTY_TOOL_FORM);
      setEditToolId('');
      setLaunchResult(null);
      setSelectedTool(null);
      setNotice('Tool deleted from IT Profile.');
      await loadTools();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to delete tool.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCredential = async (summary = null) => {
    const toolId = summary?.toolId || credentialForm.toolId || selectedTool?.id;
    const credentialId = Number(summary?.id || credentialForm.credential_id || 0);
    if (!toolId || !credentialId) {
      return;
    }

    const targetTool = tools.find((tool) => `${tool.id}` === `${toolId}`) || null;
    const credentialLabel = summary?.loginIdentifierPreview
      || selectedSharedCredentialSummary?.loginIdentifierPreview
      || credentialForm.login_identifier
      || `credential #${credentialId}`;
    const confirmed = window.confirm(
      `Delete ${credentialLabel} from ${targetTool?.name || 'this tool'}? This will also remove any users currently linked to it.`
    );
    if (!confirmed) {
      return;
    }

    setSaving(true);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.deleteCredential(toolId, credentialId);
      if (Number(credentialForm.credential_id || 0) === credentialId) {
        setCredentialForm({
          ...EMPTY_CREDENTIAL_FORM,
          toolId: `${toolId}`,
          scope: credentialForm.scope || 'company',
          login_method: getDefaultCredentialLoginMethod(targetTool),
        });
      }
      setNotice(`Credential deleted from ${targetTool?.name || 'the tool library'}.`);
      await loadTools();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to delete credential.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCredential = async (event) => {
    event.preventDefault();
    const toolId = credentialForm.toolId || selectedTool?.id;
    if (!toolId) {
      setError('Choose a tool before saving credentials.');
      return;
    }
    const targetTool = tools.find((tool) => `${tool.id}` === `${toolId}`) || null;
    const targetToolSlug = normalizeToolSlug(targetTool?.slug);
    const supportsBackupCodes = targetToolSlug === 'flow';
    const selectedLoginMethod = credentialForm.login_method || getDefaultCredentialLoginMethod(targetToolSlug);
    const supportsTotpSecret = toolSupportsAuthenticatorSeed(targetToolSlug, selectedLoginMethod);
    const passwordOptionalCredential = toolSupportsPasswordOptionalCredential(targetToolSlug)
      || (toolSupportsCredentialLoginMethodSelection(targetToolSlug) && selectedLoginMethod === 'google');
    const shouldHidePasswordField = toolSupportsPasswordOptionalCredential(targetToolSlug);
    const backupCodesValue = supportsBackupCodes
      ? (credentialForm.backup_codes.trim() || undefined)
      : undefined;
    const totpSecretValue = supportsTotpSecret
      ? (credentialForm.totp_secret.trim() || undefined)
      : undefined;
    const credentialIdValue = credentialForm.credential_id
      ? Number(credentialForm.credential_id)
      : undefined;
    const loginIdentifierValue = credentialForm.login_identifier.trim() || undefined;
    const passwordValue = shouldHidePasswordField
      ? undefined
      : (credentialForm.password || undefined);
    const assignedUserIdsValue = supportsSharedCompanyCredentialAssignments(targetToolSlug) && credentialForm.scope === 'company'
      ? [...new Set((credentialForm.assigned_user_ids || [])
        .map((value) => Number(value))
        .filter(Boolean))]
      : undefined;
    if (
      supportsSharedCompanyCredentialAssignments(targetToolSlug)
      && credentialForm.scope === 'company'
      && !credentialIdValue
      && (!loginIdentifierValue || (!passwordValue && !passwordOptionalCredential))
    ) {
      setError(
        passwordOptionalCredential
          ? `Enter the ${targetTool?.name || 'tool'} sign-in email before saving a new shared login.`
          : `Enter the ${targetTool?.name || 'tool'} username/email and password before saving a new shared login.`,
      );
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (credentialForm.scope === 'user') {
        const selectedUserIds = [...new Set((credentialForm.user_ids || [])
          .map((value) => Number(value))
          .filter(Boolean))];

        if (!selectedUserIds.length) {
          setError('Choose at least one user before saving credentials.');
          return;
        }

        const firstUserId = selectedUserIds[0];
        const remainingUserIds = selectedUserIds.slice(1);
        const firstResult = await itToolsAPI.upsertCredential(toolId, {
          scope: 'user',
          user_id: firstUserId,
          login_method: selectedLoginMethod,
          login_identifier: loginIdentifierValue,
          password: passwordValue,
          backup_codes: backupCodesValue,
          totp_secret: totpSecretValue,
          notes: credentialForm.notes,
        });
        const linkedCredentialId = Number(firstResult?.credential?.linkedCredentialId || 0);
        const followUpPayload = (userId) => (
          linkedCredentialId
            ? {
              scope: 'user',
              user_id: userId,
              linked_credential_id: linkedCredentialId,
              login_method: selectedLoginMethod,
              is_active: true,
            }
            : {
              scope: 'user',
              user_id: userId,
              login_method: selectedLoginMethod,
              login_identifier: loginIdentifierValue,
              password: passwordValue,
              backup_codes: backupCodesValue,
              totp_secret: totpSecretValue,
              notes: credentialForm.notes,
            }
        );

        const results = [
          { status: 'fulfilled', value: firstResult },
          ...await Promise.allSettled(
            remainingUserIds.map((userId) => itToolsAPI.upsertCredential(toolId, followUpPayload(userId)))
          ),
        ];

        const failedResults = results.filter((result) => result.status === 'rejected');
        const successCount = results.length - failedResults.length;
        const saveNotice = linkedCredentialId
          ? `Credential saved for ${successCount} user${successCount === 1 ? '' : 's'} and added to the company library for reuse.`
          : `Credential saved for ${successCount} user${successCount === 1 ? '' : 's'}.`;

        if (!successCount) {
          throw failedResults[0]?.reason;
        }

        if (failedResults.length) {
          const firstFailure = failedResults[0]?.reason;
          setError(firstFailure?.response?.data?.detail || 'Some user assignments could not be saved.');
          setNotice(saveNotice);
        } else {
        setCredentialForm({
          ...EMPTY_CREDENTIAL_FORM,
          toolId: `${toolId}`,
          scope: 'user',
          login_method: getDefaultCredentialLoginMethod(targetTool),
        });
          setNotice(saveNotice);
        }
      } else {
        await itToolsAPI.upsertCredential(toolId, {
          credential_id: credentialIdValue,
          scope: credentialForm.scope,
          user_id: null,
          login_method: selectedLoginMethod,
          login_identifier: loginIdentifierValue,
          password: passwordValue,
          backup_codes: backupCodesValue,
          totp_secret: totpSecretValue,
          notes: credentialForm.notes,
          assigned_user_ids: assignedUserIdsValue,
          create_new: supportsSharedCompanyCredentialAssignments(targetToolSlug) && !credentialIdValue,
        });
        setCredentialForm({
          ...EMPTY_CREDENTIAL_FORM,
          toolId: `${toolId}`,
          login_method: getDefaultCredentialLoginMethod(targetTool),
        });
        setNotice(
          supportsSharedCompanyCredentialAssignments(targetToolSlug)
            ? getSharedCredentialLabels(targetTool || targetToolSlug).saveNotice
            : 'Company credential saved securely. It is now available at company level, and you can revoke or restore individual users from the matrix if needed.',
        );
      }
      await loadTools();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save credential.');
    } finally {
      setSaving(false);
    }
  };

  const handleMailboxToolChange = (toolId) => {
    setMailboxForm({
      ...EMPTY_MAILBOX_FORM,
      toolId: `${toolId || ''}`,
    });
    setMailboxMeta(EMPTY_MAILBOX_META);
    setMailboxEntries([]);
    void loadMailboxConfig(toolId);
  };

  const handleSaveMailbox = async (event) => {
    event.preventDefault();
    const toolId = `${mailboxForm.toolId || ''}`.trim();
    if (!toolId) {
      setError('Choose a tool before saving OTP mailbox settings.');
      return;
    }

    setMailboxBusy(true);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.upsertMailboxConfig(toolId, {
        mailbox_id: mailboxForm.mailbox_id || undefined,
        email_address: mailboxForm.email_address,
        app_password: mailboxForm.app_password || undefined,
        otp_sender_filter: mailboxForm.otp_sender_filter || undefined,
        otp_subject_pattern: mailboxForm.otp_subject_pattern || undefined,
        otp_regex: mailboxForm.otp_regex || EMPTY_MAILBOX_FORM.otp_regex,
        auth_link_host: mailboxForm.auth_link_host || undefined,
        auth_link_pattern: mailboxForm.auth_link_pattern || undefined,
      });
      await loadMailboxConfig(toolId, mailboxForm.mailbox_id || mailboxForm.email_address);
      setNotice('Verification mailbox settings saved.');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save verification mailbox settings.');
    } finally {
      setMailboxBusy(false);
    }
  };

  const handleTestMailbox = async () => {
    const toolId = `${mailboxForm.toolId || ''}`.trim();
    const mailboxId = `${mailboxForm.mailbox_id || ''}`.trim();
    if (!toolId) {
      setError('Choose a tool before testing the OTP mailbox.');
      return;
    }
    if (!mailboxId) {
      setError('Choose a saved mailbox before testing the OTP mailbox.');
      return;
    }

    setMailboxBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await itToolsAPI.testMailboxConfig(toolId, mailboxId);
      if (response.success) {
        setNotice(response.message || 'Verification mailbox connected successfully.');
      } else {
        setError(response.message || 'Verification mailbox test failed.');
      }
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to test verification mailbox.');
    } finally {
      setMailboxBusy(false);
    }
  };

  const handleDeleteMailbox = async () => {
    const toolId = `${mailboxForm.toolId || ''}`.trim();
    const mailboxId = `${mailboxForm.mailbox_id || ''}`.trim();
    if (!toolId) {
      setError('Choose a tool before deleting the OTP mailbox.');
      return;
    }
    if (!mailboxId) {
      setError('Choose a saved mailbox before deleting the OTP mailbox.');
      return;
    }

    const tool = tools.find((item) => `${item.id}` === toolId);
    const confirmed = window.confirm(`Remove verification mailbox settings for ${tool?.name || 'this tool'}?`);
    if (!confirmed) return;

    setMailboxBusy(true);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.deleteMailboxConfig(toolId, mailboxId);
      await loadMailboxConfig(toolId);
      setNotice('Verification mailbox settings removed.');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to delete verification mailbox settings.');
    } finally {
      setMailboxBusy(false);
    }
  };

  const handleLaunchTool = async (tool) => {
    const nextToolId = `${tool?.id || ''}`;
    if (!nextToolId || launchingToolId === nextToolId) {
      return;
    }

    setLaunchingToolId(nextToolId);
    setSelectedTool(tool);
    setLaunchResult(null);
    setError('');
    try {
      const response = await itToolsAPI.launchTool(tool.id);
      setLaunchResult(response);
      let launchUrl = response.launchUrl;
      const responseToolSlug = normalizeToolSlug(response.tool?.slug || tool?.slug || tool?.name);
      if (responseToolSlug === 'elevenlabs' && (!response.extensionAutoFill || !response.extensionTicket)) {
        throw new Error('ElevenLabs launch did not return an extension ticket. Restart the backend, refresh the dashboard, then launch ElevenLabs again.');
      }
      if (response.extensionAutoFill && response.extensionTicket && response.tool?.slug) {
        const normalizedToolSlug = normalizeToolSlug(response.tool.slug);
        const launchLoginMethod = `${response.credential?.loginMethod || ''}`.trim().toLowerCase();
        const launchDetail = {
          toolSlug: normalizedToolSlug,
          toolName: response.tool.name,
          ticket: response.extensionTicket,
          expiresAt: Number(response.extensionTicketExpiresAt || 0) * 1000,
          usageTrackingTicket: response.usageTrackingTicket || '',
          usageTrackingTicketExpiresAt: Number(response.usageTrackingTicketExpiresAt || 0) * 1000,
          launchUrl: response.launchUrl,
        };
        window.dispatchEvent(new CustomEvent(EXTENSION_LAUNCH_EVENT, {
          detail: launchDetail,
        }));
        window.postMessage({
          source: 'rmw-tool-hub-page',
          type: EXTENSION_LAUNCH_MESSAGE_TYPE,
          ...launchDetail,
        }, window.location.origin);
        const launchStored = await waitForExtensionLaunchStored(normalizedToolSlug);
        if (!launchStored.ok) {
          throw new Error(launchStored.error || 'Extension launch bridge did not respond.');
        }
        launchUrl = resolveExtensionLaunchUrl(
          response.launchUrl,
          response.extensionTicket,
          normalizedToolSlug,
          response.usageTrackingTicket || ''
        );
        if (
          ['flow', 'chatgpt'].includes(normalizedToolSlug)
          || shouldLaunchExtensionToolInIncognito(normalizedToolSlug, launchLoginMethod)
        ) {
          const isolatedResult = await openToolInIncognitoWindow({
            toolSlug: normalizedToolSlug,
            toolName: response.tool.name,
            launchUrl,
            ticket: response.extensionTicket,
            usageTrackingTicket: response.usageTrackingTicket || '',
          });
          if (!isolatedResult.ok) {
            throw new Error(isolatedResult.error || `Unable to open ${response.tool.name || response.tool.slug} in an incognito window.`);
          }
          return;
        }
      }
      if (launchUrl) {
        window.open(launchUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || 'Unable to launch tool.');
    } finally {
      setLaunchingToolId('');
    }
  };

  const IconComponent = (name) => Icons[name] || Icons.Globe;

  if (toolsAccess.loading || !toolsAccess.checked) {
    return (
      <div ref={containerRef} className="app-container tools-access-shell">
        <section className="tools-access-state tools-access-state--loading" aria-busy="true" aria-live="polite">
          <div className="tools-access-illustration tools-access-illustration--loading" aria-hidden="true">
            <div className="tools-access-spinner" />
          </div>
          <div className="tools-access-copy">
            <h2 className="tools-access-title">Checking Workplace access</h2>
            <p className="tools-access-text">Loading your active task status before opening the Workplace tools.</p>
          </div>
        </section>
      </div>
    );
  }

  if (!toolsAccess.canAccess) {
    if (toolsAccess.isError) {
      return (
        <div ref={containerRef} className="app-container tools-access-shell">
          <section className="tools-access-state tools-access-state--error" aria-live="polite">
            <div className="tools-access-illustration" aria-hidden="true">
              <Icons.AlertCircle />
            </div>
            <div className="tools-access-copy">
              <h2 className="tools-access-title">Unable to Load Workplace Tools</h2>
              <p className="tools-access-text">
                {toolsAccess.message || WORKPLACE_TOOLS_ACCESS_CHECK_ERROR}
              </p>
              <button
                type="button"
                className="tools-access-retry-btn"
                onClick={() => setToolsAccessRetryCount((n) => n + 1)}
              >
                Try Again
              </button>
            </div>
          </section>
        </div>
      );
    }

    return (
      <div ref={containerRef} className="app-container tools-access-shell">
        <section className="tools-access-state" aria-live="polite">
          <div className="tools-access-illustration" aria-hidden="true">
            <Icons.Shield />
          </div>
          <div className="tools-access-copy">
            <h2 className="tools-access-title">{WORKPLACE_TOOLS_EMPTY_STATE_TITLE}</h2>
            <p className="tools-access-text">{WORKPLACE_TOOLS_EMPTY_STATE_COPY}</p>
            <p className="tools-access-subtext">{WORKPLACE_TOOLS_EMPTY_STATE_FOLLOWUP}</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="app-container">
      <header ref={headerRef} className="app-header is-visible">
        <div className="header-wrapper">
          <div>
            <h1 className="app-title">RMW Tools Hub</h1>
          </div>

          <div className="search-wrapper">
            <div className="search-icon">
              <Icons.Search />
            </div>
            <input
              type="text"
              placeholder="Search tools..."
              className="search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
        </div>
      </header>

      <main className="app-main">
        {error && <div className="tool-alert error">{error}</div>}
        {notice && <div className="tool-alert success">{notice}</div>}

        {activeView === 'tools' && isAdmin && (
          <div className="it-tool-submenu" role="tablist" aria-label="Tool admin sections">
            {TOOL_ADMIN_SECTIONS.map((section) => (
              <button
                key={section.key}
                type="button"
                role="tab"
                aria-selected={toolAdminSection === section.key}
                className={`it-tool-submenu-btn ${toolAdminSection === section.key ? 'is-active' : ''}`}
                onClick={() => setToolAdminSection(section.key)}
              >
                {section.label}
              </button>
            ))}
          </div>
        )}

        {activeView === 'tools' && isAdmin && toolAdminSection === 'add' && (
          <section className="it-admin-grid">
            <form className="it-admin-card" onSubmit={handleSaveTool} autoComplete="off">
              <div className="it-admin-card-header">
                <div>
                  <h2>{editToolId ? 'Edit Tool' : 'Add Tool'}</h2>
                </div>
                <span>{editToolId ? 'Update setup' : 'Admin only'}</span>
              </div>
              <select value={editToolId} onChange={(e) => handleEditToolChange(e.target.value)}>
                <option value="">Create new tool</option>
                {tools.map((tool) => (
                  <option key={tool.id} value={tool.id}>Edit {tool.name}</option>
                ))}
              </select>
              <div className="it-form-grid">
                <input value={toolForm.name} onChange={(e) => updateToolFormField(setToolForm, setError, 'name', e.target.value)} placeholder="Tool name" autoComplete="off" required />
                <input value={toolForm.category} onChange={(e) => updateToolFormField(setToolForm, setError, 'category', e.target.value)} placeholder="Category" autoComplete="off" />
                <input value={toolForm.website_url} onChange={(e) => updateToolFormField(setToolForm, setError, 'website_url', e.target.value)} placeholder="Website URL" autoComplete="url" required />
                <input value={toolForm.login_url} onChange={(e) => updateToolFormField(setToolForm, setError, 'login_url', e.target.value)} placeholder="Login URL optional" autoComplete="url" />
                <select value={toolForm.icon} onChange={(e) => updateToolFormField(setToolForm, setError, 'icon', e.target.value)}>
                  {Object.keys(Icons).filter((key) => key !== 'Search').map((icon) => (
                    <option key={icon} value={icon}>{icon}</option>
                  ))}
                </select>
                <select value={toolForm.launch_mode} onChange={(e) => updateToolFormField(setToolForm, setError, 'launch_mode', e.target.value)}>
                  <option value="manual_credential">Manual credential</option>
                  <option value="external_link">External link</option>
                  <option value="sso">SSO</option>
                  <option value="api_proxy">API proxy</option>
                  <option value="extension_autofill">Extension auto-fill (Behance, Canva, Claude, ChatGPT/OpenAI, Enhancor, Envato, ElevenLabs, Freepik, Genspark, Grammarly, Higgsfield, HeyGen, Kling AI, Flow, Pinterest)</option>
                  <option value="automation">Auto-login form submit</option>
                </select>
              </div>
              {toolForm.launch_mode === 'extension_autofill' && (
                <p className="it-card-copy">
                  The current browser extension build supports Behance, Canva, Claude, ChatGPT/OpenAI, Enhancor, Envato, ElevenLabs, Freepik, Genspark, Grammarly, Higgsfield, HeyGen, Kling AI, Flow, and Pinterest
                  extension scaffold. For other tools, use Manual credential or Auto-login form submit.
                </p>
              )}
              {toolForm.launch_mode === 'automation' && (
                <div className="it-form-grid auto-login-grid">
                  <input
                    value={toolForm.auto_login_action_url}
                    onChange={(e) => updateToolFormField(setToolForm, setError, 'auto_login_action_url', e.target.value)}
                    placeholder="Login submit URL optional"
                    autoComplete="url"
                  />
                  <select
                    value={toolForm.auto_login_method}
                    onChange={(e) => updateToolFormField(setToolForm, setError, 'auto_login_method', e.target.value)}
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                  </select>
                  <input
                    value={toolForm.auto_login_username_field}
                    onChange={(e) => updateToolFormField(setToolForm, setError, 'auto_login_username_field', e.target.value)}
                    placeholder="Username field name"
                    autoComplete="off"
                  />
                  <input
                    value={toolForm.auto_login_password_field}
                    onChange={(e) => updateToolFormField(setToolForm, setError, 'auto_login_password_field', e.target.value)}
                    placeholder="Password field name"
                    autoComplete="off"
                  />
                </div>
              )}
              <textarea value={toolForm.description} onChange={(e) => updateToolFormField(setToolForm, setError, 'description', e.target.value)} placeholder="Short description" autoComplete="off" />
              <div className="it-admin-actions">
                <button className="it-primary-btn" type="submit" disabled={saving}>{saving ? 'Saving...' : editToolId ? 'Update Tool' : 'Add Tool'}</button>
                {editToolId && (
                  <button className="it-danger-btn" type="button" onClick={handleDeleteTool} disabled={saving}>
                    Delete Tool
                  </button>
                )}
              </div>
            </form>

            <form className="it-admin-card" onSubmit={handleSaveCredential} autoComplete="off" data-tool-credential-form="true">
              <div className="it-admin-card-header">
                <div>
                  <h2>Add Credential</h2>
                  <p className="it-card-copy">Store the assigned company login securely for extension autofill, magic-link flows, and manual launch support.</p>
                </div>
                <span>Encrypted</span>
              </div>
              <div className="it-form-grid">
                <select
                  value={credentialForm.toolId || selectedTool?.id || ''}
                  onChange={(e) => setCredentialForm({
                    ...EMPTY_CREDENTIAL_FORM,
                    toolId: e.target.value,
                    scope: credentialForm.scope,
                    login_method: getDefaultCredentialLoginMethod(tools.find((tool) => `${tool.id}` === `${e.target.value}`) || ''),
                  })}
                  required
                >
                  <option value="">Choose tool</option>
                  {tools.map((tool) => (
                    <option key={tool.id} value={tool.id}>{tool.name}</option>
                  ))}
                </select>
                <select
                  value={credentialForm.scope}
                  onChange={(e) => setCredentialForm({
                    ...EMPTY_CREDENTIAL_FORM,
                    toolId: credentialForm.toolId || selectedTool?.id || '',
                    scope: e.target.value,
                    login_method: credentialForm.login_method || getDefaultCredentialLoginMethod(activeCredentialToolSlug),
                    user_ids: e.target.value === 'user' ? credentialForm.user_ids : [],
                  })}
                >
                  <option value="company">Company credential</option>
                  <option value="user">Specific user</option>
                </select>
                {supportsSharedCompanyCredentialAssignments(activeCredentialToolSlug) && credentialForm.scope === 'company' && (
                  <div className="it-span-2 it-chatgpt-credential-library">
                    <div className="it-user-picker-header">
                      <span>{sharedCredentialLabels.listTitle}</span>
                      <span>{activeSharedCompanyCredentials.length} saved</span>
                    </div>
                    <p className="it-card-copy">
                      Save multiple {activeCredentialTool?.name || 'tool'} logins here, then assign each saved login to the right users.
                    </p>
                    <div className="it-chatgpt-credential-list">
                      {activeSharedCompanyCredentials.length ? activeSharedCompanyCredentials.map((summary) => {
                        const isSelected = Number(summary.id) === Number(credentialForm.credential_id || 0);
                        const assignedUsers = summary.assignedUsers || [];
                        return (
                          <div
                            key={summary.id}
                            className={`it-chatgpt-credential-card ${isSelected ? 'is-selected' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => loadSharedCredentialIntoForm(summary)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                loadSharedCredentialIntoForm(summary);
                              }
                            }}
                          >
                            <div className="it-chatgpt-credential-card-top">
                              <div className="it-chatgpt-credential-card-heading">
                                <strong>{summary.loginIdentifierPreview || `Saved login #${summary.id}`}</strong>
                                <span>{assignedUsers.length} user{assignedUsers.length === 1 ? '' : 's'}</span>
                              </div>
                              <button
                                type="button"
                                className="it-chatgpt-credential-delete"
                                aria-label={`Delete ${summary.loginIdentifierPreview || `credential ${summary.id}`}`}
                                title="Delete credential"
                                onKeyDown={(event) => {
                                  event.stopPropagation();
                                }}
                                onKeyUp={(event) => {
                                  event.stopPropagation();
                                }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleDeleteCredential(summary);
                                }}
                                disabled={saving}
                              >
                                ×
                              </button>
                            </div>
                            <small>{summary.notes || 'No internal note saved for this login yet.'}</small>
                            <div className="it-chatgpt-assigned-users">
                              {assignedUsers.length ? assignedUsers.map((assignedUser) => (
                                <span key={`${summary.id}:${assignedUser.id}`} className="it-chatgpt-user-pill">
                                  {assignedUser.name || assignedUser.email}
                                </span>
                              )) : (
                                <span className="it-chatgpt-user-pill is-empty">No users assigned</span>
                              )}
                            </div>
                          </div>
                        );
                      }) : (
                        <div className="it-chatgpt-empty-state">
                          {sharedCredentialLabels.emptyState}
                        </div>
                      )}
                    </div>
                    {selectedSharedCredentialSummary && (
                      <p className="it-mailbox-summary">
                        Editing saved login for {selectedSharedCredentialSummary.loginIdentifierPreview || `credential #${selectedSharedCredentialSummary.id}`}.
                        Leave password and authenticator seed blank if they have not changed.
                        {' '}
                        <button
                          type="button"
                          className="it-inline-action-btn"
                          onClick={resetSharedCredentialSelection}
                        >
                          Create another saved login
                        </button>
                      </p>
                    )}
                  </div>
                )}
                {supportsSharedCompanyCredentialAssignments(activeCredentialToolSlug) && credentialForm.scope === 'company' && (
                  <div className="it-span-2 it-user-picker">
                    <div className="it-user-picker-header">
                      <span>{sharedCredentialLabels.assignTitle}</span>
                      <span>{credentialForm.assigned_user_ids.length} selected</span>
                    </div>
                    <div className="it-user-picker-actions">
                      <button
                        type="button"
                        className="it-link-btn"
                        onClick={() => setCredentialForm((current) => ({
                          ...current,
                          assigned_user_ids: sortedUsers.map((user) => `${user.id}`),
                        }))}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="it-link-btn"
                        onClick={() => setCredentialForm((current) => ({
                          ...current,
                          assigned_user_ids: [],
                        }))}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="it-user-checklist" role="group" aria-label={`Select users for this ${activeCredentialTool?.name || 'tool'} credential`}>
                      {sortedUsers.map((user) => {
                        const userId = `${user.id}`;
                        const checked = credentialForm.assigned_user_ids.includes(userId);
                        return (
                          <label key={`shared-company-${activeCredentialToolSlug}-${user.id}`} className={`it-user-checklist-item ${checked ? 'is-selected' : ''}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => setCredentialForm((current) => ({
                                ...current,
                                assigned_user_ids: e.target.checked
                                  ? [...current.assigned_user_ids, userId]
                                  : current.assigned_user_ids.filter((value) => value !== userId),
                              }))}
                            />
                            <span className="it-user-checklist-copy">
                              <strong>{user.name || user.email}</strong>
                              <small>{user.email}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                {credentialForm.scope === 'user' && (
                  <div className="it-span-2 it-user-picker">
                    <div className="it-user-picker-header">
                      <span>Assign to users</span>
                      <span>{credentialForm.user_ids.length} selected</span>
                    </div>
                    <div className="it-user-picker-actions">
                      <button
                        type="button"
                        className="it-link-btn"
                        onClick={() => setCredentialForm((current) => ({
                          ...current,
                          user_ids: sortedUsers.map((user) => `${user.id}`),
                        }))}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="it-link-btn"
                        onClick={() => setCredentialForm((current) => ({
                          ...current,
                          user_ids: [],
                        }))}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="it-user-checklist" role="group" aria-label="Select users for this credential">
                      {sortedUsers.map((user) => {
                        const userId = `${user.id}`;
                        const checked = credentialForm.user_ids.includes(userId);
                        return (
                          <label key={user.id} className={`it-user-checklist-item ${checked ? 'is-selected' : ''}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => setCredentialForm((current) => ({
                                ...current,
                                user_ids: e.target.checked
                                  ? [...current.user_ids, userId]
                                  : current.user_ids.filter((value) => value !== userId),
                              }))}
                            />
                            <span className="it-user-checklist-copy">
                              <strong>{user.name || user.email}</strong>
                              <small>{user.email}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <small>Specific-user saves are also stored in the company credential library, but only the selected users will be linked to this login.</small>
                  </div>
                )}
                {toolSupportsCredentialLoginMethodSelection(activeCredentialToolSlug) && (
                  <select
                    value={activeCredentialLoginMethod}
                    onChange={(e) => setCredentialForm({
                      ...credentialForm,
                      login_method: e.target.value,
                    })}
                  >
                    <option value="email_password">Continue with email / password</option>
                    <option value="google">Continue with Google</option>
                  </select>
                )}
                <input
                  value={credentialForm.login_identifier}
                  onChange={(e) => setCredentialForm({ ...credentialForm, login_identifier: e.target.value })}
                  placeholder={
                    activeCredentialPasswordOptional
                      ? 'Sign-in email'
                      : toolSupportsCredentialLoginMethodSelection(activeCredentialToolSlug)
                        ? 'Email'
                        : 'Username / email'
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
                {!activeCredentialShouldHidePasswordField && (
                  <input
                    type="password"
                    value={credentialForm.password}
                    onChange={(e) => setCredentialForm({ ...credentialForm, password: e.target.value })}
                    placeholder={
                      activeCredentialLoginMethod === 'google'
                        ? (credentialForm.credential_id ? 'Enter a new Google password only if this one changed' : 'Google password optional')
                        : (credentialForm.credential_id ? 'Enter a new password only if this one changed' : 'Password')
                    }
                    autoComplete="new-password"
                  />
                )}
                {activeCredentialPasswordOptional && (
                  <div className="it-span-2 it-mailbox-summary">
                    {activeCredentialToolSlug === 'claude'
                      ? 'Claude uses email-link sign-in. Save only the email here, then configure the Verification Mailbox below so the extension can fetch the secure sign-in link from Gmail.'
                      : activeCredentialToolSlug === 'behance'
                        ? 'This Behance credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                      : activeCredentialToolSlug === 'chatgpt'
                        ? 'This ChatGPT credential supports Continue with Google or email / password. Use Google for Google-created ChatGPT accounts. If the Google account is already listed, the extension will select it. If not, it will choose Add another account and continue with the saved Google email and password when Google asks for them.'
                      : activeCredentialToolSlug === 'enhancor'
                        ? 'This Enhancor credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                      : activeCredentialToolSlug === 'elevenlabs'
                        ? 'This ElevenLabs credential can use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                      : activeCredentialToolSlug === 'freepik'
                        ? 'This Freepik credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                      : activeCredentialToolSlug === 'heygen'
                        ? 'This HeyGen credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                        : activeCredentialToolSlug === 'genspark'
                          ? 'This Genspark credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                        : activeCredentialToolSlug === 'pinterest'
                          ? 'This Pinterest credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                        : activeCredentialToolSlug === 'suno'
                          ? 'This Suno credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                        : activeCredentialToolSlug === 'epidemic-sound'
                          ? 'This Epidemic Sound credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                        : activeCredentialToolSlug === 'splice'
                          ? 'This Splice credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
                          : 'This Kling credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'}
                  </div>
                )}
                {showToolTotpSecretField && (
                  <div className="it-span-2 it-secret-support-field">
                    <label htmlFor="flow-totp-secret">{totpSecretToolLabel} authenticator seed</label>
                    <textarea
                      id="flow-totp-secret"
                      value={credentialForm.totp_secret}
                      onChange={(e) => setCredentialForm({ ...credentialForm, totp_secret: e.target.value })}
                      placeholder={credentialForm.credential_id
                        ? `Leave blank to keep the current authenticator seed\nPaste a new 32-character base32 secret or full otpauth:// URI only if it changed`
                        : `Paste the 32-character base32 secret or full otpauth:// URI\nJBSWY3DPEHPK3PXP`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <small>Optional. Stored encrypted on the backend only. The extension will request only the current 6-digit code during Google authenticator verification and never receive this seed.</small>
                  </div>
                )}
                {showFlowBackupCodesField && (
                  <div className="it-span-2 it-secret-support-field">
                    <label htmlFor="flow-backup-codes">Flow backup codes</label>
                    <textarea
                      id="flow-backup-codes"
                      value={credentialForm.backup_codes}
                      onChange={(e) => setCredentialForm({ ...credentialForm, backup_codes: e.target.value })}
                      placeholder={`Enter one 8-digit code per line\n12345678\n87654321`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <small>Optional. Paste one Google 8-digit backup code per line and the Flow extension will try them in order when backup-code sign-in is shown.</small>
                  </div>
              )}
            </div>
            <textarea value={credentialForm.notes} onChange={(e) => setCredentialForm({ ...credentialForm, notes: e.target.value })} placeholder="Internal notes optional" autoComplete="off" />
              <div className="it-admin-actions">
                <button className="it-primary-btn" type="submit" disabled={saving}>
                  {saving
                    ? 'Saving...'
                    : supportsSharedCompanyCredentialAssignments(activeCredentialToolSlug) && credentialForm.scope === 'company' && credentialForm.credential_id
                      ? sharedCredentialLabels.updateAction
                      : 'Save Credential'}
                </button>
                {credentialForm.credential_id && (
                  <button
                    className="it-danger-btn"
                    type="button"
                    onClick={handleDeleteCredential}
                    disabled={saving}
                  >
                    Delete Credential
                  </button>
                )}
              </div>
            </form>

            <form className="it-admin-card" onSubmit={handleSaveMailbox} autoComplete="off">
              <div className="it-admin-card-header">
                <div>
                  <h2>Verification Mailbox</h2>
                  <p className="it-card-copy">Manage the Gmail inboxes used for OTP codes or magic sign-in links. The extension will automatically match the mailbox email to the saved credential email for tools like ChatGPT and Claude.</p>
                </div>
                <span>{mailboxEntries.length ? `${mailboxEntries.length} saved` : 'Optional'}</span>
              </div>
              <select
                value={mailboxForm.toolId}
                onChange={(e) => handleMailboxToolChange(e.target.value)}
                disabled={mailboxBusy}
                required
              >
                <option value="">Choose tool</option>
                {tools.map((tool) => (
                  <option key={tool.id} value={tool.id}>{tool.name}</option>
                ))}
              </select>
              {!!mailboxForm.toolId && !!mailboxEntries.length && (
                <div className="it-user-picker">
                  <div className="it-user-picker-header">
                    <span>Saved mailboxes</span>
                    <span>{mailboxEntries.length} total</span>
                  </div>
                  <div className="it-user-checklist" role="group" aria-label="Saved verification mailboxes">
                    {mailboxEntries.map((entry) => {
                      const selected = `${mailboxForm.mailbox_id || ''}` === `${entry.id || ''}`;
                      return (
                        <button
                          key={`mailbox-${entry.id}`}
                          type="button"
                          className={`it-user-checklist-item ${selected ? 'is-selected' : ''}`}
                          onClick={() => selectMailboxEntry(mailboxForm.toolId, entry)}
                        >
                          <span className="it-user-checklist-copy">
                            <strong>{entry.email_address}</strong>
                            <small>{entry.app_password_set ? 'App password saved' : 'Needs app password'}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="it-user-picker-actions">
                    <button
                      type="button"
                      className="it-link-btn"
                      onClick={() => startNewMailboxEntry(mailboxForm.toolId)}
                    >
                      Add another mailbox
                    </button>
                  </div>
                </div>
              )}
              <div className="it-form-grid">
                <input
                  value={mailboxForm.email_address}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, email_address: e.target.value })}
                  placeholder="Use the same email saved in the credential, e.g. otp-inbox@gmail.com"
                  autoComplete="email"
                  required
                />
                
                <input
                  type="password"
                  value={mailboxForm.app_password}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, app_password: e.target.value })}
                  placeholder={mailboxMeta.appPasswordSet ? 'Leave blank to keep current Gmail app password' : 'Gmail app password'}
                  autoComplete="new-password"
                />
                <input
                  value={mailboxForm.otp_sender_filter}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, otp_sender_filter: e.target.value })}
                  placeholder="Sender filter optional"
                  autoComplete="off"
                />
                <input
                  value={mailboxForm.otp_subject_pattern}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, otp_subject_pattern: e.target.value })}
                  placeholder="Subject filter optional"
                  autoComplete="off"
                />
                <input
                  className="it-span-2"
                  value={mailboxForm.otp_regex}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, otp_regex: e.target.value })}
                  placeholder="OTP regex with one capture group"
                  autoComplete="off"
                />
                <input
                  value={mailboxForm.auth_link_host}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, auth_link_host: e.target.value })}
                  placeholder="Auth link host optional, e.g. claude.ai"
                  autoComplete="off"
                />
                <input
                  value={mailboxForm.auth_link_pattern}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, auth_link_pattern: e.target.value })}
                  placeholder="Auth link regex optional"
                  autoComplete="off"
                />
              </div>
              <p className="it-mailbox-summary">
                {mailboxMeta.exists
                  ? `Editing mailbox ${mailboxForm.email_address || 'entry'}${mailboxMeta.appPasswordSet ? ' with an app password on file.' : '.'}`
                  : 'Add a mailbox whose email matches the credential email you expect OTP or magic-link verification to use.'}
              </p>
              <div className="it-admin-actions">
                <button className="it-primary-btn" type="submit" disabled={mailboxBusy}>
                  {mailboxBusy ? 'Working...' : mailboxMeta.exists ? 'Update Mailbox' : 'Save Mailbox'}
                </button>
                <button
                  className="it-secondary-btn"
                  type="button"
                  onClick={handleTestMailbox}
                  disabled={mailboxBusy || !mailboxMeta.exists || !mailboxForm.toolId || !mailboxForm.mailbox_id}
                >
                  Test Connection
                </button>
                <button
                  className="it-danger-btn"
                  type="button"
                  onClick={handleDeleteMailbox}
                  disabled={mailboxBusy || !mailboxMeta.exists || !mailboxForm.toolId || !mailboxForm.mailbox_id}
                >
                  Delete Mailbox
                </button>
              </div>
            </form>
          </section>
        )}

        {activeView === 'tools' && isAdmin && toolAdminSection === 'access' && (
          <section className="it-assignment-card">
            <div className="it-admin-card-header">
              <div>
                <h2>Tool Access Matrix</h2>
                <p className="it-card-copy">
                  See which users can open each tool and use the tick marks to grant or remove access quickly.
                </p>
              </div>
              <span>{assignmentColumns.length} tools visible</span>
            </div>
            <div className="it-assignment-summary">
              <p>
                Company credentials can now be stored as a shared library for every tool, then assigned safely per user whenever a tool has multiple saved logins or explicit user-level routing.
              </p>
            </div>
            <div className="it-assignment-table-wrap">
              <table className="it-assignment-table">
                <thead>
                  <tr>
                    <th className="it-user-column">User</th>
                    {assignmentColumns.map((tool) => {
                      const columnMeta = assignmentColumnMetaById[tool.id] || {
                        companyReady: false,
                        label: 'Needs credential',
                      };
                      return (
                        <th key={tool.id} className="it-tool-column">
                          <div className="it-tool-column-copy">
                            <strong>{tool.name}</strong>
                            <small>{tool.category}</small>
                            <span className={`it-company-badge ${columnMeta.companyReady ? 'is-ready' : 'is-missing'}`}>
                              {columnMeta.label}
                            </span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {assignmentLoading ? (
                    <tr>
                      <td className="it-assignment-empty" colSpan={Math.max(assignmentColumns.length + 1, 2)}>
                        Loading tool assignments...
                      </td>
                    </tr>
                  ) : !sortedUsers.length ? (
                    <tr>
                      <td className="it-assignment-empty" colSpan={Math.max(assignmentColumns.length + 1, 2)}>
                        No active users found.
                      </td>
                    </tr>
                  ) : !assignmentColumns.length ? (
                    <tr>
                      <td className="it-assignment-empty" colSpan={2}>
                        No tools match the current filters.
                      </td>
                    </tr>
                  ) : (
                    assignmentVisibleUsers.map((user) => (
                      <tr key={user.id}>
                        <td className="it-user-cell">
                          <strong>{user.name || user.email}</strong>
                          <small>{user.email}</small>
                        </td>
                        {assignmentColumns.map((tool) => {
                          const checked = isUserAssignedToTool(tool.id, user.id);
                          const savingKey = `${tool.id}:${user.id}`;
                          const normalizedToolSlug = normalizeToolSlug(tool?.slug);
                          const assignedSharedCredential = supportsSharedCompanyCredentialAssignments(normalizedToolSlug)
                            ? getAssignedSharedCredentialSummary(tool.id, user.id)
                            : null;
                          return (
                            <td key={`${tool.id}:${user.id}`} className="it-assignment-cell">
                              <button
                                type="button"
                                className={`it-assignment-toggle ${checked ? 'is-checked' : ''}`}
                                onClick={() => handleToggleAssignment(tool, user)}
                                disabled={assignmentSavingKey === savingKey}
                                aria-pressed={checked}
                                title={supportsSharedCompanyCredentialAssignments(normalizedToolSlug)
                                  ? `${checked ? 'Change or remove' : 'Choose'} the ${tool.name} ${getSharedCredentialLabels(tool).singular} for ${user.name || user.email}`
                                  : `${checked ? 'Remove' : 'Grant'} ${tool.name} access for ${user.name || user.email}`}
                              >
                                {assignmentSavingKey === savingKey ? '...' : checked ? '✓' : ''}
                              </button>
                              {assignedSharedCredential && (
                                <div className="it-assignment-meta">
                                  <strong>{assignedSharedCredential.loginIdentifierPreview || `ID ${assignedSharedCredential.id}`}</strong>
                                  <small>ID {assignedSharedCredential.id}</small>
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {!assignmentLoading && sortedUsers.length > ASSIGNMENT_USER_PAGE_SIZE && (
              <div className="it-assignment-pager">
                <span>
                  Showing {assignmentPageStart + 1}-{assignmentPageEnd} of {sortedUsers.length} users
                </span>
                <div className="it-assignment-pager-actions">
                  <button
                    type="button"
                    onClick={() => setAssignmentUserPage((page) => Math.max(page - 1, 0))}
                    disabled={normalizedAssignmentUserPage <= 0}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setAssignmentUserPage((page) => Math.min(page + 1, assignmentPageCount - 1))}
                    disabled={normalizedAssignmentUserPage >= assignmentPageCount - 1}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {isAdmin && sharedCredentialAssignmentPicker && (
          <section className="it-picker-overlay" role="dialog" aria-modal="true" aria-label={`Choose ${sharedCredentialAssignmentPicker.tool?.name || 'tool'} credential`}>
            <div className="it-picker-card">
              <div className="it-admin-card-header">
                <div>
                  <h2>{getSharedCredentialLabels(sharedCredentialAssignmentPicker.tool).dialogTitle}</h2>
                  <p className="it-card-copy">
                    Choose which saved {sharedCredentialAssignmentPicker.tool?.name || 'tool'} login should be used by {sharedCredentialAssignmentPicker.user?.name || sharedCredentialAssignmentPicker.user?.email}.
                  </p>
                </div>
                <span>{sharedCredentialAssignmentPicker.options?.length || 0} saved</span>
              </div>
              <div className="it-chatgpt-credential-list">
                {(sharedCredentialAssignmentPicker.options || []).map((summary) => {
                  const isSelected = Number(summary.id) === Number(sharedCredentialAssignmentPicker.selectedCredentialId || 0);
                  return (
                    <button
                      key={`picker-${summary.id}`}
                      type="button"
                      className={`it-chatgpt-credential-card ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => setSharedCredentialAssignmentPicker((current) => ({
                        ...current,
                        selectedCredentialId: `${summary.id}`,
                      }))}
                    >
                      <div className="it-chatgpt-credential-card-top">
                        <strong>{summary.loginIdentifierPreview || `Saved login #${summary.id}`}</strong>
                        <span>ID {summary.id}</span>
                      </div>
                      <small>{summary.notes || 'No internal note saved for this login yet.'}</small>
                    </button>
                  );
                })}
              </div>
              <div className="it-picker-summary">
                <p>
                  Current assignment:
                  {' '}
                  {sharedCredentialAssignmentPicker.currentCredentialId
                    ? (() => {
                      const currentSummary = (sharedCredentialAssignmentPicker.options || []).find(
                        (item) => Number(item.id) === Number(sharedCredentialAssignmentPicker.currentCredentialId),
                      );
                      return currentSummary?.loginIdentifierPreview || `ID ${sharedCredentialAssignmentPicker.currentCredentialId}`;
                    })()
                    : 'None'}
                </p>
              </div>
              <div className="it-admin-actions">
                <button className="it-primary-btn" type="button" onClick={handleConfirmSharedCredentialAssignment} disabled={!sharedCredentialAssignmentPicker.options?.length || assignmentSavingKey === `${sharedCredentialAssignmentPicker.tool?.id}:${sharedCredentialAssignmentPicker.user?.id}`}>
                  {assignmentSavingKey === `${sharedCredentialAssignmentPicker.tool?.id}:${sharedCredentialAssignmentPicker.user?.id}` ? 'Saving...' : 'Assign Selected Login'}
                </button>
                <button className="it-secondary-btn" type="button" onClick={closeSharedCredentialAssignmentPicker} disabled={assignmentSavingKey === `${sharedCredentialAssignmentPicker.tool?.id}:${sharedCredentialAssignmentPicker.user?.id}`}>
                  Cancel
                </button>
                <button className="it-danger-btn" type="button" onClick={handleRemoveSharedCredentialAssignment} disabled={!sharedCredentialAssignmentPicker.currentCredentialId || assignmentSavingKey === `${sharedCredentialAssignmentPicker.tool?.id}:${sharedCredentialAssignmentPicker.user?.id}`}>
                  Remove Assignment
                </button>
              </div>
            </div>
          </section>
        )}

        {launchResult?.credential && !launchResult.autoLogin && !launchResult.extensionAutoFill && (
          <section className="credential-panel">
            <div>
              <p className="it-profile-eyebrow">Credential ready</p>
              <h2>{launchResult.tool?.name}</h2>
              <p>Use this assigned {launchResult.credential.scope} credential if the website asks you to log in.</p>
            </div>
            <div className="credential-fields">
              {launchResult.credential.loginIdentifier && (
                <button type="button" onClick={() => copyToClipboard(launchResult.credential.loginIdentifier)}>
                  Copy username
                </button>
              )}
              {launchResult.credential.password && (
                <button type="button" onClick={() => copyToClipboard(launchResult.credential.password)}>
                  Copy password
                </button>
              )}
            </div>
          </section>
        )}

        {launchResult?.autoLogin && (
          <section className="credential-panel">
            <div>
              <p className="it-profile-eyebrow">Auto-login started</p>
              <h2>{launchResult.tool?.name}</h2>
              <p>The assigned credential was sent through the secure launch page. Some websites may still block automated login.</p>
            </div>
          </section>
        )}

        {launchResult?.extensionAutoFill && (
          <section className="credential-panel">
            <div>
              <p className="it-profile-eyebrow">Extension ready</p>
              <h2>{launchResult.tool?.name}</h2>
              <p>The company auto-login extension will fill the assigned credential when the login page opens.</p>
            </div>
          </section>
        )}

        {activeView === 'credits' && isAdmin && (
          <section className="it-usage-card it-usage-card--credits">
            <div className="it-usage-header">
              <div className="it-usage-heading">
                <p className="it-profile-eyebrow">Tool Usage</p>
                <h2>Usage and launch tracking</h2>
                <span>All tool launches in one place, with deeper Kling generation capture when available.</span>
              </div>
              <div className="it-usage-filters">
                <input
                  className="it-usage-filter-control"
                  type="date"
                  aria-label="Usage from date"
                  value={usageFilters.dateFrom}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, dateFrom: event.target.value }))}
                />
                <input
                  className="it-usage-filter-control"
                  type="date"
                  aria-label="Usage to date"
                  value={usageFilters.dateTo}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, dateTo: event.target.value }))}
                />
                <select
                  className="it-usage-filter-control"
                  value={usageFilters.userId}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, userId: event.target.value }))}
                >
                  <option value="">All users</option>
                  {sortedUsers.map((user) => (
                    <option key={`usage-user-${user.id}`} value={user.id}>
                      {user.name || user.email}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="it-usage-export-btn"
                  onClick={handleExportKlingUsage}
                  disabled={usageExporting || usageRawExporting}
                >
                  {usageExporting ? 'Exporting...' : 'Export Kling Excel'}
                </button>
                <button
                  type="button"
                  className="it-usage-export-btn is-secondary"
                  onClick={handleExportKlingRawUsage}
                  disabled={usageExporting || usageRawExporting}
                >
                  {usageRawExporting ? 'Exporting...' : 'Export Raw Kling Excel'}
                </button>
              </div>
            </div>

            <div className="it-usage-overview-grid">
              <div className="it-usage-summary-pill">
                <span>Total launches</span>
                <strong>{launchHistoryLoading ? '...' : launchHistorySummary.launchCount}</strong>
              </div>
              <div className="it-usage-summary-pill">
                <span>Users active</span>
                <strong>{launchHistoryLoading ? '...' : launchHistorySummary.userCount}</strong>
              </div>
              <div className="it-usage-summary-pill">
                <span>Tools opened</span>
                <strong>{launchHistoryLoading ? '...' : launchHistorySummary.toolCount}</strong>
              </div>
              <div className="it-usage-summary-pill">
                <span>Last launch</span>
                <strong>{launchHistoryLoading ? '...' : formatUsageDateTime(launchHistorySummary.lastLaunchedAt)}</strong>
              </div>
            </div>

            <div className="it-usage-split-grid">
              <div className="it-usage-launch-history">
                <div className="it-usage-launch-head">
                  <div>
                    <h3>All tool launches</h3>
                    <p>Every dashboard-opened tool, even if deep capture is not available yet.</p>
                  </div>
                  <div className="it-usage-launch-stats">
                    <span>{launchHistoryLoading ? '...' : launchHistorySummary.launchCount} launches</span>
                  </div>
                </div>

                {launchHistoryRows.length ? (
                  <div className="it-usage-launch-list">
                    {launchHistoryRows.slice(0, 10).map((launch) => (
                      <div key={launch.id} className="it-usage-launch-item">
                        <div className="it-usage-launch-main">
                          <strong>{launch.toolName || launch.toolSlug || `Tool #${launch.toolId}`}</strong>
                          <small>{launch.userName || launch.userEmail || `User #${launch.userId}`}</small>
                        </div>
                        <div className="it-usage-launch-meta">
                          <span>{formatUsageDateTime(launch.clickedAt)}</span>
                          <small>{launch.launchMode || launch.effectiveLaunchMode || 'launch'}</small>
                        </div>
                        <div className="it-usage-launch-activity">
                          <span>{Array.isArray(launch.relatedActivity) ? launch.relatedActivity.length : 0}</span>
                          <small>events</small>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="it-usage-launch-empty">
                    {launchHistoryLoading ? 'Loading tool launches...' : 'No tool launches found for this filter.'}
                  </div>
                )}
              </div>

              <div className="it-usage-kling-panel">
                <div className="it-usage-launch-head">
                  <div>
                    <h3>Kling generation capture</h3>
                    <p>Prompt, output, credit, and MediaSource video events captured from Kling.</p>
                  </div>
                </div>
                <select
                  className="it-usage-filter-control"
                  value={usageFilters.credentialId}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, credentialId: event.target.value }))}
                >
                  <option value="">All Kling mails</option>
                  {usageCredentialOptions.map((option) => (
                    <option key={`usage-credential-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div className="it-usage-kling-metrics">
                  <div>
                    <span>Generate clicks</span>
                    <strong>{usageLoading ? '...' : usageSummaryForDisplay.generateClicks}</strong>
                  </div>
                  <div>
                    <span>Credits burned</span>
                    <strong>{usageLoading ? '...' : formatUsageNumber(usageSummaryForDisplay.creditsBurned)}</strong>
                  </div>
                  <div>
                    <span>Current credits</span>
                    <strong>{usageLoading ? '...' : (usageSummaryForDisplay.currentCredits != null ? formatUsageNumber(usageSummaryForDisplay.currentCredits) : '-')}</strong>
                  </div>
                </div>
              </div>
            </div>

            {!!filteredRecentUsageEvents.length && (
              <div className="it-usage-recent">
                <h3>Recent captured events</h3>
                <div className="it-usage-recent-list">
                  {filteredRecentUsageEvents.slice(0, 8).map((event) => {
                    const promptText = getUsageEventPrompt(event);
                    const settings = getUsageEventSettings(event);
                    const inputAssets = getUsageEventMediaAssets(event, 'input');
                    const outputAssets = getUsageEventMediaAssets(event, 'output');

                    return (
                      <div key={event.id} className="it-usage-recent-item">
                        <div className="it-usage-recent-top">
                          <div className="it-usage-user-cell">
                            <strong>{event.userName || event.userEmail || `User #${event.userId}`}</strong>
                            <small>{event.userEmail || ''}</small>
                          </div>
                          <div className="it-usage-recent-burn">
                            <span>Credits burned</span>
                            <strong>{event.creditsBurned != null ? formatUsageNumber(event.creditsBurned) : '-'}</strong>
                          </div>
                        </div>
                        <div className="it-usage-recent-grid">
                          <div className="it-usage-recent-meta">
                            <span>Date & time</span>
                            <strong>{formatUsageDateTime(event.createdAt)}</strong>
                          </div>
                          <div className="it-usage-recent-meta">
                            <span>Kling ID used</span>
                            <strong>{formatUsageCredentialTitle(event.credentialLabel, event.credentialId)}</strong>
                            <small>{event.credentialScope || ''}</small>
                          </div>
                          <div className="it-usage-recent-meta">
                            <span>Generation</span>
                            <strong>{event.modelLabel || 'Kling'}</strong>
                            <small>
                              {[
                                event.resolutionLabel,
                                event.durationLabel,
                              ].filter(Boolean).join(' · ') || 'No extra generation details'}
                            </small>
                          </div>
                        </div>

                        {(promptText || settings.length > 0) && (
                          <div className="it-usage-capture-block">
                            {promptText && (
                              <div className="it-usage-prompt">
                                <span>Prompt</span>
                                <p>{promptText}</p>
                              </div>
                            )}
                            {!!settings.length && (
                              <div className="it-usage-setting-list">
                                {settings.map((setting) => (
                                  <span key={`${event.id}-setting-${setting}`}>{setting}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {(inputAssets.length > 0 || outputAssets.length > 0) && (
                          <div className="it-usage-media-groups">
                            {!!inputAssets.length && (
                              <div className="it-usage-media-group">
                                <span>Input media</span>
                                <div className="it-usage-media-list">
                                  {inputAssets.slice(0, 4).map((asset, index) => (
                                    <a
                                      key={`${event.id}-input-${asset.url}-${index}`}
                                      href={asset.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={asset.url}
                                    >
                                      {formatUsageAssetLabel(asset, index)}
                                    </a>
                                  ))}
                                </div>
                              </div>
                            )}
                            {!!outputAssets.length && (
                              <div className="it-usage-media-group">
                                <span>Output media</span>
                                <div className="it-usage-media-list">
                                  {outputAssets.slice(0, 6).map((asset, index) => (
                                    <a
                                      key={`${event.id}-output-${asset.url}-${index}`}
                                      href={asset.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={asset.url}
                                    >
                                      {formatUsageAssetLabel(asset, index)}
                                    </a>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        {activeView === 'charts' && isAdmin && (
          <section className="it-usage-card it-usage-card--charts">
            <div className="it-usage-header">
              <div className="it-usage-heading">
                <p className="it-profile-eyebrow">Usage Charts</p>
                <h2>Credit burn charts</h2>
                <span>Date-wise credit graphs and per-user burn comparison for the selected range.</span>
              </div>
              <div className="it-usage-filters">
                <input
                  className="it-usage-filter-control"
                  type="date"
                  aria-label="Chart from date"
                  value={usageFilters.dateFrom}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, dateFrom: event.target.value }))}
                />
                <input
                  className="it-usage-filter-control"
                  type="date"
                  aria-label="Chart to date"
                  value={usageFilters.dateTo}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, dateTo: event.target.value }))}
                />
                <select
                  className="it-usage-filter-control"
                  value={usageFilters.userId}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, userId: event.target.value }))}
                >
                  <option value="">All users</option>
                  {sortedUsers.map((user) => (
                    <option key={`chart-user-${user.id}`} value={user.id}>
                      {user.name || user.email}
                    </option>
                  ))}
                </select>
                <select
                  className="it-usage-filter-control"
                  value={usageFilters.credentialId}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, credentialId: event.target.value }))}
                >
                  <option value="">All Kling mails</option>
                  {usageCredentialOptions.map((option) => (
                    <option key={`chart-credential-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="it-usage-chart-stack">
              <div className="it-usage-chart-panel">
                <div className="it-usage-chart-head">
                  <div>
                    <h3>Credit burn by date</h3>
                    <p>The line chart follows the selected date filter so you can inspect burn day by day.</p>
                  </div>
                  <span>{usageChartRangeLabel}</span>
                </div>
                <div className="it-usage-chart-stats">
                  <div className="it-usage-chart-stat">
                    <span>Overall credits burned</span>
                    <strong>{usageLoading ? '...' : formatUsageNumber(usageCharts.totalCreditsBurned)}</strong>
                  </div>
                  <div className="it-usage-chart-stat">
                    <span>Average per day</span>
                    <strong>{usageLoading ? '...' : formatUsageNumber(usageCharts.averageDailyBurn)}</strong>
                  </div>
                  <div className="it-usage-chart-stat">
                    <span>Peak burn day</span>
                    <strong>{usageLoading ? '...' : (usageCharts.peakDay ? formatUsageNumber(usageCharts.peakDay.creditsBurned) : '0')}</strong>
                    <small>{usageLoading ? '' : (usageCharts.peakDay ? formatUsageDate(usageCharts.peakDay.date) : 'No activity')}</small>
                  </div>
                  <div className="it-usage-chart-stat">
                    <span>Tracked days</span>
                    <strong>{usageLoading ? '...' : usageCharts.selectedDayCount}</strong>
                  </div>
                </div>
                <UsageCreditsLineChart data={usageCharts.dailySeries} loading={usageLoading} />
              </div>

              <div className="it-usage-chart-panel">
                <div className="it-usage-chart-head">
                  <div>
                    <h3>Day-level consumption bar chart</h3>
                    <p>The bar chart shows total credit consumption for each selected day only.</p>
                  </div>
                  <span>{usageChartRangeLabel}</span>
                </div>
                <UsageDailyBarChart data={usageCharts.dailySeries} loading={usageLoading} />
              </div>

              <div className="it-usage-chart-panel">
                <div className="it-usage-chart-head">
                  <div>
                    <h3>User credit burn by day</h3>
                    <p>This chart shows one day at a time, with user names on the X axis and credits on the Y axis.</p>
                  </div>
                  <div className="it-usage-chart-controls">
                    <input
                      className="it-usage-filter-control"
                      type="date"
                      aria-label="User credit day"
                      value={usageUserDayChartDate}
                      onChange={(event) => setUsageUserDayChartDate(event.target.value)}
                    />
                  </div>
                </div>
                <div className="it-usage-chart-top-user">
                  <span>Selected day total</span>
                  <strong>{usageUserDayLoading ? '...' : formatUsageNumber(selectedUsageUserDayTotal)}</strong>
                  <small>{usageUserDayLoading ? '' : formatUsageDate(usageUserDayChartDate)}</small>
                </div>
                <UsageSingleDayUserBarChart
                  data={selectedUsageUserDaySeries}
                  selectedDate={usageUserDayChartDate}
                  loading={usageUserDayLoading}
                />
              </div>

              <div className="it-usage-chart-panel">
                <div className="it-usage-chart-head">
                  <div>
                    <h3>Credits burned by user</h3>
                    <p>The bar graph shows which user burned the most credits in the selected range.</p>
                  </div>
                  <span>{usageLoading ? '...' : `${usageCharts.userSeries.length} user${usageCharts.userSeries.length === 1 ? '' : 's'}`}</span>
                </div>
                <div className="it-usage-chart-top-user">
                  <span>Highest burner</span>
                  <strong>
                    {usageLoading
                      ? '...'
                      : (usageCharts.topUser ? getUsageUserLabel(usageCharts.topUser) : 'No user data')}
                  </strong>
                  <small>
                    {usageLoading
                      ? ''
                      : (usageCharts.topUser ? `${formatUsageNumber(usageCharts.topUser.creditsBurned)} credits burned` : 'Change the date filter to see activity')}
                  </small>
                </div>
                <UsageCreditsBarChart data={usageCharts.userSeries} loading={usageLoading} />
              </div>
            </div>
          </section>
        )}

        {activeView === 'tools' && (!isAdmin || toolAdminSection === 'assigned') && (
          <section className="tools-browse-view" aria-label="Tools catalog">
            <div className="category-container">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category}
                  onClick={() => setSelectedCategory(category)}
                  className={`category-btn ${selectedCategory === category ? 'active' : ''}`}
                  aria-pressed={selectedCategory === category}
                >
                  {category}
                </button>
              ))}
            </div>

            <div className="tool-grid" aria-busy={loading ? 'true' : 'false'}>
              {loading ? (
                <div className="empty-state">
                  <h3 className="empty-state-title">Loading IT tools...</h3>
                  <p className="empty-state-copy">Fetching the current company tool catalog and credential availability.</p>
                </div>
              ) : filteredTools.length > 0 ? (
                filteredTools.map((tool) => {
                  const CardIcon = IconComponent(tool.icon);
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      className="tool-card"
                      onClick={() => handleLaunchTool(tool)}
                      disabled={launchingToolId === `${tool.id}`}
                    >
                      <div className="tool-header">
                        <div className="tool-icon-group">
                          <div className="tool-icon"><CardIcon /></div>
                          <h3 className="tool-name">{tool.name}</h3>
                        </div>
                        <div className="status-badge">
                          <span className={`status-dot ${tool.status === 'active' ? 'status-active' : 'status-maintenance'}`}></span>
                          <span className="tool-status-label">{tool.status || 'active'}</span>
                        </div>
                      </div>
                      <p className="tool-description">{tool.description || 'Open this company tool.'}</p>
                      <div className="tool-meta" aria-label={`${tool.name} metadata`}>
                        <span className="tool-meta-item">{tool.category}</span>
                        <span className="tool-meta-sep" aria-hidden="true">·</span>
                        <span className="tool-meta-item">{tool.hasCredential ? tool.credentialScope : 'Not assigned'}</span>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="empty-state">
                  <h3 className="empty-state-title">No tools found</h3>
                  <p className="empty-state-copy">Try a different search or switch back to the full catalog.</p>
                  <button type="button" className="reset-btn" onClick={() => { setSearchQuery(''); setSelectedCategory('All'); }}>
                    Reset filters
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
