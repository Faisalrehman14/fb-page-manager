/**
 * Admin panel extensions — Analytics, Settings, RBAC, Audit
 */
(function () {
  'use strict';

  function boot() {
    if (typeof App === 'undefined') {
      requestAnimationFrame(boot);
      return;
    }
    install();
  }

  function install() {

  const VIEW_PERMS = {
    dashboard: 'dashboard',
    analytics: 'analytics',
    users: 'users.read',
    activity: 'activity',
    audit: 'activity',
    announcements: 'announcements',
    support: 'support',
    access: '*',
    settings: 'settings.read',
    database: 'dashboard'
  };

  function can(perm) {
    const perms = App.adminSession?.permissions || ['*'];
    if (perms.includes('*')) return true;
    if (perms.includes(perm)) return true;
    const base = String(perm).split('.')[0];
    return perms.some((p) => p === base || p.startsWith(base + '.'));
  }

  function applyNavPermissions() {
    Object.keys(VIEW_PERMS).forEach((view) => {
      const el = document.getElementById('nav-' + view);
      if (!el) return;
      el.style.display = can(VIEW_PERMS[view]) ? '' : 'none';
    });
    const roleEl = document.querySelector('.sb-user-role');
    const nameEl = document.querySelector('.sb-user-name');
    const avEl = document.querySelector('.sb-user-av');
    if (App.adminSession) {
      if (roleEl) roleEl.textContent = App.adminSession.roleLabel || App.adminSession.role || 'Admin';
      if (nameEl) nameEl.textContent = App.adminSession.name || 'Administrator';
      if (avEl) avEl.textContent = (App.adminSession.name || 'A').charAt(0).toUpperCase();
    }
  }

  async function loadSession() {
    try {
      const r = await fetch('/api/admin/me');
      if (!r.ok) return false;
      const d = await r.json();
      App.adminSession = d.admin || null;
      App.adminRoles = d.roles || [];
      applyNavPermissions();
      return true;
    } catch (_) {
      return false;
    }
  }

  App.adminSession = null;
  App.adminRoles = [];

  App.analytics = {
    charts: {},
    async load() {
      const root = document.getElementById('analyticsRoot');
      if (!root) return;
      root.innerHTML = '<div class="loading-center"><span class="spinner spinner-lg"></span></div>';
      try {
        const r = await fetch('/api/admin/analytics');
        const d = await r.json();
        this.render(d);
      } catch (_) {
        root.innerHTML = '<div class="empty"><p>Could not load analytics</p></div>';
      }
    },
    render(d) {
      const root = document.getElementById('analyticsRoot');
      const ret = d.retention || {};
      root.innerHTML = `
        <div class="stats-grid stats-grid--4">
          <div class="stat-card c-blue"><div class="stat-label">Total users</div><div class="stat-value">${fmt(ret.total || 0)}</div></div>
          <div class="stat-card c-green"><div class="stat-label">Active (7d)</div><div class="stat-value">${fmt(ret.active7d || 0)}</div></div>
          <div class="stat-card c-indigo"><div class="stat-label">Active (30d)</div><div class="stat-value">${fmt(ret.active30d || 0)}</div></div>
          <div class="stat-card c-rose"><div class="stat-label">Suspended</div><div class="stat-value">${fmt(ret.suspended || 0)}</div></div>
        </div>
        <div class="charts-row">
          <div class="panel"><div class="panel-head"><div class="panel-title">Registrations (30d)</div></div>
            <div class="chart-wrap"><div class="chart-canvas-wrap" style="height:200px"><canvas id="anRegChart"></canvas></div></div></div>
          <div class="panel"><div class="panel-head"><div class="panel-title">Logins (30d)</div></div>
            <div class="chart-wrap"><div class="chart-canvas-wrap" style="height:200px"><canvas id="anLoginChart"></canvas></div></div></div>
        </div>
        <div class="charts-row">
          <div class="panel"><div class="panel-head"><div class="panel-title">Message sends (30d)</div></div>
            <div class="chart-wrap"><div class="chart-canvas-wrap" style="height:200px"><canvas id="anMsgChart"></canvas></div></div></div>
          <div class="panel"><div class="panel-head"><div class="panel-title">Broadcasts (30d)</div></div>
            <div class="chart-wrap"><div class="chart-canvas-wrap" style="height:200px"><canvas id="anBcastChart"></canvas></div></div></div>
        </div>`;
      this.lineChart('anRegChart', d.registrations || [], '#0866ff', 'registrations');
      this.lineChart('anLoginChart', d.logins || [], '#22c55e', 'logins');
      this.lineChart('anMsgChart', d.messages || [], '#f59e0b', 'messages');
      this.lineChart('anBcastChart', d.broadcasts || [], '#8b5cf6', 'broadcasts');
    },
    lineChart(id, raw, color, key) {
      if (typeof Chart === 'undefined') return;
      const data = fillDates(raw, 30);
      const canvas = document.getElementById(id);
      if (!canvas) return;
      if (this.charts[id]) this.charts[id].destroy();
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 0, 200);
      grad.addColorStop(0, color + '44');
      grad.addColorStop(1, color + '00');
      this.charts[id] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.map((x) => x.date.slice(5)),
          datasets: [{ data: data.map((x) => x.count), borderColor: color, backgroundColor: grad, fill: true, tension: 0.35, pointRadius: 0 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
            y: { ticks: { color: '#64748b', precision: 0 }, grid: { color: 'rgba(37,40,64,.5)' }, beginAtZero: true }
          }
        }
      });
    }
  };

  App.settings = {
    async load() {
      const root = document.getElementById('settingsRoot');
      if (!root) return;
      root.innerHTML = '<div class="loading-center"><span class="spinner spinner-lg"></span></div>';
      try {
        const r = await fetch('/api/admin/settings');
        const d = await r.json();
        this.render(d.settings || {});
      } catch (_) {
        root.innerHTML = '<div class="empty"><p>Settings unavailable</p></div>';
      }
    },
    render(s) {
      const canWrite = can('settings.write') || can('*');
      document.getElementById('settingsRoot').innerHTML = `
        <form id="settingsForm" class="settings-grid" onsubmit="event.preventDefault();App.settings.save()">
          <div class="panel card-pad">
            <div class="panel-title" style="margin-bottom:14px">General</div>
            <div class="form-grid">
              <div class="form-row full"><label class="form-label">Site name</label>
                <input class="form-input" name="site_name" value="${esc(s.site_name || 'FBCast Pro')}" ${canWrite ? '' : 'readonly'}></div>
              <div class="form-row"><label class="form-label">Support email</label>
                <input class="form-input" name="support_email" type="email" value="${esc(s.support_email || '')}" ${canWrite ? '' : 'readonly'}></div>
              <div class="form-row"><label class="form-label">Free trial (days)</label>
                <input class="form-input" name="free_trial_days" type="number" min="0" value="${esc(s.free_trial_days || '14')}" ${canWrite ? '' : 'readonly'}></div>
            </div>
          </div>
          <div class="panel card-pad">
            <div class="panel-title" style="margin-bottom:14px">Access control</div>
            <div class="form-grid">
              <div class="form-row"><label class="form-label">Allow signups</label>
                <select class="form-input" name="signup_enabled" ${canWrite ? '' : 'disabled'}>
                  <option value="1" ${s.signup_enabled !== '0' ? 'selected' : ''}>Enabled</option>
                  <option value="0" ${s.signup_enabled === '0' ? 'selected' : ''}>Disabled</option>
                </select></div>
              <div class="form-row"><label class="form-label">Default message limit</label>
                <input class="form-input" name="default_message_limit" type="number" value="${esc(s.default_message_limit || '2000')}" ${canWrite ? '' : 'readonly'}></div>
            </div>
          </div>
          <div class="panel card-pad">
            <div class="panel-title" style="margin-bottom:14px">Maintenance mode</div>
            <div class="form-grid">
              <div class="form-row"><label class="form-label">Maintenance</label>
                <select class="form-input" name="maintenance_mode" ${canWrite ? '' : 'disabled'}>
                  <option value="0" ${s.maintenance_mode !== '1' ? 'selected' : ''}>Off</option>
                  <option value="1" ${s.maintenance_mode === '1' ? 'selected' : ''}>On</option>
                </select></div>
              <div class="form-row full"><label class="form-label">Maintenance message</label>
                <textarea class="form-input form-textarea" name="maintenance_message" rows="2" ${canWrite ? '' : 'readonly'}>${esc(s.maintenance_message || '')}</textarea></div>
            </div>
          </div>
          ${canWrite ? '<div class="settings-actions"><button type="submit" class="btn btn-primary">Save settings</button></div>' : '<p class="settings-readonly-note">Read-only — contact a super admin to edit.</p>'}
        </form>`;
    },
    async save() {
      const form = document.getElementById('settingsForm');
      if (!form) return;
      const fd = new FormData(form);
      const settings = {};
      fd.forEach((v, k) => { settings[k] = v; });
      try {
        const r = await fetch('/api/admin/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Save failed');
        App.toast.show('Settings saved', 'success');
      } catch (e) {
        App.toast.show(e.message || 'Save failed', 'error');
      }
    }
  };

  App.access = {
    async load() {
      if (!can('*') && App.adminSession?.role !== 'super_admin') {
        document.getElementById('accessRoot').innerHTML =
          '<div class="empty"><p>Super admin access required</p></div>';
        return;
      }
      document.getElementById('accessRoot').innerHTML = '<div class="loading-center"><span class="spinner spinner-lg"></span></div>';
      try {
        const [adminsR, rolesR] = await Promise.all([fetch('/api/admin/admins'), fetch('/api/admin/roles')]);
        const adminsD = await adminsR.json();
        const rolesD = await rolesR.json();
        if (!adminsR.ok) throw new Error(adminsD.error || 'Failed');
        this.render(adminsD.admins || [], rolesD.roles || []);
      } catch (e) {
        document.getElementById('accessRoot').innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
      }
    },
    render(admins, roles) {
      const roleOpts = roles.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('');
      document.getElementById('accessRoot').innerHTML = `
        <div class="access-grid">
          <div class="panel card-pad">
            <div class="panel-title" style="margin-bottom:12px">Add admin user</div>
            <form id="addAdminForm" onsubmit="event.preventDefault();App.access.create()">
              <div class="form-grid">
                <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="newAdminName" required></div>
                <div class="form-row"><label class="form-label">Email</label><input class="form-input" id="newAdminEmail" type="email" required></div>
                <div class="form-row"><label class="form-label">Password</label><input class="form-input" id="newAdminPass" type="password" minlength="8" required></div>
                <div class="form-row"><label class="form-label">Role</label><select class="form-input" id="newAdminRole">${roleOpts}</select></div>
              </div>
              <button type="submit" class="btn btn-primary" style="margin-top:12px">Create admin</button>
            </form>
          </div>
          <div class="panel">
            <div class="panel-head"><div class="panel-title">Admin users &amp; roles</div></div>
            <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
            <tbody id="adminsBody">${admins.map((a) => this.row(a, roles)).join('')}</tbody></table></div>
          </div>
        </div>
        <div class="panel card-pad" style="margin-top:14px">
          <div class="panel-title" style="margin-bottom:10px">Role permissions</div>
          <div class="roles-grid">${roles.map((r) => `
            <div class="role-card"><div class="role-card__title">${esc(r.label)}</div>
            <div class="role-card__desc">${esc(r.description || '')}</div>
            <div class="role-card__perms">${(r.permissions || []).map((p) => `<span class="perm-chip">${esc(p)}</span>`).join('')}</div></div>`).join('')}</div>
        </div>`;
    },
    row(a, roles) {
      const roleOpts = roles.map((r) =>
        `<option value="${esc(r.key)}" ${a.role === r.key ? 'selected' : ''}>${esc(r.label)}</option>`
      ).join('');
      return `<tr>
        <td>${esc(a.name)}</td><td>${esc(a.email)}</td>
        <td><select class="form-input form-input--sm" onchange="App.access.updateRole(${a.id}, this.value)">${roleOpts}</select></td>
        <td><span class="status-chip ${a.is_active ? 'ok' : 'off'}">${a.is_active ? 'Active' : 'Disabled'}</span></td>
        <td style="font-size:12px;color:var(--muted)">${a.last_login_at ? fmtDate(a.last_login_at) : '—'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="App.access.toggleActive(${a.id}, ${a.is_active ? 0 : 1})">${a.is_active ? 'Disable' : 'Enable'}</button>
        ${App.adminSession?.id !== a.id ? `<button class="btn btn-danger btn-sm" onclick="App.access.remove(${a.id})">Delete</button>` : ''}</td></tr>`;
    },
    async create() {
      const body = {
        name: document.getElementById('newAdminName').value.trim(),
        email: document.getElementById('newAdminEmail').value.trim(),
        password: document.getElementById('newAdminPass').value,
        role: document.getElementById('newAdminRole').value
      };
      const r = await fetch('/api/admin/admins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) return App.toast.show(d.error || 'Failed', 'error');
      App.toast.show('Admin created', 'success');
      this.load();
    },
    async updateRole(id, role) {
      const r = await fetch('/api/admin/admins/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
      if (r.ok) App.toast.show('Role updated', 'success');
      else App.toast.show('Update failed', 'error');
    },
    async toggleActive(id, active) {
      const r = await fetch('/api/admin/admins/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !!active }) });
      if (r.ok) { App.toast.show('Updated', 'success'); this.load(); }
    },
    async remove(id) {
      if (!confirm('Delete this admin user?')) return;
      const r = await fetch('/api/admin/admins/' + id, { method: 'DELETE' });
      if (r.ok) { App.toast.show('Deleted', 'success'); this.load(); }
      else App.toast.show('Delete failed', 'error');
    }
  };

  App.audit = {
    page: 1,
    async load(p) {
      if (p) this.page = p;
      const list = document.getElementById('auditList');
      if (!list) return;
      list.innerHTML = '<div class="loading-center"><span class="spinner spinner-lg"></span></div>';
      try {
        const action = document.getElementById('auditFilter')?.value || '';
        const r = await fetch('/api/admin/audit?p=' + this.page + (action ? '&action=' + encodeURIComponent(action) : ''));
        const d = await r.json();
        this.render(d);
      } catch (_) {
        list.innerHTML = '<div class="empty"><p>Audit log unavailable</p></div>';
      }
    },
    render(d) {
      const list = document.getElementById('auditList');
      const logs = d.logs || [];
      if (!logs.length) {
        list.innerHTML = '<div class="empty"><p>No admin audit events</p></div>';
        return;
      }
      list.innerHTML = logs.map((l) => `
        <div class="activity-item audit-item">
          <div class="act-icon act-admin"><i class="fa-solid fa-shield-halved"></i></div>
          <div class="act-body">
            <div class="act-title">${esc(l.action)} <span class="act-user">${esc(l.admin_email || 'admin')}</span></div>
            <div class="act-detail">${esc(l.detail || l.target_type ? l.target_type + ': ' + (l.target_id || '') : '—')}</div>
            <div class="act-time">${fmtDate(l.created_at)}${l.ip_address ? ' · ' + esc(l.ip_address) : ''}</div>
          </div>
        </div>`).join('');
      const pg = document.getElementById('auditPagination');
      if (pg && d.pages > 1) {
        pg.style.display = 'flex';
        document.getElementById('auditPgInfo').textContent = `Page ${d.page} of ${d.pages} (${d.total} events)`;
        document.getElementById('auditPgBtns').innerHTML = [
          d.page > 1 ? `<button class="btn btn-ghost btn-sm" onclick="App.audit.load(${d.page - 1})">Prev</button>` : '',
          d.page < d.pages ? `<button class="btn btn-ghost btn-sm" onclick="App.audit.load(${d.page + 1})">Next</button>` : ''
        ].join('');
      } else if (pg) pg.style.display = 'none';
    }
  };

  App.users.setAccountStatus = async function (id, status) {
    try {
      const r = await fetch('/api/admin/users/' + encodeURIComponent(id) + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      App.toast.show(status === 'suspended' ? 'User suspended' : 'User activated', 'success');
      this.openDetail(id);
      this.load(null, true);
    } catch (e) {
      App.toast.show(e.message, 'error');
    }
  };

  const origSwitch = App.switchView.bind(App);
  App.switchView = function (v) {
    if (!can(VIEW_PERMS[v] || v)) {
      App.toast.show('You do not have permission for this section', 'error');
      return;
    }
    origSwitch(v);
    if (v === 'analytics') App.analytics.load();
    else if (v === 'settings') App.settings.load();
    else if (v === 'access') App.access.load();
    else if (v === 'audit') App.audit.load();
  };

  const origInit = App.init.bind(App);
  App.init = async function () {
    await loadSession();
    origInit();
  };

  window.AdminExtensions = { loadSession, can };
  }

  boot();
})();
