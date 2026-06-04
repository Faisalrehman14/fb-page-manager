(function () {
  async function getCsrf() {
    const r = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    const d = await r.json();
    return d.csrfToken || d.token || '';
  }

  function showError(msg) {
    const el = document.getElementById('authError');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function bindPasswordToggles() {
    document.querySelectorAll('[data-pw-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-pw-toggle');
        const input = document.getElementById(id);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? '<i class="fa-solid fa-eye-slash"></i>' : '<i class="fa-solid fa-eye"></i>';
      });
    });
  }

  async function handleSignup(e) {
    e.preventDefault();
    const btn = document.getElementById('authSubmit');
    if (btn) btn.disabled = true;
    showError('');
    try {
      const csrf = await getCsrf();
      const body = {
        firstName: document.getElementById('firstName')?.value,
        lastName: document.getElementById('lastName')?.value,
        email: document.getElementById('email')?.value,
        password: document.getElementById('password')?.value,
        confirmPassword: document.getElementById('confirmPassword')?.value,
        referralName: document.getElementById('referral')?.value
      };
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      window.location.href = data.redirect || '/';
    } catch (err) {
      showError(err.message || 'Registration failed');
      if (btn) btn.disabled = false;
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('authSubmit');
    if (btn) btn.disabled = true;
    showError('');
    try {
      const csrf = await getCsrf();
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
          email: document.getElementById('email')?.value,
          password: document.getElementById('password')?.value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      const next = new URLSearchParams(window.location.search).get('next');
      if (next === 'connect' && !data.facebookConnected) {
        window.location.href = '/?connect=1';
        return;
      }
      window.location.href = data.redirect || '/';
    } catch (err) {
      showError(err.message || 'Login failed');
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindPasswordToggles();
    const form = document.getElementById('authForm');
    const mode = form?.getAttribute('data-mode');
    if (form && mode === 'signup') form.addEventListener('submit', handleSignup);
    if (form && mode === 'login') form.addEventListener('submit', handleLogin);
  });
})();
