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
  scope: 'company',
  user_ids: [],
  login_identifier: '',
  password: '',
  notes: '',
};

const EMPTY_MAILBOX_FORM = {
  toolId: '',
  email_address: '',
  app_password: '',
  otp_sender_filter: '',
  otp_subject_pattern: '',
  otp_regex: '\\b(\\d{4,8})\\b',
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
  const normalizedSlug = `${toolSlug || ''}`.trim().toLowerCase();
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
    const storedSlug = `${event.detail?.toolSlug || ''}`.trim().toLowerCase();
    if (storedSlug === normalizedSlug) {
      finish({ ok: true, stored: true, error: '' });
    }
  };
  const handleMessage = (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== 'rmw-tool-hub-extension') return;
    if (event.data?.type !== EXTENSION_LAUNCH_STORED_MESSAGE_TYPE) return;
    const storedSlug = `${event.data?.toolSlug || ''}`.trim().toLowerCase();
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
  const normalizedSlug = `${launchDetail?.toolSlug || ''}`.trim().toLowerCase();
  if (normalizedSlug !== 'flow') {
    resolve({ ok: false, error: 'Flow isolated launch is only available for Flow.' });
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
    const resultSlug = `${event.detail?.toolSlug || ''}`.trim().toLowerCase();
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
    const resultSlug = `${event.data?.toolSlug || ''}`.trim().toLowerCase();
    if (resultSlug !== normalizedSlug) return;
    finish({
      ok: Boolean(event.data?.ok),
      error: `${event.data?.error || ''}`.trim(),
    });
  };
  const timerId = window.setTimeout(() => {
    finish({
      ok: false,
      error: 'Flow isolated launch timed out. Check whether the extension is loaded and allowed in incognito.',
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
    url.searchParams.set('rmw_extension_ticket', extensionTicket);
    if (toolSlug) {
      url.searchParams.set('rmw_tool_slug', toolSlug);
    }
    const params = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    params.set('rmw_extension_ticket', extensionTicket);
    if (toolSlug) {
      params.set('rmw_tool_slug', toolSlug);
    }
    url.hash = params.toString();
    return url.toString();
  } catch {
    return launchUrl;
  }
};

const resolveExtensionLaunchUrl = (launchUrl, extensionTicket, toolSlug) => {
  const normalizedSlug = `${toolSlug || ''}`.trim().toLowerCase();
  const nextLaunchUrl = normalizedSlug === 'flow' ? FLOW_DIRECT_ROUTE_URL : launchUrl;
  return buildExtensionLaunchUrl(nextLaunchUrl, extensionTicket, toolSlug);
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

  const loadTools = async (signal) => {
    if (signal?.aborted) return;
    setLoading(true);
    setError('');
    try {
      const response = await itToolsAPI.listTools({ signal });
      if (signal?.aborted) return;
      setTools(response.tools || []);
      setIsAdmin(!!response.isAdmin);
      if (response.isAdmin) {
        const userResponse = await authAPI.getAdminAllUsers({ signal });
        if (signal?.aborted) return;
        setUsers((userResponse.users || []).filter((user) => !user.isDeleted));
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

  const handleSaveCredential = async (event) => {
    event.preventDefault();
    const toolId = credentialForm.toolId || selectedTool?.id;
    if (!toolId) {
      setError('Choose a tool before saving credentials.');
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

        const results = await Promise.allSettled(
          selectedUserIds.map((userId) => itToolsAPI.upsertCredential(toolId, {
            scope: 'user',
            user_id: userId,
            login_identifier: credentialForm.login_identifier,
            password: credentialForm.password,
            notes: credentialForm.notes,
          }))
        );

        const failedResults = results.filter((result) => result.status === 'rejected');
        const successCount = results.length - failedResults.length;

        if (!successCount) {
          throw failedResults[0]?.reason;
        }

        if (failedResults.length) {
          const firstFailure = failedResults[0]?.reason;
          setError(firstFailure?.response?.data?.detail || 'Some user assignments could not be saved.');
          setNotice(`Credential saved for ${successCount} user${successCount === 1 ? '' : 's'}.`);
        } else {
          setCredentialForm({
            ...EMPTY_CREDENTIAL_FORM,
            toolId: `${toolId}`,
            scope: 'user',
          });
          setNotice(`Credential saved for ${successCount} user${successCount === 1 ? '' : 's'}.`);
        }
      } else {
        await itToolsAPI.upsertCredential(toolId, {
          scope: credentialForm.scope,
          user_id: null,
          login_identifier: credentialForm.login_identifier,
          password: credentialForm.password,
          notes: credentialForm.notes,
        });
        setCredentialForm({ ...EMPTY_CREDENTIAL_FORM, toolId: `${toolId}` });
        setNotice('Credential saved securely.');
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
      });
      await loadMailboxConfig(toolId);
      setNotice('OTP mailbox settings saved.');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save OTP mailbox settings.');
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
        setNotice(response.message || 'OTP mailbox connected successfully.');
      } else {
        setError(response.message || 'OTP mailbox test failed.');
      }
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to test OTP mailbox.');
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
    const confirmed = window.confirm(`Remove OTP mailbox settings for ${tool?.name || 'this tool'}?`);
    if (!confirmed) return;

    setMailboxBusy(true);
    setError('');
    setNotice('');
    try {
      await itToolsAPI.deleteMailboxConfig(toolId);
      setMailboxForm({ ...EMPTY_MAILBOX_FORM, toolId });
      setMailboxMeta({ exists: false, appPasswordSet: false });
      setNotice('OTP mailbox settings removed.');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to delete OTP mailbox settings.');
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
        const launchDetail = {
          toolSlug: response.tool.slug,
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
        const launchStored = await waitForExtensionLaunchStored(response.tool.slug);
        if (!launchStored.ok) {
          throw new Error(launchStored.error || 'Extension launch bridge did not respond.');
        }
        launchUrl = resolveExtensionLaunchUrl(response.launchUrl, response.extensionTicket, response.tool.slug);
        if (`${response.tool.slug}`.trim().toLowerCase() === 'flow') {
          const isolatedResult = await openFlowInIsolatedWindow({
            toolSlug: response.tool.slug,
            launchUrl,
          });
          if (!isolatedResult.ok) {
            throw new Error(isolatedResult.error || 'Unable to open Flow in an isolated window.');
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
                  <option value="extension_autofill">Extension auto-fill (ChatGPT/OpenAI, Envato, Freepik, Higgsfield, Kling AI, Flow)</option>
                  <option value="automation">Auto-login form submit</option>
                </select>
              </div>
              {toolForm.launch_mode === 'extension_autofill' && (
                <p className="it-card-copy">
                  The current browser extension build supports ChatGPT/OpenAI, Envato, Freepik, Higgsfield, Kling AI, and a starter Flow
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

            <form className="it-admin-card" onSubmit={handleSaveCredential} autoComplete="off">
              <div className="it-admin-card-header">
                <div>
                  <h2>Add Password</h2>
                  <p className="it-card-copy">Store the assigned company credential securely for extension autofill and manual launch support.</p>
                </div>
                <span>Encrypted</span>
              </div>
              <div className="it-form-grid">
                <select
                  value={credentialForm.toolId || selectedTool?.id || ''}
                  onChange={(e) => setCredentialForm({ ...credentialForm, toolId: e.target.value })}
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
                    ...credentialForm,
                    scope: e.target.value,
                    user_ids: e.target.value === 'user' ? credentialForm.user_ids : [],
                  })}
                >
                  <option value="company">Company credential</option>
                  <option value="user">Specific user</option>
                </select>
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
                  </div>
                )}
                <input value={credentialForm.login_identifier} onChange={(e) => setCredentialForm({ ...credentialForm, login_identifier: e.target.value })} placeholder="Username / email" autoComplete="off" spellCheck={false} />
                <input type="password" value={credentialForm.password} onChange={(e) => setCredentialForm({ ...credentialForm, password: e.target.value })} placeholder="Password" autoComplete="new-password" />
              </div>
              <textarea value={credentialForm.notes} onChange={(e) => setCredentialForm({ ...credentialForm, notes: e.target.value })} placeholder="Internal notes optional" autoComplete="off" />
              <button className="it-primary-btn" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Credential'}</button>
            </form>

            <form className="it-admin-card" onSubmit={handleSaveMailbox} autoComplete="off">
              <div className="it-admin-card-header">
                <div>
                  <h2>OTP Mailbox</h2>
                  <p className="it-card-copy">Manage the Gmail inbox used for OTP codes so you can swap the tool email quickly whenever access changes.</p>
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
              </div>
              <p className="it-mailbox-summary">
                {mailboxMeta.exists
                  ? `Mailbox saved for this tool${mailboxMeta.appPasswordSet ? ' with an app password on file.' : '.'}`
                  : 'No OTP mailbox saved for this tool yet.'}
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
