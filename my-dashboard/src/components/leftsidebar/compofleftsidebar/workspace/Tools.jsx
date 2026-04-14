import React, { useEffect, useMemo, useState } from 'react';
import { authAPI, itToolsAPI } from '../../../../services/api';
import './Tools.css';

const EXTENSION_LAUNCH_EVENT = 'rmw:tool-hub-extension-launch';
const EXTENSION_LAUNCH_STORED_EVENT = 'rmw:tool-hub-extension-launch-stored';
const EXTENSION_LAUNCH_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH';
const EXTENSION_LAUNCH_STORED_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH_STORED';

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
  user_id: '',
  login_identifier: '',
  password: '',
  notes: '',
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
    resolve();
    return;
  }

  let settled = false;
  const cleanup = () => {
    window.removeEventListener(EXTENSION_LAUNCH_STORED_EVENT, handleStored);
    window.removeEventListener('message', handleMessage);
    window.clearTimeout(timerId);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  };
  const handleStored = (event) => {
    const storedSlug = `${event.detail?.toolSlug || ''}`.trim().toLowerCase();
    if (storedSlug === normalizedSlug) {
      finish();
    }
  };
  const handleMessage = (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== 'rmw-tool-hub-extension') return;
    if (event.data?.type !== EXTENSION_LAUNCH_STORED_MESSAGE_TYPE) return;
    const storedSlug = `${event.data?.toolSlug || ''}`.trim().toLowerCase();
    if (storedSlug === normalizedSlug) {
      finish();
    }
  };
  const timerId = window.setTimeout(finish, 600);

  window.addEventListener(EXTENSION_LAUNCH_STORED_EVENT, handleStored);
  window.addEventListener('message', handleMessage);
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

export default function Tools() {
  const [tools, setTools] = useState([]);
  const [users, setUsers] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedTool, setSelectedTool] = useState(null);
  const [editToolId, setEditToolId] = useState('');
  const [toolForm, setToolForm] = useState(EMPTY_TOOL_FORM);
  const [credentialForm, setCredentialForm] = useState(EMPTY_CREDENTIAL_FORM);
  const [launchResult, setLaunchResult] = useState(null);

  const loadTools = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await itToolsAPI.listTools();
      setTools(response.tools || []);
      setIsAdmin(!!response.isAdmin);
      if (response.isAdmin) {
        const userResponse = await authAPI.getAdminAllUsers();
        setUsers((userResponse.users || []).filter((user) => !user.isDeleted));
      }
    } catch (err) {
      setError(err?.response?.data?.detail || 'Unable to load IT tools.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTools();
  }, []);

  const categories = useMemo(() => {
    return ['All', ...new Set(tools.map((tool) => tool.category || 'General'))];
  }, [tools]);

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
      await itToolsAPI.upsertCredential(toolId, {
        scope: credentialForm.scope,
        user_id: credentialForm.scope === 'user' ? Number(credentialForm.user_id) : null,
        login_identifier: credentialForm.login_identifier,
        password: credentialForm.password,
        notes: credentialForm.notes,
      });
      setCredentialForm({ ...EMPTY_CREDENTIAL_FORM, toolId: `${toolId}` });
      setNotice('Credential saved securely.');
      await loadTools();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save credential.');
    } finally {
      setSaving(false);
    }
  };

  const handleLaunchTool = async (tool) => {
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
        await waitForExtensionLaunchStored(response.tool.slug);
        launchUrl = buildExtensionLaunchUrl(response.launchUrl, response.extensionTicket, response.tool.slug);
      }
      if (launchUrl) {
        window.open(launchUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err?.response?.data?.detail || 'Unable to launch tool.');
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
                  <option value="extension_autofill">Extension auto-fill (ChatGPT/OpenAI, Freepik, Kling AI)</option>
                  <option value="automation">Auto-login form submit</option>
                </select>
              </div>
              {toolForm.launch_mode === 'extension_autofill' && (
                <p className="it-card-copy">
                  The current browser extension build supports ChatGPT/OpenAI, Freepik, and Kling AI login flows. For other tools,
                  use Manual credential or Auto-login form submit.
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
                <select value={credentialForm.scope} onChange={(e) => setCredentialForm({ ...credentialForm, scope: e.target.value })}>
                  <option value="company">Company credential</option>
                  <option value="user">Specific user</option>
                </select>
                {credentialForm.scope === 'user' && (
                  <select className="it-span-2" value={credentialForm.user_id} onChange={(e) => setCredentialForm({ ...credentialForm, user_id: e.target.value })} required>
                    <option value="">Choose user</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>{user.name} ({user.email})</option>
                    ))}
                  </select>
                )}
                <input value={credentialForm.login_identifier} onChange={(e) => setCredentialForm({ ...credentialForm, login_identifier: e.target.value })} placeholder="Username / email" autoComplete="off" spellCheck={false} />
                <input type="password" value={credentialForm.password} onChange={(e) => setCredentialForm({ ...credentialForm, password: e.target.value })} placeholder="Password" autoComplete="new-password" />
              </div>
              <textarea value={credentialForm.notes} onChange={(e) => setCredentialForm({ ...credentialForm, notes: e.target.value })} placeholder="Internal notes optional" autoComplete="off" />
              <button className="it-primary-btn" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Credential'}</button>
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
                <button key={tool.id} type="button" className="tool-card" onClick={() => handleLaunchTool(tool)}>
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
