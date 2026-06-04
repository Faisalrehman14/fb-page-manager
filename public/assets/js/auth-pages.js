(function () {
  let otpSent = false;

  async function getCsrf() {
    const r = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    const d = await r.json();
    return d.csrfToken || d.token || '';
  }

  function setAlert(el, msg) {
    if (!el) return;
    const textEl = el.querySelector('.auth-alert-text') || el;
    if (!msg) {
      el.style.display = 'none';
      if (textEl !== el) textEl.textContent = '';
      else el.textContent = '';
      return;
    }
    if (textEl !== el) textEl.textContent = msg;
    else {
      const icon = el.querySelector('i');
      el.textContent = '';
      if (icon) el.appendChild(icon);
      const span = document.createElement('span');
      span.className = 'auth-alert-text';
      span.textContent = msg;
      el.appendChild(span);
    }
    el.style.display = 'flex';
  }

  function showError(msg) {
    setAlert(document.getElementById('authError'), msg);
    if (msg) setAlert(document.getElementById('authSuccess'), '');
  }

  function showSuccess(msg) {
    setAlert(document.getElementById('authSuccess'), msg);
    if (msg) setAlert(document.getElementById('authError'), '');
  }

  function setSignupStep(step) {
    const verify = document.getElementById('stepVerify');
    const account = document.getElementById('stepAccount');
    if (!verify || !account) return;
    verify.classList.remove('is-active', 'is-done');
    account.classList.remove('is-active', 'is-done');
    if (step === 'verify') {
      verify.classList.add('is-active');
    } else if (step === 'account') {
      verify.classList.add('is-done');
      account.classList.add('is-active');
    } else if (step === 'done') {
      verify.classList.add('is-done');
      account.classList.add('is-done');
    }
  }

  function revealOtpBlock(focus) {
    const block = document.getElementById('otpBlock');
    const placeholder = document.getElementById('otpPlaceholderHint');
    if (block) {
      block.classList.remove('is-hidden');
      block.classList.add('is-visible');
    }
    if (placeholder) placeholder.style.display = 'none';
    if (focus) document.getElementById('otp')?.focus();
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

  function bindOtpInput() {
    const otp = document.getElementById('otp');
    if (!otp) return;
    otp.addEventListener('input', function () {
      otp.value = otp.value.replace(/\D/g, '').slice(0, 6);
      if (otp.value.length === 6) setSignupStep('account');
    });
  }

  async function handleSendOtp() {
    const btn = document.getElementById('sendOtpBtn');
    const label = document.getElementById('sendOtpLabel');
    const emailEl = document.getElementById('email');
    const email = (emailEl?.value || '').trim();
    if (!email) {
      showError('Enter your email address first.');
      emailEl?.focus();
      return;
    }
    showError('');
    showSuccess('');
    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Sending…';
    try {
      const csrf = await getCsrf();
      const res = await fetch('/api/auth/register/send-otp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send code');
      otpSent = true;
      revealOtpBlock(true);
      setSignupStep('verify');
      const hint = document.getElementById('otpSentHint');
      if (hint) {
        hint.style.display = 'flex';
        hint.classList.add('is-success');
      }
      if (btn) btn.classList.add('is-sent');
      if (label) label.textContent = 'Resend code';
      showSuccess('Verification code sent to ' + email);
    } catch (err) {
      showError(err.message || 'Could not send verification code');
      if (label) label.textContent = 'Send code';
      if (btn) btn.classList.remove('is-sent');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleSignup(e) {
    e.preventDefault();
    const otp = (document.getElementById('otp')?.value || '').trim();
    if (!otpSent) {
      showError('Click Send code and enter the 6-digit code from your email.');
      revealOtpBlock(false);
      document.getElementById('email')?.focus();
      return;
    }
    if (!/^\d{6}$/.test(otp)) {
      showError('Enter the 6-digit verification code from your email.');
      revealOtpBlock(true);
      return;
    }
    const btn = document.getElementById('authSubmit');
    if (btn) btn.disabled = true;
    showError('');
    try {
      const csrf = await getCsrf();
      const body = {
        firstName: document.getElementById('firstName')?.value,
        lastName: document.getElementById('lastName')?.value,
        email: document.getElementById('email')?.value,
        otp: otp,
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
      setSignupStep('done');
      window.location.href = data.redirect || '/';
    } catch (err) {
      showError(err.message || 'Registration failed');
      if (/verification|code|otp/i.test(err.message || '')) {
        revealOtpBlock(true);
        setSignupStep('verify');
      }
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

      if (data.facebookConnected) {
        try {
          const boot = await fetch('/api/auth/bootstrap', { credentials: 'same-origin' });
          const b = await boot.json();
          if (b.authenticated && b.token) {
            localStorage.setItem('fb_user_token', JSON.stringify({
              token: b.token,
              expiresAt: Date.now() + (b.expiresIn || 5184000) * 1000
            }));
            if (b.userId) {
              localStorage.setItem('fbcast_user', JSON.stringify({
                fb_user_id: b.userId,
                fb_name: b.userName || '',
                name: b.userName || ''
              }));
            }
            if (b.pages && b.pages.length) {
              localStorage.setItem('fb_pages', JSON.stringify(b.pages));
            }
          }
        } catch (_) {}
      }

      try { sessionStorage.setItem('fbcast_just_logged_in', '1'); } catch (_) {}

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

  async function checkEmailService() {
    const sendBtn = document.getElementById('sendOtpBtn');
    try {
      const res = await fetch('/api/auth/email-status', { credentials: 'same-origin' });
      const data = await res.json();
      if (!data.ready) {
        if (sendBtn) sendBtn.disabled = true;
        showError(data.message || 'Email verification is not available yet.');
      } else {
        showError('');
        if (sendBtn) sendBtn.disabled = false;
      }
    } catch (_) {}
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindPasswordToggles();
    bindOtpInput();
    document.getElementById('sendOtpBtn')?.addEventListener('click', handleSendOtp);
    const form = document.getElementById('authForm');
    const mode = form?.getAttribute('data-mode');
    if (form && mode === 'signup') {
      checkEmailService();
      form.addEventListener('submit', handleSignup);
      document.getElementById('email')?.addEventListener('blur', function () {
        if (otpSent) return;
        const v = (document.getElementById('email')?.value || '').trim();
        if (v && v.includes('@')) setSignupStep('verify');
      });
    }
    if (form && mode === 'login') form.addEventListener('submit', handleLogin);
  });
})();
