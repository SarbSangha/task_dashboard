import { useAuth } from '../context/AuthContext';

const PERMISSION_MATRIX = {
  approve_signups: ['admin'],
  view_company_members: ['admin', 'faculty'],
  create_tasks: ['admin', 'faculty', 'user'],
  revoke_tasks: ['admin', 'faculty'],
  view_admin_queue: ['admin'],
  access_workspace: ['admin', 'faculty', 'user'],
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

  return {
    roles,
    isAdmin: roleSet.has('admin'),
    isFaculty: roleSet.has('admin') || roleSet.has('faculty'),
    isUser: roleSet.has('user') || roleSet.has('admin') || roleSet.has('faculty'),
    can: (action) => {
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
