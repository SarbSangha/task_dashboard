import React, { useEffect, useMemo, useState } from 'react';
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

const EMPTY_MAILBOX_FORM = {
  toolId: '',
  email_address: '',
  app_password: '',
  otp_sender_filter: '',
  otp_subject_pattern: '',
  otp_regex: '\\b(\\d{4,8})\\b',
  auth_link_host: '',
  auth_link_pattern: '',
};

const normalizeToolSlug = (value) => {
  const normalized = `${value || ''}`.trim().toLowerCase();
  const slugified = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slugified === 'chat-gpt') return 'chatgpt';
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
  return normalizedToolSlug === 'freepik'
    || normalizedToolSlug === 'kling-ai'
    || normalizedToolSlug === 'klingai'
    || normalizedToolSlug === 'kling';
};

const getDefaultCredentialLoginMethod = (value) => {
  const normalizedToolSlug = normalizeToolSlug(typeof value === 'string' ? value : value?.slug || value?.name);
  if (normalizedToolSlug === 'kling-ai' || normalizedToolSlug === 'klingai' || normalizedToolSlug === 'kling') {
    return 'email_password';
  }
  return 'email_password';
};

const getSharedCredentialLabels = (toolValue) => {
  const isStringValue = typeof toolValue === 'string';
  const normalizedToolSlug = normalizeToolSlug(isStringValue ? toolValue : toolValue?.slug);
  const displayName = isStringValue
    ? (normalizedToolSlug === 'chatgpt' ? 'ChatGPT' : normalizedToolSlug === 'flow' ? 'Flow' : 'tool')
    : (toolValue?.name || (normalizedToolSlug === 'chatgpt' ? 'ChatGPT' : normalizedToolSlug === 'flow' ? 'Flow' : 'tool'));
  if (normalizedToolSlug === 'chatgpt') {
    return {
      singular: 'password',
      plural: 'passwords',
      addAction: 'Add new ChatGPT password',
      listTitle: 'Saved ChatGPT passwords',
      assignTitle: 'Assign this ChatGPT password',
      dialogTitle: 'Assign ChatGPT Password',
      emptyState: 'Save the first ChatGPT login to start building user assignments.',
      saveNotice: 'ChatGPT password saved. You can now see which users are assigned to this login from the saved password list.',
      updateAction: 'Update ChatGPT Password',
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

const openFlowInIsolatedWindow = (launchDetail) => new Promise((resolve) => {
  const normalizedSlug = normalizeToolSlug(launchDetail?.toolSlug);
  const toolName = normalizedSlug === 'chatgpt' ? 'ChatGPT' : 'Flow';
  if (!['flow', 'chatgpt'].includes(normalizedSlug)) {
    resolve({ ok: false, error: 'Isolated launch is only available for Flow and ChatGPT.' });
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
      error: `${toolName} isolated launch timed out. Check whether the extension is loaded and allowed in incognito.`,
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

const buildExtensionLaunchUrl = (launchUrl, extensionTicket, toolSlug) => {
  if (!launchUrl || !extensionTicket) return launchUrl;

  try {
    const url = new URL(launchUrl, window.location.origin);
    const normalizedToolSlug = normalizeToolSlug(toolSlug);
    url.searchParams.set('rmw_extension_ticket', extensionTicket);
    if (normalizedToolSlug) {
      url.searchParams.set('rmw_tool_slug', normalizedToolSlug);
    }
    const params = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    params.set('rmw_extension_ticket', extensionTicket);
    if (normalizedToolSlug) {
      params.set('rmw_tool_slug', normalizedToolSlug);
    }
    url.hash = params.toString();
    return url.toString();
  } catch {
    return launchUrl;
  }
};

const resolveExtensionLaunchUrl = (launchUrl, extensionTicket, toolSlug) => {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  const nextLaunchUrl = normalizedSlug === 'flow' ? FLOW_DIRECT_ROUTE_URL : launchUrl;
  return buildExtensionLaunchUrl(nextLaunchUrl, extensionTicket, normalizedSlug);
};

export default function Tools() {
  const [tools, setTools] = useState([]);
  const [users, setUsers] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mailboxBusy, setMailboxBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedTool, setSelectedTool] = useState(null);
  const [launchingToolId, setLaunchingToolId] = useState('');
  const [editToolId, setEditToolId] = useState('');
  const [toolForm, setToolForm] = useState(EMPTY_TOOL_FORM);
  const [credentialForm, setCredentialForm] = useState(EMPTY_CREDENTIAL_FORM);
  const [mailboxForm, setMailboxForm] = useState(EMPTY_MAILBOX_FORM);
  const [mailboxMeta, setMailboxMeta] = useState({ exists: false, appPasswordSet: false });
  const [launchResult, setLaunchResult] = useState(null);
  const [toolCredentialsByToolId, setToolCredentialsByToolId] = useState({});
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentSavingKey, setAssignmentSavingKey] = useState('');
  const [sharedCredentialAssignmentPicker, setSharedCredentialAssignmentPicker] = useState(null);

  const loadToolCredentials = async (toolList, signal, { manageLoading = true } = {}) => {
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
  };

  const refreshToolCredentialCache = async (toolId) => {
    const response = await itToolsAPI.getToolCredentials(toolId);
    setToolCredentialsByToolId((current) => ({
      ...current,
      [`${toolId}`]: response.credentials || [],
    }));
  };

  const loadTools = async (signal) => {
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
      setError(err?.response?.data?.detail || 'Unable to load IT tools.');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadTools(controller.signal);

    return () => {
      controller.abort();
    };
  }, []);

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

  const activeCredentialTool = useMemo(() => {
    const toolId = `${credentialForm.toolId || selectedTool?.id || ''}`.trim();
    if (!toolId) return null;
    return tools.find((tool) => `${tool.id}` === toolId) || null;
  }, [credentialForm.toolId, selectedTool, tools]);

  const activeCredentialToolSlug = normalizeToolSlug(activeCredentialTool?.slug);
  const activeCredentialLoginMethod = credentialForm.login_method || getDefaultCredentialLoginMethod(activeCredentialToolSlug);
  const showToolTotpSecretField = ['flow', 'chatgpt'].includes(activeCredentialToolSlug);
  const showFlowBackupCodesField = activeCredentialToolSlug === 'flow';
  const activeCredentialPasswordOptional = toolSupportsPasswordOptionalCredential(activeCredentialToolSlug)
    || (toolSupportsCredentialLoginMethodSelection(activeCredentialToolSlug) && activeCredentialLoginMethod === 'google');
  const activeCredentialShouldHidePasswordField = toolSupportsPasswordOptionalCredential(activeCredentialToolSlug);
  const totpSecretToolLabel = activeCredentialToolSlug === 'chatgpt' ? 'ChatGPT' : 'Flow';
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
    const tool = tools.find((item) => Number(item.id) === Number(toolId));
    if (!supportsSharedCompanyCredentialAssignments(tool)) {
      return null;
    }

    const directory = credentialDirectory[toolId] || { companyList: [], users: {} };
    const userCredential = directory.users[userId];
    return getLinkedCompanyCredentialSummary(directory, userCredential);
  };

  const isSharedCredentialAssignmentMode = (toolId) => {
    const tool = tools.find((item) => Number(item.id) === Number(toolId));
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
    const tool = tools.find((item) => Number(item.id) === Number(toolId)) || null;

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

  const assignmentColumns = useMemo(() => filteredTools, [filteredTools]);

  const handleEditToolChange = (toolId) => {
    setEditToolId(toolId);
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

  const loadMailboxConfig = async (toolId) => {
    const normalizedToolId = `${toolId || ''}`.trim();
    if (!normalizedToolId) {
      setMailboxForm(EMPTY_MAILBOX_FORM);
      setMailboxMeta({ exists: false, appPasswordSet: false });
      return;
    }

    setMailboxBusy(true);
    setError('');
    try {
      const response = await itToolsAPI.getMailboxConfig(normalizedToolId);
      setMailboxForm({
        toolId: normalizedToolId,
        email_address: response.email_address || '',
        app_password: '',
        otp_sender_filter: response.otp_sender_filter || '',
        otp_subject_pattern: response.otp_subject_pattern || '',
        otp_regex: response.otp_regex || EMPTY_MAILBOX_FORM.otp_regex,
        auth_link_host: response.auth_link_host || '',
        auth_link_pattern: response.auth_link_pattern || '',
      });
      setMailboxMeta({
        exists: true,
        appPasswordSet: !!response.app_password_set,
      });
    } catch (err) {
      if (err?.response?.status === 404) {
        setMailboxForm({ ...EMPTY_MAILBOX_FORM, toolId: normalizedToolId });
        setMailboxMeta({ exists: false, appPasswordSet: false });
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
    const supportsTotpSecret = ['flow', 'chatgpt'].includes(targetToolSlug);
    const selectedLoginMethod = credentialForm.login_method || getDefaultCredentialLoginMethod(targetToolSlug);
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
    setMailboxMeta({ exists: false, appPasswordSet: false });
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
        email_address: mailboxForm.email_address,
        app_password: mailboxForm.app_password || undefined,
        otp_sender_filter: mailboxForm.otp_sender_filter || undefined,
        otp_subject_pattern: mailboxForm.otp_subject_pattern || undefined,
        otp_regex: mailboxForm.otp_regex || EMPTY_MAILBOX_FORM.otp_regex,
        auth_link_host: mailboxForm.auth_link_host || undefined,
        auth_link_pattern: mailboxForm.auth_link_pattern || undefined,
      });
      await loadMailboxConfig(toolId);
      setNotice('Verification mailbox settings saved.');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save verification mailbox settings.');
    } finally {
      setMailboxBusy(false);
    }
  };

  const handleTestMailbox = async () => {
    const toolId = `${mailboxForm.toolId || ''}`.trim();
    if (!toolId) {
      setError('Choose a tool before testing the OTP mailbox.');
      return;
    }

    setMailboxBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await itToolsAPI.testMailboxConfig(toolId);
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
    if (!toolId) {
      setError('Choose a tool before deleting the OTP mailbox.');
      return;
    }

    const tool = tools.find((item) => `${item.id}` === toolId);
    const confirmed = window.confirm(`Remove verification mailbox settings for ${tool?.name || 'this tool'}?`);
    if (!confirmed) return;

    setMailboxBusy(true);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.deleteMailboxConfig(toolId);
      setMailboxForm({ ...EMPTY_MAILBOX_FORM, toolId });
      setMailboxMeta({ exists: false, appPasswordSet: false });
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
      if (response.extensionAutoFill && response.extensionTicket && response.tool?.slug) {
        const normalizedToolSlug = normalizeToolSlug(response.tool.slug);
        const launchDetail = {
          toolSlug: normalizedToolSlug,
          toolName: response.tool.name,
          ticket: response.extensionTicket,
          expiresAt: Number(response.extensionTicketExpiresAt || 0) * 1000,
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
        launchUrl = resolveExtensionLaunchUrl(response.launchUrl, response.extensionTicket, normalizedToolSlug);
        if (['flow', 'chatgpt'].includes(normalizedToolSlug)) {
          const isolatedResult = await openFlowInIsolatedWindow({
            toolSlug: normalizedToolSlug,
            launchUrl,
          });
          if (!isolatedResult.ok) {
            throw new Error(isolatedResult.error || `Unable to open ${response.tool.name || response.tool.slug} in an isolated window.`);
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

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-wrapper">
          <div>
            <p className="it-profile-eyebrow">IT Profile</p>
            <h1 className="app-title">Company Tool Hub</h1>
            <p className="app-subtitle">
              Manage company tools, launch links, and assigned credentials from one secure place.
            </p>
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

        {isAdmin && (
          <section className="it-admin-grid">
            <form className="it-admin-card" onSubmit={handleSaveTool} autoComplete="off">
              <div className="it-admin-card-header">
                <div>
                  <h2>{editToolId ? 'Edit Tool' : 'Add Tool'}</h2>
                  <p className="it-card-copy">Set the launch target, access mode, and presentation details for each company tool.</p>
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
                <input value={toolForm.name} onChange={(e) => setToolForm({ ...toolForm, name: e.target.value })} placeholder="Tool name" autoComplete="off" required />
                <input value={toolForm.category} onChange={(e) => setToolForm({ ...toolForm, category: e.target.value })} placeholder="Category" autoComplete="off" />
                <input value={toolForm.website_url} onChange={(e) => setToolForm({ ...toolForm, website_url: e.target.value })} placeholder="Website URL" autoComplete="url" required />
                <input value={toolForm.login_url} onChange={(e) => setToolForm({ ...toolForm, login_url: e.target.value })} placeholder="Login URL optional" autoComplete="url" />
                <select value={toolForm.icon} onChange={(e) => setToolForm({ ...toolForm, icon: e.target.value })}>
                  {Object.keys(Icons).filter((key) => key !== 'Search').map((icon) => (
                    <option key={icon} value={icon}>{icon}</option>
                  ))}
                </select>
                <select value={toolForm.launch_mode} onChange={(e) => setToolForm({ ...toolForm, launch_mode: e.target.value })}>
                  <option value="manual_credential">Manual credential</option>
                  <option value="external_link">External link</option>
                  <option value="sso">SSO</option>
                  <option value="api_proxy">API proxy</option>
                  <option value="extension_autofill">Extension auto-fill (Claude, ChatGPT/OpenAI, Envato, Freepik, Grammarly, Higgsfield, HeyGen, Kling AI, Flow)</option>
                  <option value="automation">Auto-login form submit</option>
                </select>
              </div>
              {toolForm.launch_mode === 'extension_autofill' && (
                <p className="it-card-copy">
                  The current browser extension build supports Claude, ChatGPT/OpenAI, Envato, Freepik, Grammarly, Higgsfield, HeyGen, Kling AI, and Flow
                  extension scaffold. For other tools, use Manual credential or Auto-login form submit.
                </p>
              )}
              {toolForm.launch_mode === 'automation' && (
                <div className="it-form-grid auto-login-grid">
                  <input
                    value={toolForm.auto_login_action_url}
                    onChange={(e) => setToolForm({ ...toolForm, auto_login_action_url: e.target.value })}
                    placeholder="Login submit URL optional"
                    autoComplete="url"
                  />
                  <select
                    value={toolForm.auto_login_method}
                    onChange={(e) => setToolForm({ ...toolForm, auto_login_method: e.target.value })}
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                  </select>
                  <input
                    value={toolForm.auto_login_username_field}
                    onChange={(e) => setToolForm({ ...toolForm, auto_login_username_field: e.target.value })}
                    placeholder="Username field name"
                    autoComplete="off"
                  />
                  <input
                    value={toolForm.auto_login_password_field}
                    onChange={(e) => setToolForm({ ...toolForm, auto_login_password_field: e.target.value })}
                    placeholder="Password field name"
                    autoComplete="off"
                  />
                </div>
              )}
              <textarea value={toolForm.description} onChange={(e) => setToolForm({ ...toolForm, description: e.target.value })} placeholder="Short description" autoComplete="off" />
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
                    <option value="email_password">Continue with email</option>
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
                      : activeCredentialToolSlug === 'freepik'
                        ? 'This Freepik credential will use Continue with Google. Save the Google email here, and add the Google password too if this account reaches the password step during sign-in.'
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
                  <p className="it-card-copy">Manage the Gmail inbox used for OTP codes or magic sign-in links so email-based tools like Claude can complete verification securely.</p>
                </div>
                <span>{mailboxMeta.exists ? 'Configured' : 'Optional'}</span>
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
              <div className="it-form-grid">
                <input
                  value={mailboxForm.email_address}
                  onChange={(e) => setMailboxForm({ ...mailboxForm, email_address: e.target.value })}
                  placeholder="otp-inbox@gmail.com"
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
                  ? `Mailbox saved for this tool${mailboxMeta.appPasswordSet ? ' with an app password on file.' : '.'}`
                  : 'No verification mailbox saved for this tool yet.'}
              </p>
              <div className="it-admin-actions">
                <button className="it-primary-btn" type="submit" disabled={mailboxBusy}>
                  {mailboxBusy ? 'Working...' : mailboxMeta.exists ? 'Update Mailbox' : 'Save Mailbox'}
                </button>
                <button
                  className="it-secondary-btn"
                  type="button"
                  onClick={handleTestMailbox}
                  disabled={mailboxBusy || !mailboxMeta.exists || !mailboxForm.toolId}
                >
                  Test Connection
                </button>
                <button
                  className="it-danger-btn"
                  type="button"
                  onClick={handleDeleteMailbox}
                  disabled={mailboxBusy || !mailboxMeta.exists || !mailboxForm.toolId}
                >
                  Delete Mailbox
                </button>
              </div>
            </form>
          </section>
        )}

        {isAdmin && (
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
                      const directory = credentialDirectory[tool.id] || { company: null, companyList: [] };
                      const companyReady = (directory.companyList || []).some((summary) => hasActiveUsableCredentialSummary(summary, tool));
                      const normalizedToolSlug = normalizeToolSlug(tool?.slug);
                      const readyCredentialCount = (directory.companyList || []).filter((summary) => hasActiveUsableCredentialSummary(summary, tool)).length;
                      return (
                        <th key={tool.id} className="it-tool-column">
                          <div className="it-tool-column-copy">
                            <strong>{tool.name}</strong>
                            <small>{tool.category}</small>
                            <span className={`it-company-badge ${companyReady ? 'is-ready' : 'is-missing'}`}>
                              {companyReady
                                ? supportsSharedCompanyCredentialAssignments(normalizedToolSlug)
                                  ? `${readyCredentialCount} ${getSharedCredentialLabels(tool).singular}${readyCredentialCount === 1 ? '' : 's'} ready`
                                  : 'Company ready'
                                : supportsSharedCompanyCredentialAssignments(normalizedToolSlug)
                                  ? `Needs ${getSharedCredentialLabels(tool).singular}`
                                  : 'Needs credential'}
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
                    sortedUsers.map((user) => (
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

        <div className="category-container">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`category-btn ${selectedCategory === category ? 'active' : ''}`}
            >
              {category}
            </button>
          ))}
        </div>

        <div className="tool-grid">
          {loading ? (
            <div className="empty-state"><h3>Loading IT tools...</h3></div>
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
                    <div className="tool-icon"><CardIcon /></div>
                    <div className="status-badge">
                      <span className={`status-dot ${tool.status === 'active' ? 'status-active' : 'status-maintenance'}`}></span>
                      <span>{tool.status || 'active'}</span>
                    </div>
                  </div>
                  <h3 className="tool-name">{tool.name}</h3>
                  <p className="tool-description">{tool.description || 'Open this company tool.'}</p>
                  <div className="tool-info">
                    <p><strong>Category:</strong> {tool.category}</p>
                    <p><strong>Credential:</strong> {tool.hasCredential ? tool.credentialScope : 'Not assigned'}</p>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="empty-state">
              <h3>No tools found</h3>
              <button className="reset-btn" onClick={() => { setSearchQuery(''); setSelectedCategory('All'); }}>
                Reset filters
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
