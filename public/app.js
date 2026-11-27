/* 前端公共：加密层 + 请求封装（与后端对齐：AES-256-CBC + HmacSHA256 + ts + nonce） */
const b64 = {
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  decode: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const TE = new TextEncoder();

const CRY = { key: '', iv: '', hmac: '', ready: false };

async function cryInit() {
  if (CRY.ready) return;
  const r = await fetch('/base/api/open/config/platform/config/v2').then(x => x.json());
  CRY.key = r.data.cry.key; CRY.iv = r.data.cry.iv; CRY.hmac = r.data.cry.hmac;
  CRY.ready = true;
}

async function encryptBody(obj) {
  await cryInit();
  const key = await crypto.subtle.importKey('raw', TE.encode(CRY.key), { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: TE.encode(CRY.iv) }, key, TE.encode(JSON.stringify(obj)));
  const cipher = b64.encode(ct);
  const hk = await crypto.subtle.importKey('raw', TE.encode(CRY.hmac), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hex(await crypto.subtle.sign('HMAC', hk, TE.encode(cipher)));
  return { body: { yscryp: cipher }, headers: { yscry: 'ysr2a', yscrys: sig, 'x-ts': String(Date.now()), 'x-nonce': crypto.randomUUID() } };
}

const Store = {
  get token() { return localStorage.getItem('token') || ''; },
  set token(v) { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); },
  get tenant() { return localStorage.getItem('tenant') || ''; },
  set tenant(v) { v ? localStorage.setItem('tenant', v) : localStorage.removeItem('tenant'); },
};

/**
 * 统一请求。encrypt=false 用于无需加密的公开接口（配置、验证码、扫码轮询）。
 */
async function api(path, body = {}, opt = {}) {
  const method = opt.method || 'POST';
  const headers = { 'Content-Type': 'application/json' };
  if (Store.token) headers.Authorization = 'Bearer ' + Store.token;
  let payload = null;

  if (opt.encrypt === false) {
    payload = JSON.stringify(method === 'GET' ? {} : body);
  } else {
    const e = await encryptBody(body);
    Object.assign(headers, e.headers);
    payload = JSON.stringify(e.body);
  }

  let url = path;
  if (method === 'GET' && opt.query) url += '?' + new URLSearchParams(opt.query).toString();

  const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : payload });
  const json = await res.json();
  if (json.code === 401) { Store.token = ''; if (!location.pathname.endsWith('index.html') && location.pathname !== '/') location.href = '/'; }
  return json;
}

const toast = (msg, type = 'info') => {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = 'toast show ' + type;
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = 'toast', 2600);
};

/** 载入图形验证码（公开接口，不加密） */
async function loadCaptcha(imgEl, sidRef) {
  const r = await api('/base/api/auth/checkCode/image', {}, { method: 'GET', encrypt: false });
  if (r.code !== 0) return;
  imgEl.src = r.data.checkCodeImageData;
  sidRef.value = r.data.checkCodeSessionId;
  return r.data;
}
