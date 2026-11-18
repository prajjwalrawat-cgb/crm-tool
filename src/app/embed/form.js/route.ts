export const runtime = 'nodejs';
export const dynamic = 'force-static';

/**
 * GET /embed/form.js — the embeddable Saleinx capture form.
 *
 *   <div data-saleinx-form="<tenant-slug>/<form-slug>"></div>
 *   <script src="https://<saleinx-host>/embed/form.js" async></script>
 *
 * Renders each placeholder in a shadow DOM (host-page CSS can't break it,
 * and it can't break the host page), captures utm_* from the page URL plus
 * the landing URL and referrer, and posts to the public submit endpoint. The
 * page's origin must be in the lead source's allowed origins.
 *
 * Every piece of form text is set with textContent — never innerHTML — so an
 * admin-entered label can't inject markup into a customer's website.
 */
const SCRIPT = String.raw`(function () {
  'use strict';
  var script = document.currentScript;
  var base = script ? new URL(script.src).origin : '';
  var CSS = ':host{all:initial;display:block;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a}' +
    '.f{max-width:480px;border:1px solid #e2e8f0;border-radius:12px;padding:20px;background:#fff}' +
    'h3{margin:0 0 14px;font-size:18px;font-weight:600}' +
    'label{display:block;font-size:13px;font-weight:500;margin:10px 0 4px}' +
    'input,select,textarea{box-sizing:border-box;width:100%;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;font-size:14px;background:#fff;color:#0f172a}' +
    'textarea{min-height:90px;resize:vertical}' +
    'input:focus,select:focus,textarea:focus{outline:2px solid var(--a);outline-offset:1px;border-color:var(--a)}' +
    '.c{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#475569;margin-top:12px}.c input{width:auto;margin-top:2px}' +
    'button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--a);color:#fff;font:inherit;font-weight:600;cursor:pointer}' +
    'button[disabled]{opacity:.6;cursor:default}' +
    '.e{color:#b91c1c;font-size:13px;margin-top:10px}.ok{font-size:15px;line-height:1.5}' +
    '.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}' +
    '.req{color:#b91c1c}';

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function utm() {
    var q = new URLSearchParams(location.search), o = {};
    ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (k) {
      var v = q.get('utm_' + k); if (v) o[k] = v.slice(0, 200);
    });
    return o;
  }

  function loadTurnstile(cb) {
    if (window.turnstile) return cb();
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.onload = cb; document.head.appendChild(s);
  }

  function mount(host) {
    if (host.__saleinx) return; host.__saleinx = true;
    var ref = (host.getAttribute('data-saleinx-form') || '').split('/');
    if (ref.length !== 2) return;
    var url = base + '/api/public/forms/' + encodeURIComponent(ref[0]) + '/' + encodeURIComponent(ref[1]);
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = el('style'); style.textContent = CSS; root.appendChild(style);
    var wrap = el('div', { class: 'f' }); root.appendChild(wrap);

    fetch(url, { mode: 'cors' }).then(function (r) { if (!r.ok) throw new Error('load'); return r.json(); }).then(function (def) {
      wrap.style.setProperty('--a', (def.theme && def.theme.accent) || '#4f46e5');
      var form = el('form', { novalidate: '' });
      form.appendChild(el('h3', null, def.title));
      def.fields.forEach(function (f) {
        var id = 'sx_' + f.key;
        var label = el('label', { for: id }, f.label);
        if (f.required) { label.appendChild(document.createTextNode(' ')); label.appendChild(el('span', { class: 'req', 'aria-hidden': 'true' }, '*')); }
        var input;
        if (f.type === 'textarea') input = el('textarea', { id: id, name: f.key });
        else if (f.type === 'select') {
          input = el('select', { id: id, name: f.key });
          input.appendChild(el('option', { value: '' }, 'Select…'));
          (f.options || []).forEach(function (o) { input.appendChild(el('option', { value: o }, o)); });
        } else if (f.type === 'checkbox') {
          var row = el('div', { class: 'c' });
          input = el('input', { id: id, name: f.key, type: 'checkbox' });
          row.appendChild(input); row.appendChild(label); form.appendChild(row); input.required = !!f.required; return;
        } else input = el('input', { id: id, name: f.key, type: f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : 'text',
          autocomplete: f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'on' });
        if (f.maxLength) input.setAttribute('maxlength', f.maxLength);
        input.required = !!f.required;
        form.appendChild(label); form.appendChild(input);
      });
      var consent = null;
      if (def.consentText) {
        var crow = el('div', { class: 'c' });
        consent = el('input', { type: 'checkbox', id: 'sx_consent', required: '' });
        crow.appendChild(consent); crow.appendChild(el('label', { for: 'sx_consent' }, def.consentText));
        form.appendChild(crow);
      }
      var hpWrap = el('div', { class: 'hp', 'aria-hidden': 'true' });
      var hp = el('input', { type: 'text', name: 'company_website', tabindex: '-1', autocomplete: 'off' });
      hpWrap.appendChild(hp); form.appendChild(hpWrap);

      var captchaBox = null, captchaToken = null;
      if (def.captchaSiteKey) {
        captchaBox = el('div'); host.after(captchaBox);
        loadTurnstile(function () {
          window.turnstile.render(captchaBox, { sitekey: def.captchaSiteKey, callback: function (t) { captchaToken = t; } });
        });
      }

      var err = el('div', { class: 'e', role: 'alert' });
      var btn = el('button', { type: 'submit' }, 'Submit');
      form.appendChild(btn); form.appendChild(err);
      var renderedAt = Date.now();

      form.addEventListener('submit', function (ev) {
        ev.preventDefault(); err.textContent = '';
        var fields = {};
        def.fields.forEach(function (f) {
          var i = form.querySelector('[name="' + f.key + '"]');
          if (i) fields[f.key] = f.type === 'checkbox' ? !!i.checked : i.value;
        });
        btn.disabled = true; btn.textContent = 'Sending…';
        fetch(url + '/submit', {
          method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: fields, consent: consent ? !!consent.checked : undefined, hp: hp.value, t: renderedAt,
            utm: utm(), landingUrl: location.href.slice(0, 2000), referrer: (document.referrer || '').slice(0, 2000),
            captchaToken: captchaToken || undefined })
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
          if (!res.ok) { err.textContent = (res.j && res.j.message) || 'Something went wrong. Please try again.'; btn.disabled = false; btn.textContent = 'Submit'; return; }
          if (res.j.redirectUrl) { location.href = res.j.redirectUrl; return; }
          wrap.textContent = ''; wrap.appendChild(el('div', { class: 'ok', role: 'status' }, res.j.message || def.thankYouMessage));
          if (captchaBox) captchaBox.remove();
        }).catch(function () { err.textContent = 'Network error. Please try again.'; btn.disabled = false; btn.textContent = 'Submit'; });
      });
      wrap.appendChild(form);
    }).catch(function () { wrap.textContent = 'This form is unavailable right now.'; });
  }

  function scan() { document.querySelectorAll('[data-saleinx-form]').forEach(mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();`;

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
