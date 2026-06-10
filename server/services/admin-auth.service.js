const { hashPassword, verifyPassword, validateEmail, validatePassword } = require('./app-auth.service');
const { permissionsForRole, hasPermission } = require('../config/admin-roles');

function setAdminSession(req, admin) {
    req.session.isAdmin = true;
    req.session.adminId = admin.id;
    req.session.adminEmail = admin.email;
    req.session.adminName = admin.name || admin.email;
    req.session.adminRole = admin.role || 'admin';
}

function clearAdminSession(req) {
    req.session.isAdmin = false;
    delete req.session.adminId;
    delete req.session.adminEmail;
    delete req.session.adminName;
    delete req.session.adminRole;
}

function setLegacyAdminSession(req) {
    req.session.isAdmin = true;
    req.session.adminId = null;
    req.session.adminEmail = '';
    req.session.adminName = 'Administrator';
    req.session.adminRole = 'super_admin';
}

function sessionAdminPayload(req) {
    const role = req.session?.adminRole || 'super_admin';
    return {
        id: req.session?.adminId || null,
        email: req.session?.adminEmail || '',
        name: req.session?.adminName || 'Administrator',
        role,
        roleLabel: require('../config/admin-roles').ROLES[role]?.label || role,
        permissions: permissionsForRole(role),
        legacy: !req.session?.adminId
    };
}

function requirePermission(perm) {
    return (req, res, next) => {
        if (!req.session?.isAdmin) {
            return res.status(401).json({ error: 'Unauthorized', redirect: '/admin' });
        }
        const role = req.session.adminRole || 'super_admin';
        if (!hasPermission(role, perm)) {
            return res.status(403).json({ error: 'Insufficient permissions', required: perm });
        }
        next();
    };
}

module.exports = {
    hashPassword,
    verifyPassword,
    validateEmail,
    validatePassword,
    setAdminSession,
    clearAdminSession,
    setLegacyAdminSession,
    sessionAdminPayload,
    requirePermission,
    hasPermission
};
