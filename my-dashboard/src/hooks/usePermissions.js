import { useAuth } from '../context/AuthContext';

const PERMISSION_MATRIX = {
  approve_signups: ['admin'],
  view_company_members: ['admin', 'faculty'],
  create_tasks: ['admin', 'faculty', 'user'],
  revoke_tasks: ['admin', 'faculty'],
  view_admin_queue: ['admin'],
  access_workspace: ['admin', 'faculty', 'user'],
  download_rmw_data: ['admin', 'faculty', 'hod', 'spoc', 'employee', 'user'],
  view_kling_generations: ['admin', 'faculty', 'hod', 'spoc', 'employee', 'user'],
  view_kling_analytics: ['admin', 'faculty'],
};

/**
 * Sidebar sections that are hidden unless an admin grants them per user.
 *
 * These deliberately sit OUTSIDE PERMISSION_MATRIX: that matrix answers
 * "does this role do X", while these answer "was this person given X",
 * which no role can imply. The server sends the grants on the user as
 * `featureAccess` (see backend/services/feature_access_service.py) and
 * enforces them on the matching endpoints - what follows only decides
 * whether the UI is drawn.
 *
 * Keys mirror GATED_FEATURES in feature_access_service.py.
 */
export const FEATURE_PERMISSIONS = {
  view_rmw_data: 'rmw_data',
  view_buffer: 'buffer',
};

export function normalizeRoles(user) {
  const roles = new Set(
    Array.isArray(user?.roles)
      ? user.roles.map((role) => String(role).trim().toLowerCase()).filter(Boolean)
      : []
  );

  const position = String(user?.position || '').trim().toLowerCase();
  if (user?.isAdmin || position === 'admin' || position.includes('admin')) {
    roles.add('admin');
  }
  if (position.includes('faculty')) {
    roles.add('faculty');
  }
  if (position.includes('hod') || position.includes('head of department')) {
    roles.add('hod');
  }
  if (position.includes('spoc')) {
    roles.add('spoc');
  }
  if (position.includes('employee') || position.includes('user')) {
    roles.add('employee');
  }

  if (roles.has('employee') || roles.has('hod') || roles.has('spoc') || roles.has('faculty') || roles.has('admin')) {
    roles.add('user');
  }

  return Array.from(roles);
}

export function resolvePermissionSnapshot(user) {
  const roles = normalizeRoles(user);
  const roleSet = new Set(roles);
  const hasApprovedLoginAccess = Boolean(user && user.isActive !== false && user.isDeleted !== true);

  const isAdmin = roleSet.has('admin');
  const featureAccess = user?.featureAccess || {};

  return {
    roles,
    isAdmin,
    isFaculty: isAdmin || roleSet.has('faculty'),
    isUser: roleSet.has('user') || isAdmin || roleSet.has('faculty'),
    featureAccess,
    can: (action) => {
      // Per-user grants, checked before the role matrix. Deny-by-default:
      // a missing/absent flag means "not granted", so a stale client that
      // has not yet re-fetched the user hides the section rather than
      // flashing it.
      //
      // Deliberately does NOT fall back to the local isAdmin: that one
      // also counts a position string containing "admin", while the server
      // only counts the is_admin flag and explicit role rows. Trusting the
      // local flag here would show the section to someone the API then
      // answers with 403. The server already reports True for both
      // sections on a real admin, so reading its answer covers the admin
      // bypass without re-deriving it.
      const feature = FEATURE_PERMISSIONS[action];
      if (feature) {
        if (!hasApprovedLoginAccess) return false;
        return featureAccess[feature] === true;
      }
      if ((action === 'download_rmw_data' || action === 'view_kling_generations') && !hasApprovedLoginAccess) {
        return false;
      }
      const allowed = PERMISSION_MATRIX[action] || [];
      return allowed.some((role) => roleSet.has(role));
    },
  };
}

export function usePermissions() {
  const { user } = useAuth();
  return resolvePermissionSnapshot(user);
}

export { PERMISSION_MATRIX };
