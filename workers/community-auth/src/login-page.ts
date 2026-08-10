function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function loginPage(sitekey: string, initialStatus = '', authorizationRequestId = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>登录知远</title>
    <link rel="stylesheet" href="/assets/login.css?v=2">
    <script src="/assets/login.js?v=2" defer></script>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
  </head>
  <body data-turnstile-sitekey="${escapeHtmlAttribute(sitekey)}" data-authorization-request-id="${escapeHtmlAttribute(authorizationRequestId)}">
    <main class="shell" aria-labelledby="login-title">
      <section class="login-panel">
        <a class="brand" href="/login" aria-label="知远登录页">
          <span class="brand-mark" aria-hidden="true">✦</span><span>知远</span>
        </a>
        <header>
          <h1 id="login-title">登录知远</h1>
          <p>登录是可选的，不影响本地功能。</p>
        </header>

        <form id="email-form" novalidate>
          <label for="email">邮箱</label>
          <input id="email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" required>
          <p class="security-label">安全验证</p>
          <div class="cf-turnstile turnstile" data-sitekey="${escapeHtmlAttribute(sitekey)}" data-action="login-email-challenge" data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileExpired" data-error-callback="onTurnstileError" aria-label="安全验证"></div>
          <button id="send-code" type="submit">发送验证码</button>
        </form>

        <button id="offline" class="text-button" type="button">继续离线使用</button>

        <section id="code-panel" class="code-panel" hidden aria-labelledby="code-title">
          <div class="divider"><span>或</span></div>
          <h2 id="code-title">输入验证码</h2>
          <p id="sent-to">验证码已发送至你的邮箱。</p>
          <form id="code-form" novalidate>
            <div class="code-inputs" aria-label="6 位验证码">
              <input inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="1" aria-label="第 1 位验证码">
              <input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="第 2 位验证码">
              <input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="第 3 位验证码">
              <input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="第 4 位验证码">
              <input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="第 5 位验证码">
              <input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="第 6 位验证码">
            </div>
            <button id="verify-code" type="submit">验证并继续</button>
          </form>
        </section>

        <p id="status" class="status" role="status" aria-live="polite">${escapeHtmlAttribute(initialStatus)}</p>
        <p class="privacy">你的邮箱仅用于账号与登录安全，不影响任何本地功能。</p>
      </section>
    </main>
  </body>
</html>`;
}

export const LOGIN_CSS = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; color: #172033; background: #fff; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: radial-gradient(circle at -5% 68%, #eef4ff 0 11rem, transparent 11.1rem), radial-gradient(circle at 105% 34%, #eef4ff 0 13rem, transparent 13.1rem), #fff; }
.shell { min-height: 100vh; display: grid; place-items: center; padding: 48px 24px; }
.login-panel { width: min(100%, 390px); }
.brand { display: inline-flex; align-items: center; gap: 10px; color: #172033; font-weight: 760; font-size: 24px; letter-spacing: -0.04em; text-decoration: none; }
.brand-mark { display: grid; place-items: center; width: 34px; height: 34px; color: #fff; background: #2457e6; border-radius: 8px; font-size: 23px; line-height: 1; }
header { margin: 44px 0 30px; }
h1, h2, p { margin: 0; }
h1 { font-size: clamp(32px, 6vw, 40px); letter-spacing: -0.055em; line-height: 1.12; }
header p { margin-top: 12px; color: #64748b; font-size: 15px; line-height: 1.65; }
label, h2 { display: block; color: #253047; font-size: 14px; font-weight: 680; }
input { width: 100%; height: 48px; margin-top: 9px; padding: 0 13px; color: #172033; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; font-size: 15px; outline: none; transition: border-color .16s ease, box-shadow .16s ease; }
input::placeholder { color: #94a3b8; }
input:focus { border-color: #2457e6; box-shadow: 0 0 0 3px #dbe7ff; }
.security-label { margin-top: 19px; color: #253047; font-size: 14px; font-weight: 680; }
.turnstile { min-height: 65px; margin: 9px 0 18px; }
button { width: 100%; min-height: 48px; border: 0; border-radius: 8px; color: #fff; background: #2457e6; font: 650 15px/1 inherit; cursor: pointer; transition: background .16s ease, transform .16s ease; }
button:hover { background: #1d49c7; }
button:active { transform: translateY(1px); }
button:disabled { cursor: wait; opacity: .62; }
.text-button { margin-top: 18px; min-height: auto; color: #2457e6; background: transparent; }
.text-button:hover { color: #1d49c7; background: transparent; }
.code-panel { margin-top: 30px; }
.divider { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 14px; margin-bottom: 30px; color: #94a3b8; font-size: 13px; }
.divider::before, .divider::after { height: 1px; background: #e2e8f0; content: ""; }
.code-panel > p { margin-top: 8px; color: #64748b; font-size: 14px; line-height: 1.5; }
.code-inputs { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 20px 0; }
.code-inputs input { min-width: 0; height: 50px; margin: 0; padding: 0; text-align: center; font-size: 22px; font-variant-numeric: tabular-nums; }
.status { min-height: 22px; margin-top: 18px; color: #64748b; font-size: 14px; line-height: 1.5; }
.status[data-state="error"] { color: #b42318; }
.status[data-state="success"] { color: #087443; }
.privacy { margin-top: 32px; color: #64748b; font-size: 12px; line-height: 1.65; }
@media (max-width: 520px) { body { background: #fff; } .shell { align-items: start; padding: 36px 24px 48px; } header { margin-top: 38px; } .login-panel { width: 100%; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; } }
`;

export const LOGIN_JS = `
(() => {
  const state = { challengeId: '', token: '' };
  const emailForm = document.querySelector('#email-form');
  const codeForm = document.querySelector('#code-form');
  const email = document.querySelector('#email');
  const securityLabel = document.querySelector('.security-label');
  const turnstileContainer = document.querySelector('.turnstile');
  const sendButton = document.querySelector('#send-code');
  const verifyButton = document.querySelector('#verify-code');
  const codePanel = document.querySelector('#code-panel');
  const sentTo = document.querySelector('#sent-to');
  const status = document.querySelector('#status');
  const codeInputs = Array.from(document.querySelectorAll('.code-inputs input'));
  const authorizationRequestId = document.body.dataset.authorizationRequestId || '';

  const setStatus = (message, type = '') => { status.textContent = message; status.dataset.state = type; };
  const setBusy = (button, busy, label) => { button.disabled = busy; if (label) button.textContent = label; };
  const codeValue = () => codeInputs.map((input) => input.value).join('');
  const resetHumanCheck = () => { state.token = ''; if (window.turnstile && window.turnstile.reset) window.turnstile.reset(); };

  window.onTurnstileSuccess = (token) => { state.token = token; setStatus(''); };
  window.onTurnstileExpired = () => { state.token = ''; setStatus('安全验证已过期，请重新完成验证。', 'error'); };
  window.onTurnstileError = () => { state.token = ''; setStatus('安全验证暂不可用，请稍后重试。', 'error'); };

  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!email.validity.valid) { email.reportValidity(); return; }
    if (!state.token) { setStatus('请先完成安全验证。', 'error'); return; }
    setBusy(sendButton, true, '正在发送…');
    setStatus('');
    try {
      const body = { email: email.value, turnstile_token: state.token };
      if (authorizationRequestId) body.authorization_request_id = authorizationRequestId;
      const response = await fetch('/v1/auth/email/challenges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'send_failed');
      state.challengeId = payload.challenge_id;
      codePanel.hidden = false;
      sentTo.textContent = '验证码已发送至 ' + email.value.trim().toLowerCase() + '。';
      setStatus('验证码已发送，请在 10 分钟内完成验证。', 'success');
      codeInputs[0].focus();
      securityLabel.hidden = true;
      turnstileContainer.hidden = true;
    } catch (error) {
      const messages = { rate_limited: '发送过于频繁，请稍后再试。', turnstile_failed: '安全验证失败，请重新完成验证。', email_delivery_unavailable: '邮件服务暂不可用，请稍后重试。', login_request_expired: '登录请求已过期，请回到知远桌面端重新发起登录。' };
      setStatus(messages[error.message] || '验证码发送失败，请稍后重试。', 'error');
      resetHumanCheck();
    } finally { setBusy(sendButton, false, '发送验证码'); }
  });

  codeInputs.forEach((input, index) => {
    input.addEventListener('input', () => { input.value = input.value.replace(/\\D/g, '').slice(-1); if (input.value && codeInputs[index + 1]) codeInputs[index + 1].focus(); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Backspace' && !input.value && codeInputs[index - 1]) codeInputs[index - 1].focus(); });
    input.addEventListener('paste', (event) => { const digits = (event.clipboardData?.getData('text') || '').replace(/\\D/g, '').slice(0, 6); if (!digits) return; event.preventDefault(); digits.split('').forEach((digit, digitIndex) => { if (codeInputs[digitIndex]) codeInputs[digitIndex].value = digit; }); codeInputs[Math.min(digits.length, 6) - 1].focus(); });
  });

  codeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = codeValue();
    if (!state.challengeId || code.length !== 6) { setStatus('请输入 6 位验证码。', 'error'); return; }
    setBusy(verifyButton, true, '正在验证…');
    try {
      const response = await fetch('/v1/auth/email/challenges/' + encodeURIComponent(state.challengeId) + '/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'verification_failed');
      codePanel.hidden = true;
      emailForm.hidden = true;
      document.querySelector('#offline').hidden = true;
      setStatus('邮箱验证成功，正在返回知远桌面端…', 'success');
      if (payload.redirect_to) window.location.assign(payload.redirect_to);
      else setStatus('邮箱验证成功。此版本不会改变任何本地功能。', 'success');
    } catch (error) {
      const messages = { code_expired: '验证码已过期，请重新发送。', code_locked: '尝试次数过多，请重新发送验证码。', invalid_code: '验证码不正确，请重新输入。' };
      setStatus(messages[error.message] || '验证失败，请稍后重试。', 'error');
    } finally { setBusy(verifyButton, false, '验证并继续'); }
  });

  document.querySelector('#offline').addEventListener('click', () => { setStatus('你可以关闭此页面并继续离线使用。'); });
})();
`;
