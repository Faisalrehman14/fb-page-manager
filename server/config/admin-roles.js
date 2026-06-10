/** Admin panel roles and permissions (RBAC). */
const ROLES = {
    super_admin: {
        label: 'Super Admin',
        description: 'Full access to all admin features',
        permissions: ['*']
    },
    admin: {
        label: 'Administrator',
        description: 'Manage users, content, and most settings',
        permissions: [
            'dashboard', 'analytics', 'users.read', 'users.write',
            'activity', 'announcements', 'support', 'settings.read', 'settings.write'
        ]
    },
    support: {
        label: 'Support Agent',
        description: 'Support inbox and read-only user lookup',
        permissions: ['dashboard', 'users.read', 'activity', 'support']
    },
    analyst: {
        label: 'Analyst',
        description: 'Dashboard and analytics (read-only)',
        permissions: ['dashboard', 'analytics', 'activity', 'users.read']
    }
};

function normalizePermission(perm) {
    return String(perm || '').trim().toLowerCase();
}

function hasPermission(roleKey, perm) {
    const role = ROLES[roleKey];
    const p = normalizePermission(perm);
    if (!role || !p) return false;
    if (role.permissions.includes('*')) return true;
    if (role.permissions.includes(p)) return true;
    const base = p.split('.')[0];
    return role.permissions.some((x) => x === base || x.startsWith(`${base}.`));
}

function listRolesForAdmin() {
    return Object.entries(ROLES).map(([key, meta]) => ({
        key,
        label: meta.label,
        description: meta.description,
        permissions: meta.permissions
    }));
}

function permissionsForRole(roleKey) {
    const role = ROLES[roleKey];
    if (!role) return [];
    return role.permissions.includes('*') ? ['*'] : [...role.permissions];
}

module.exports = {
    ROLES,
    hasPermission,
    listRolesForAdmin,
    permissionsForRole
};
