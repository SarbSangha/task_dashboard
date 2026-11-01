import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import { useAuth } from '../../../../context/AuthContext';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCacheEntry,
  invalidateTaskPanelCache,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import { formatDateTimeIndia } from '../../../../utils/dateTime';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../../../utils/isMobileViewport';
import WindowControls from '../../../common/WindowControls';
import WorkplacePolicyPanel from './WorkplacePolicyPanel';
import AdminSectionAccessTab from './AdminSectionAccessTab';
import AdminSheetAccessTab from './AdminSheetAccessTab';
import AdminLoginTab from './AdminLoginTab';
import AdminPendingTab from './AdminPendingTab';
import AdminPasswordTab from './AdminPasswordTab';
import AdminClientsTab from './AdminClientsTab';
import AdminToolRenewalsTab from './AdminToolRenewalsTab';
import AdminCreditPricingTab from './AdminCreditPricingTab';
import UserDetailDrawer from './UserDetailDrawer';
import './AdminRequestPanel.css';

const CACHE_TTL = 90_000;

const TABS = [
  { id: 'approvals', label: 'Pending Approvals' },
  { id: 'login',     label: 'Login Access' },
  { id: 'passwords', label: 'Password Requests' },
  { id: 'policies',  label: 'Workplace Policies' },
  { id: 'sections',  label: 'Section Access' },
  { id: 'sheets',    label: 'Sheet Access' },
  { id: 'clients',   label: 'Manage Clients' },
  { id: 'renewals',  label: 'Tool Renewals' },
  { id: 'pricing',   label: 'Credit Pricing' },
];

// Each stat opens the tab (and, for Login Access, the filter) it summarises.
const STAT_DEFS = [
  { key: 'total',     label: 'Users',        mod: '',        tab: 'login',     loginFilter: 'all' },
  { key: 'active',    label: 'Active',       mod: 'success', tab: 'login',     loginFilter: 'active' },
  { key: 'disabled',  label: 'Disabled',     mod: 'warning', tab: 'login',     loginFilter: 'inactive' },
  { key: 'admins',    label: 'Admins',       mod: 'info',    tab: 'login',     loginFilter: 'admin' },
  { key: 'policyOn',  label: 'Policy On',    mod: 'policy',  tab: 'policies' },
  { key: 'approvals', label: 'Approvals',    mod: 'alert',   tab: 'approvals' },
  { key: 'passwords', label: 'Pwd Requests', mod: 'alert',   tab: 'passwords' },
];

// Tabs that read the header search box. The others (policies, sections,
// sheets) have their own search field, and pricing has nothing to search, so
// the header box is hidden there instead of sitting on screen doing nothing.
const HEADER_SEARCH_PLACEHOLDERS = {
  approvals: 'Search requests by name, email or department…',
  login: 'Search users by name, email, ID or department…',
  passwords: 'Search users by name, email or department…',
  clients: 'Search clients…',
  renewals: 'Search tools…',
};

const fmtTime = (ts) => {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};

const AdminRequestPanel = ({ isOpen, onClose, onMinimizedChange, onActivate }) => {
  const { user: currentUser } = useAuth();
  const { showConfirm, showPrompt } = useCustomDialogs();

  const [loading, setLoading]         = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cacheStatus, setCacheStatus] = useState({ showingCached: false, cachedAt: 0, liveUpdatedAt: 0 });
  const [requests, setRequests]       = useState([]);
  const [users, setUsers]             = useState([]);
  const [activeTab, setActiveTab]     = useState('approvals');
  const [search, setSearch]           = useState('');
  const [message, setMessage]         = useState('');
  const [drawerUser, setDrawerUser]   = useState(null);
  const [loginFilterRequest, setLoginFilterRequest] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);

  const minimizedStyle = useMinimizedWindowStack('admin-queue-panel', isOpen && isMinimized);
  const refreshTimer   = useRef(null);

  const cacheKey = useMemo(
    () => (currentUser?.id ? buildTaskPanelCacheKey(currentUser.id, 'admin_queue') : null),
    [currentUser?.id],
  );

  useEffect(() => { onMinimizedChange?.(isOpen && isMinimized); }, [isMinimized, isOpen, onMinimizedChange]);

  const fmt = useCallback((v) => { const r = formatDateTimeIndia(v); return r === 'N/A' ? 'N/A' : r; }, []);

  // Opening the panel, the socket connecting, window focus and the 3-minute
  // timer can all start a load at once. Only the newest one may update the
  // screen, and a failed background refresh must not paint an error bar over
  // data that is already showing.
  const loadSeqRef = useRef(0);
  const hasDataRef = useRef(false);
  const loadData = useCallback(async ({ silent = false } = {}) => {
    if (!cacheKey) return;
    const seq = ++loadSeqRef.current;
    silent ? setIsRefreshing(true) : setLoading(true);
    try {
      const [rr, ur] = await Promise.all([authAPI.getAdminPendingRequests(), authAPI.getAdminAllUsers()]);
      if (seq !== loadSeqRef.current) return;
      const reqs = rr?.requests || [];
      const usrs = ur?.users   || [];
      setRequests(reqs);
      setUsers(usrs);
      hasDataRef.current = true;
      setTaskPanelCache(cacheKey, { requests: reqs, users: usrs });
      setCacheStatus((p) => ({ showingCached: false, cachedAt: p.cachedAt, liveUpdatedAt: Date.now() }));
      setMessage('');
    } catch (e) {
      console.warn('Admin queue load failed:', e);
      if (seq !== loadSeqRef.current) return;
      if (silent && hasDataRef.current) return;
      setMessage(e?.response?.data?.detail || 'Could not load admin data. Check your connection and try again.');
    } finally {
      if (seq === loadSeqRef.current) {
        setIsRefreshing(false);
        setLoading(false);
      }
    }
  }, [cacheKey]);

  const reload = useCallback(async () => {
    if (cacheKey) invalidateTaskPanelCache(cacheKey);
    await loadData({ silent: true });
  }, [cacheKey, loadData]);

  useEffect(() => {
    if (!isOpen || !cacheKey) return;
    setIsMinimized(false);
    setIsMaximized(isMobileViewport());
    const entry  = getTaskPanelCacheEntry(cacheKey, CACHE_TTL);
    const cached = entry?.value;
    if (Array.isArray(cached?.requests)) setRequests(cached.requests);
    if (Array.isArray(cached?.users))    setUsers(cached.users);
    if (cached?.requests || cached?.users) hasDataRef.current = true;
    if (cached?.requests || cached?.users) {
      setCacheStatus({ showingCached: true, cachedAt: entry?.cachedAt || 0, liveUpdatedAt: 0 });
    }
    void loadData({ silent: !!(cached?.requests || cached?.users) });
  }, [cacheKey, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const schedule = () => {
      if (refreshTimer.current) return;
      refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; loadData({ silent: true }); }, 250);
    };
    const unsub = subscribeRealtimeNotifications({
      onMessage: (p) => { if ((p?.eventType || '').startsWith('admin_')) schedule(); },
      onOpen: schedule,
    });
    const iv = window.setInterval(() => { if (document.visibilityState === 'visible') loadData({ silent: true }); }, 180_000);
    window.addEventListener('focus', schedule);
    return () => {
      unsub(); window.clearInterval(iv); window.removeEventListener('focus', schedule);
      if (refreshTimer.current) { window.clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    };
  }, [cacheKey, isOpen, loadData]);

  if (!isOpen) return null;

  const minimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); }
    else { setIsMinimized(true); }
  };
  const maximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); }
    else setIsMaximized((p) => !p);
  };

  const liveUsers    = users.filter((u) => !u.isDeleted);
  const approvalReqs = requests.filter((r) => r.requestType !== 'password_change');
  const passwordReqs = requests.filter((r) => r.requestType === 'password_change');

  const stats = {
    total:     liveUsers.length,
    // Same buckets as the Login Access filters, so 41 + 2 + 1 adds up to Users.
    active:    liveUsers.filter((u) =>  u.isActive && !u.isAdmin).length,
    disabled:  liveUsers.filter((u) => !u.isActive && !u.isAdmin).length,
    admins:    liveUsers.filter((u) =>  u.isAdmin).length,
    policyOn:  liveUsers.filter((u) => !u.isAdmin && u.enforceActiveTaskPolicy).length,
    approvals: approvalReqs.length,
    passwords: passwordReqs.length,
  };

  const tabBadge = (id) =>
    id === 'approvals' ? (stats.approvals || null) :
    id === 'passwords' ? (stats.passwords || null) : null;

  const switchTab = (id) => { setActiveTab(id); setSearch(''); };
  const openStat = ({ tab, loginFilter }) => {
    switchTab(tab);
    if (loginFilter) setLoginFilterRequest({ value: loginFilter, nonce: Date.now() });
  };
  const headerSearchPlaceholder = HEADER_SEARCH_PLACEHOLDERS[activeTab];

  const sharedProps = { showConfirm, showPrompt, setMessage, onViewUser: setDrawerUser, onReload: reload, formatDateTime: fmt };

  return (
    <>
      <div
        className={`aq-overlay${isMinimized ? ' aq-overlay--off' : ''}`}
        onClick={!isMinimized ? onClose : undefined}
      />
      <div
        className={`aq-panel${isMinimized ? ' aq-panel--min' : ''}${isMaximized ? ' aq-panel--max' : ''}`}
        style={minimizedStyle || undefined}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header
          className="aq-header"
          onClick={isMinimized ? () => { onActivate?.(); setIsMinimized(false); } : undefined}
        >
          <div className="aq-brand">
            <p className="aq-eyebrow">Admin Controls</p>
            <div className="aq-title-row">
              <h3 className="aq-title">Admin Queue</h3>
              {!isMinimized && (() => {
                if (isRefreshing) return (
                  <span className="aq-sync-pill aq-sync-pill--syncing" role="status" aria-label="Syncing data">
                    <span className="aq-sync-spinner" aria-hidden="true" />
                    Syncing…
                  </span>
                );
                if (cacheStatus.showingCached) return (
                  <span className="aq-sync-pill aq-sync-pill--cached" role="status" aria-label="Showing cached data">
                    <span className="aq-sync-dot" aria-hidden="true" />
                    Saved copy
                    {fmtTime(cacheStatus.cachedAt) && <span className="aq-sync-time">· {fmtTime(cacheStatus.cachedAt)}</span>}
                  </span>
                );
                if (cacheStatus.liveUpdatedAt) return (
                  <span className="aq-sync-pill aq-sync-pill--live" role="status" aria-label="Live data">
                    <span className="aq-sync-dot" aria-hidden="true" />
                    Synced
                    {fmtTime(cacheStatus.liveUpdatedAt) && <span className="aq-sync-time">{fmtTime(cacheStatus.liveUpdatedAt)}</span>}
                  </span>
                );
                return null;
              })()}
            </div>
          </div>

          {!isMinimized && headerSearchPlaceholder && (
            <div className="aq-search-wrap">
              <svg className="aq-search-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                className="aq-search-input"
                placeholder={headerSearchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search admin queue"
              />
              {search && (
                <button type="button" className="aq-search-clear" onClick={() => setSearch('')} aria-label="Clear search">✕</button>
              )}
            </div>
          )}

          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={minimize}
            onMaximize={maximize}
            onClose={onClose}
          />
        </header>

        {!isMinimized && (
          <div className="aq-body">
            {/* ── Stat Cards ─────────────────────────────────────────────── */}
            <div className="aq-stats" role="region" aria-label="Summary statistics">
              {STAT_DEFS.map((def) => {
                const { key, label, mod, tab } = def;
                const val = stats[key];
                // "Alert" colours only mean something when there is work waiting.
                const effectiveMod = mod === 'alert' && !val ? '' : mod;
                const isAlert = mod === 'alert' && val > 0;
                const isCurrent = activeTab === tab && (!def.loginFilter || loginFilterRequest?.value === def.loginFilter);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`aq-stat${effectiveMod ? ` aq-stat--${effectiveMod}` : ''}${isAlert ? ' aq-stat--pulse' : ''}${isCurrent ? ' aq-stat--current' : ''}`}
                    onClick={() => openStat(def)}
                    aria-label={`${label}: ${val}. Show in ${TABS.find((t) => t.id === tab)?.label}`}
                    title={`Show in ${TABS.find((t) => t.id === tab)?.label}`}
                  >
                    <span className="aq-stat-n">{val}</span>
                    <span className="aq-stat-l">{label}</span>
                  </button>
                );
              })}
            </div>

            {/* ── Tabs ───────────────────────────────────────────────────── */}
            <nav className="aq-tabs" role="tablist" aria-label="Admin queue sections">
              {TABS.map((t) => {
                const b = tabBadge(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === t.id}
                    className={`aq-tab${activeTab === t.id ? ' aq-tab--active' : ''}`}
                    onClick={() => switchTab(t.id)}
                  >
                    {t.label}
                    {b != null && <span className="aq-tab-badge">{b}</span>}
                  </button>
                );
              })}
            </nav>

            {message && <div className="aq-error-bar" role="alert">{message}</div>}

            {/* ── Tab Content ────────────────────────────────────────────── */}
            <div className="aq-content" role="tabpanel">
              {activeTab === 'approvals' && (
                <AdminPendingTab
                  requests={approvalReqs}
                  search={search}
                  loading={loading}
                  formatDateTime={fmt}
                  onReview={async (requestId, approve) => {
                    const notes = (await showPrompt(
                      approve ? 'Approval note (optional):' : 'Reason for rejection (required):',
                      { title: approve ? 'Approve Request' : 'Reject Request', defaultValue: '' },
                    )) ?? '';
                    if (!approve && !notes.trim()) { setMessage('Rejection reason is required.'); return; }
                    try { await authAPI.reviewAdminRequest(requestId, approve, notes); await reload(); }
                    catch (e) { setMessage(e?.response?.data?.detail || 'Failed to review request'); }
                  }}
                />
              )}

              {activeTab === 'login' && (
                <AdminLoginTab
                  users={users}
                  setUsers={setUsers}
                  search={search}
                  loading={loading}
                  filterRequest={loginFilterRequest}
                  {...sharedProps}
                />
              )}

              {activeTab === 'passwords' && (
                <AdminPasswordTab
                  requests={passwordReqs}
                  users={users}
                  search={search}
                  loading={loading}
                  {...sharedProps}
                />
              )}

              {activeTab === 'policies' && (
                <WorkplacePolicyPanel
                  users={users}
                  setUsers={setUsers}
                  onViewInfo={setDrawerUser}
                  loading={loading}
                />
              )}

              {activeTab === 'sections' && (
                <AdminSectionAccessTab
                  users={users}
                  setUsers={setUsers}
                  onViewInfo={setDrawerUser}
                  loading={loading}
                />
              )}

              {activeTab === 'sheets' && (
                <AdminSheetAccessTab
                  users={users}
                  setUsers={setUsers}
                  onViewInfo={setDrawerUser}
                  loading={loading}
                />
              )}

              {activeTab === 'clients' && (
                <AdminClientsTab search={search} showConfirm={showConfirm} />
              )}

              {activeTab === 'renewals' && (
                <AdminToolRenewalsTab search={search} />
              )}

              {activeTab === 'pricing' && <AdminCreditPricingTab />}
            </div>
          </div>
        )}
      </div>

      {/* ── User Detail Drawer ─────────────────────────────────────────────── */}
      {drawerUser && (
        <UserDetailDrawer
          key={drawerUser.id}
          user={drawerUser}
          setUsers={setUsers}
          onClose={() => setDrawerUser(null)}
          showConfirm={showConfirm}
          showPrompt={showPrompt}
          setMessage={setMessage}
          onReload={async () => { setDrawerUser(null); await reload(); }}
          onRefresh={() => { void reload(); }}
          formatDateTime={fmt}
        />
      )}
    </>
  );
};

export default AdminRequestPanel;
