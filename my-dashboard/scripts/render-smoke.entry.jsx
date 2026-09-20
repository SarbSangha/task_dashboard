/**
 * Render smoke test — catches "white screen of death" regressions.
 *
 * Actually renders components. A provider that throws takes down every
 * route, and the two ways that happens are invisible to both ESLint and
 * `vite build`:
 *
 *   1. Temporal dead zone — reading a `const` (usually a handler defined
 *      lower in the component) during render, not inside an effect. Ships
 *      as "Cannot access 'x' before initialization", minified to a single
 *      letter, and blanks the app. This check exists because exactly that
 *      reached production from AuthContext.
 *   2. A module-scope or render-time throw anywhere in the import graph.
 *
 * Server rendering runs the component body and the first render pass, so
 * it catches those. It does NOT run effects or event handlers — a bug that
 * only fires on click still needs a real browser.
 *
 * Add a case here whenever a provider or a substantial screen is added.
 * Run: npm run smoke:render
 */
import './render-smoke.stubs.js';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { CustomDialogProvider } from '../src/components/common/CustomDialogs.jsx';
import AdminSectionAccessTab from '../src/components/leftsidebar/compofleftsidebar/adminqueue/AdminSectionAccessTab.jsx';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/context/AuthContext.jsx';
import FunctionalMenu from '../src/components/leftsidebar/Leftside.jsx';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = React.createElement;

// A user list shaped like /api/admin/all-users, covering the states the
// Section Access tab branches on: granted, ungranted, admin (exempt),
// inactive, deleted (must be filtered out), and — deliberately — a row
// with no featureAccess at all, which is what a client holding a cached
// response from before this feature shipped would see.
const users = [
  { id: 1, name: 'Granted User', email: 'g@x.com', department: 'Design', isActive: true, isAdmin: false, isDeleted: false, featureAccess: { rmw_data: true, buffer: false }, isFeatureExempt: false },
  { id: 2, name: 'Plain User', email: 'p@x.com', department: null, isActive: true, isAdmin: false, isDeleted: false, featureAccess: { rmw_data: false, buffer: false }, isFeatureExempt: false },
  { id: 3, name: 'The Admin', email: 'a@x.com', department: 'IT', isActive: true, isAdmin: true, isDeleted: false, featureAccess: { rmw_data: true, buffer: true }, isFeatureExempt: true },
  { id: 4, name: 'Inactive User', email: 'i@x.com', department: 'Ops', isActive: false, isAdmin: false, isDeleted: false, featureAccess: { rmw_data: false, buffer: true }, isFeatureExempt: false },
  { id: 5, name: 'Deleted User', email: 'd@x.com', department: 'Ops', isActive: false, isAdmin: false, isDeleted: true, featureAccess: { rmw_data: false, buffer: false }, isFeatureExempt: false },
  { id: 6, name: 'Legacy Cached', email: 'l@x.com', department: 'Sales', isActive: true, isAdmin: false, isDeleted: false },
];

const withDialogs = (node) => h(CustomDialogProvider, null, node);

// Renders the sidebar at a given route as a given user, without hitting
// the network: AuthContext is supplied directly rather than via
// AuthProvider so each permission shape can be pinned.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const sidebarAs = (authUser, route) => () =>
  h(QueryClientProvider, { client: queryClient },
    h(MemoryRouter, { initialEntries: [route] },
    h(AuthContext.Provider, {
      value: {
        user: authUser, loading: false, authIssue: null,
        login: () => {}, logout: () => {}, register: () => {},
        checkAuth: () => {}, updateUser: () => {}, clearAvatarCache: () => {},
        activity: {},
      },
    }, withDialogs(h(FunctionalMenu, null)))));

const granted = { id: 1, name: 'G', email: 'g@x', position: 'employee', isActive: true, featureAccess: { rmw_data: true, buffer: true } };
const ungranted = { id: 2, name: 'U', email: 'u@x', position: 'employee', isActive: true, featureAccess: { rmw_data: false, buffer: false } };
const legacy = { id: 3, name: 'L', email: 'l@x', position: 'employee', isActive: true };

const cases = [
  ['AuthProvider', () => h(AuthProvider, null, h('div', null, 'ok'))],

  ['AdminSectionAccessTab (populated)', () => withDialogs(
    h(AdminSectionAccessTab, { users, setUsers: () => {}, onViewInfo: () => {}, loading: false }, 'ok')
  )],

  // The states that most often crash a table: nothing to show, and the
  // in-flight load before data arrives.
  ['AdminSectionAccessTab (empty)', () => withDialogs(
    h(AdminSectionAccessTab, { users: [], setUsers: () => {}, onViewInfo: () => {}, loading: false }, 'ok')
  )],
  ['AdminSectionAccessTab (loading)', () => withDialogs(
    h(AdminSectionAccessTab, { users: [], setUsers: () => {}, onViewInfo: () => {}, loading: true }, 'ok')
  )],

  // The sidebar across the permission shapes it branches on, including
  // landing directly on a gated route while ungranted (the redirect path).
  ['Sidebar (granted) shows both entries', sidebarAs(granted, '/dashboard'), (html) => {
    if (!html.includes('RMW Data')) throw new Error('granted user is missing the RMW Data entry');
    if (!html.includes('Buffer')) throw new Error('granted user is missing the Buffer entry');
  }],
  ['Sidebar (ungranted) hides both entries', sidebarAs(ungranted, '/dashboard'), (html) => {
    if (html.includes('RMW Data')) throw new Error('RMW Data leaked to an ungranted user');
    if (html.includes('Buffer')) throw new Error('Buffer leaked to an ungranted user');
    if (html.includes('Insight')) throw new Error('empty Insight section header left behind');
  }],
  ['Sidebar (ungranted) deep-link /dashboard/buffer stays hidden', sidebarAs(ungranted, '/dashboard/buffer'), (html) => {
    if (html.includes('Buffer')) throw new Error('Buffer reachable by URL while ungranted');
  }],
  ['Sidebar (ungranted) deep-link /dashboard/trendings stays hidden', sidebarAs(ungranted, '/dashboard/trendings'), (html) => {
    if (html.includes('RMW Data')) throw new Error('RMW Data reachable by URL while ungranted');
  }],
  ['Sidebar (granted) /dashboard/buffer', sidebarAs(granted, '/dashboard/buffer')],
  ['Sidebar (no featureAccess field) hides both', sidebarAs(legacy, '/dashboard'), (html) => {
    if (html.includes('RMW Data') || html.includes('Buffer')) {
      throw new Error('a user object without featureAccess must fall back to hidden');
    }
  }],
];

let failed = 0;
for (const [name, make, assert] of cases) {
  try {
    const html = renderToString(make());
    if (!html || html.length < 10) throw new Error('rendered empty output');
    if (assert) assert(html);
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error?.constructor?.name}: ${error?.message}`);
    if (error?.stack) console.log(error.stack.split('\n').slice(1, 4).join('\n'));
  }
}

console.log(
  failed
    ? `\nrender smoke: ${failed} of ${cases.length} failed`
    : `\nrender smoke: ${cases.length} passed`
);
process.exitCode = failed ? 1 : 0;
