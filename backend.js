/* Folio sync backend for the self-hosted version.
   Stores planners in a Supabase table and pictures in Supabase Storage.
   The app talks to it through the same small document API it uses inside Claude. */
(function () {
  const TABLE = 'folio_docs';
  const BUCKET = 'folio';

  function configured() {
    const c = window.FOLIO_CONFIG || {};
    return c.supabaseUrl && c.supabaseAnonKey && !/YOUR_/.test(c.supabaseUrl + c.supabaseAnonKey);
  }

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  }

  /* Remove spaces and invisible characters that autofill or copy-paste can add. */
  const cleanEmail = v => (v || '').replace(/[\s ​-‍⁠﻿]/g, '').toLowerCase();
  const here = () => location.origin + location.pathname;

  /* Sign-in screen: email + password, shown until there is a session. */
  function signInScreen(sb, note) {
    return new Promise(resolve => {
      const app = document.getElementById('app');
      const email = el('input', {class: 'input', type: 'email', id: 'loginEmail', name: 'email', autocomplete: 'username', inputmode: 'email', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'you@example.com'});
      const pass = el('input', {class: 'input', type: 'password', id: 'loginPass', name: 'password', autocomplete: 'current-password', placeholder: 'At least 6 characters'});
      const msg = el('p', {class: 'credit', role: 'status', style: 'min-height:1.5em;margin:0'});
      const setMsg = (t, bad) => { msg.textContent = t; msg.style.color = bad ? 'var(--danger)' : ''; };
      const validEmail = () => {
        const v = cleanEmail(email.value);
        if (!/^[^@]+@[^@]+\.[^@]+$/.test(v)) { setMsg('Check your email address, it looks incomplete.', true); email.focus(); return null; }
        email.value = v; return v;
      };
      const check = () => {
        const v = validEmail(); if (!v) return null;
        if (pass.value.length < 6) { setMsg('Password needs at least 6 characters.', true); pass.focus(); return null; }
        return v;
      };
      let busy = false;
      const run = async fn => { if (busy) return; busy = true; try { await fn(); } catch (e) { setMsg('No connection. Check the internet and try again.', true); } busy = false; };
      const signIn = e => { e && e.preventDefault(); run(async () => {
        const v = check(); if (!v) return;
        setMsg('Signing in…');
        const { data, error } = await sb.auth.signInWithPassword({ email: v, password: pass.value });
        if (error) {
          if (/confirm/i.test(error.message)) setMsg('Confirm your email first: open the newest link we sent you, then sign in.', true);
          else setMsg('Wrong email or password. Forgot it? Tap “Forgot password”.', true);
          return;
        }
        resolve(data.session);
      }); };
      const signUp = () => run(async () => {
        const v = check(); if (!v) return;
        setMsg('Creating your account…');
        const { data, error } = await sb.auth.signUp({ email: v, password: pass.value, options: { emailRedirectTo: here() } });
        if (error) { setMsg(error.message, true); return; }
        if (data.session) { resolve(data.session); return; }
        // Supabase answers "ok" with no identities when the email is already registered.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          setMsg('You already have an account with this email. Tap “Sign in”, or “Forgot password” if you don’t remember it.', true);
          return;
        }
        setMsg('Account created. Open the confirmation link we emailed you, then sign in here.');
      });
      const forgot = () => run(async () => {
        const v = validEmail(); if (!v) return;
        setMsg('Sending…');
        const { error } = await sb.auth.resetPasswordForEmail(v, { redirectTo: here() });
        if (error) { setMsg(/rate|seconds|many/i.test(error.message) ? 'Too many emails just now. Wait a minute and try again.' : error.message, true); return; }
        setMsg('We emailed you a link. Open it on this device to set a new password.');
      });
      const form = el('form', {class: 'login', onsubmit: signIn, novalidate: ''},
        el('div', {class: 'login-brand'}, 'Folio'),
        el('p', {class: 'muted', style: 'margin:0 0 6px'}, 'Sign in to see your planners on every device.'),
        el('label', {class: 'l', for: 'loginEmail'}, 'Email'), email,
        el('label', {class: 'l', for: 'loginPass'}, 'Password'), pass,
        msg,
        el('button', {class: 'btn primary', type: 'submit'}, 'Sign in'),
        el('div', {style: 'display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap'},
          el('button', {class: 'btn ghost', type: 'button', onclick: signUp}, 'Create account'),
          el('button', {class: 'btn ghost', type: 'button', onclick: forgot}, 'Forgot password')));
      email.addEventListener('input', () => setMsg(''));
      pass.addEventListener('input', () => setMsg(''));
      app.replaceChildren(el('div', {class: 'login-wrap'}, form));
      if (note) setMsg(note, true);
      email.focus();
    });
  }

  /* After opening a "reset password" email link: choose a new password. */
  function newPasswordScreen(sb) {
    return new Promise(resolve => {
      const app = document.getElementById('app');
      const pass = el('input', {class: 'input', type: 'password', id: 'newPass', autocomplete: 'new-password', placeholder: 'At least 6 characters'});
      const msg = el('p', {class: 'credit', role: 'status', style: 'min-height:1.5em;margin:0'});
      const save = async e => {
        e.preventDefault();
        if (pass.value.length < 6) { msg.textContent = 'Password needs at least 6 characters.'; msg.style.color = 'var(--danger)'; return; }
        msg.textContent = 'Saving…'; msg.style.color = '';
        const { error } = await sb.auth.updateUser({ password: pass.value });
        if (error) { msg.textContent = error.message; msg.style.color = 'var(--danger)'; return; }
        history.replaceState(null, '', here());
        resolve();
      };
      app.replaceChildren(el('div', {class: 'login-wrap'}, el('form', {class: 'login', onsubmit: save, novalidate: ''},
        el('div', {class: 'login-brand'}, 'New password'),
        el('label', {class: 'l', for: 'newPass'}, 'Choose a new password'), pass, msg,
        el('button', {class: 'btn primary', type: 'submit'}, 'Save and open Folio'))));
      pass.focus();
    });
  }

  window.FolioBackend = {
    async connect() {
      if (!configured()) throw new Error('add your Supabase keys to config.js to sync between devices.');
      const cfg = window.FOLIO_CONFIG;
      const recovering = /type=recovery/.test(location.hash + location.search);
      const linkNote = /error_code=otp_expired|error=access_denied/.test(location.hash) ? 'That email link has expired or was already used. Just sign in with your email and password.' : '';
      const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      let { data: { session } } = await sb.auth.getSession();
      if (session && recovering) await newPasswordScreen(sb);
      if (!session) session = await signInScreen(sb, linkNote);
      if (location.hash.includes('access_token') || location.hash.includes('error=')) history.replaceState(null, '', here());
      const app = document.getElementById('app');
      app.innerHTML = '<div class="loading">Opening your planners…</div>';
      const uid = session.user.id;

      const fail = error => { throw { message: error.message || 'sync failed — check your connection', code: error.code }; };
      const docRef = path => ({
        id: path.split('/').pop(), path,
        async get() {
          const { data, error } = await sb.from(TABLE).select('data').eq('key', path).maybeSingle();
          if (error) fail(error);
          return { exists: !!data, data: () => data && data.data };
        },
        async set(body) {
          const { error } = await sb.from(TABLE).upsert({ user_id: uid, key: path, data: body, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
          if (error) fail(error);
        },
        async delete() {
          const { error } = await sb.from(TABLE).delete().eq('key', path);
          if (error) fail(error);
        },
        collection: name => colRef(path + '/' + name)
      });
      const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
      const colRef = path => ({
        path,
        doc: id => docRef(path + '/' + id),
        async get() {
          const { data, error } = await sb.from(TABLE).select('key,data').like('key', esc(path) + '/%').not('key', 'like', esc(path) + '/%/%');
          if (error) fail(error);
          return { docs: (data || []).map(r => ({ id: r.key.split('/').pop(), exists: true, data: () => r.data })) };
        }
      });

      const assets = {
        async upload(blob) {
          const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          const id = uid + '/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) + '.' + ext;
          const { error } = await sb.storage.from(BUCKET).upload(id, blob, { contentType: blob.type, upsert: false });
          if (error) throw { message: error.message, code: /exceed|quota|size/i.test(error.message) ? 'quota_or_state' : 'upstream_error' };
          return { id, url: sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl };
        }
      };

      return {
        base: docRef('app'),
        col: colRef('app/planners'),
        assets,
        assetUrl: id => sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl,
        account: session.user.email,
        /* Private link for Apple Calendar / Google Calendar to subscribe to this account's events. */
        async feedUrl() {
          let { data, error } = await sb.from('folio_feeds').select('token').maybeSingle();
          if (error) fail(error);
          if (!data) {
            const bytes = crypto.getRandomValues(new Uint8Array(24));
            const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const r = await sb.from('folio_feeds').insert({ token, user_id: uid });
            if (r.error) fail(r.error);
            data = { token };
          }
          return cfg.supabaseUrl + '/functions/v1/folio-ics?t=' + encodeURIComponent(data.token);
        },
        async resetFeed() {
          const { error } = await sb.from('folio_feeds').delete().eq('user_id', uid);
          if (error) fail(error);
        },
        signOut: async () => { await sb.auth.signOut(); location.reload(); }
      };
    }
  };
})();
