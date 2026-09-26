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

  /* Sign-in screen: email + password, shown until there is a session. */
  function signInScreen(sb) {
    return new Promise(resolve => {
      const app = document.getElementById('app');
      const email = el('input', {class: 'input', type: 'email', id: 'loginEmail', autocomplete: 'email', placeholder: 'you@example.com'});
      const pass = el('input', {class: 'input', type: 'password', id: 'loginPass', autocomplete: 'current-password', placeholder: 'At least 6 characters'});
      const msg = el('p', {class: 'credit', role: 'status', style: 'min-height:1.5em'});
      const setMsg = (t, bad) => { msg.textContent = t; msg.style.color = bad ? 'var(--danger)' : ''; };
      const check = () => {
        if (!email.value.includes('@')) { setMsg('Enter your email.', true); email.focus(); return false; }
        if (pass.value.length < 6) { setMsg('Password needs at least 6 characters.', true); pass.focus(); return false; }
        return true;
      };
      const signIn = async e => {
        e && e.preventDefault();
        if (!check()) return;
        setMsg('Signing in…');
        const { data, error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if (error) { setMsg(/confirm/i.test(error.message) ? 'Confirm your email first: open the link we sent you, then sign in.' : 'Wrong email or password.', true); return; }
        resolve(data.session);
      };
      const signUp = async () => {
        if (!check()) return;
        setMsg('Creating your account…');
        const { data, error } = await sb.auth.signUp({ email: email.value.trim(), password: pass.value, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) { setMsg(error.message, true); return; }
        if (data.session) resolve(data.session);
        else setMsg('Account created. Open the confirmation link we emailed you, then sign in here.');
      };
      const form = el('form', {class: 'login', onsubmit: signIn},
        el('div', {class: 'login-brand'}, 'Folio'),
        el('p', {class: 'muted', style: 'margin:0 0 6px'}, 'Sign in to see your planners on every device.'),
        el('label', {class: 'l', for: 'loginEmail'}, 'Email'), email,
        el('label', {class: 'l', for: 'loginPass'}, 'Password'), pass,
        msg,
        el('button', {class: 'btn primary', type: 'submit'}, 'Sign in'),
        el('button', {class: 'btn ghost', type: 'button', onclick: signUp}, 'Create account'));
      app.replaceChildren(el('div', {class: 'login-wrap'}, form));
      email.focus();
    });
  }

  window.FolioBackend = {
    async connect() {
      if (!configured()) throw new Error('add your Supabase keys to config.js to sync between devices.');
      const cfg = window.FOLIO_CONFIG;
      const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      let { data: { session } } = await sb.auth.getSession();
      if (!session) session = await signInScreen(sb);
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
        signOut: async () => { await sb.auth.signOut(); location.reload(); }
      };
    }
  };
})();
