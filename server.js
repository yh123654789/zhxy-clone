/**
 * 智慧校园平台（类似元素 ecscc/zhxy 的同类实现）—— 单文件后端
 * ---------------------------------------------------------------------------
 * 设计对齐逆向结果，但把原系统的缺陷改成正确实现：
 *   ✔ 多租户 + 机构树（parentId 递归，按数据域过滤）
 *   ✔ 请求加密层（AES-256-CBC + HmacSHA256 + 时间戳 + nonce 防重放，服务端强制）
 *   ✔ 账号密码 / 短信验证码 / 扫码登录 三种登录
 *   ✔ 扫码登录：onceToken 由**服务端**生成、一次性消费、轮询限流、确认页展示发起方
 *   ✔ 注册审批流（提交 → 待审 → 管理员批准才建号）
 *   ✔ RBAC：page 权限码 + 按钮权限码，服务端接口级校验（不靠前端隐藏）
 *   ✔ 鉴权前置（先验 token 再校验参数）、CORS 白名单、安全响应头、登录失败锁定、短信频控、审计日志
 *
 * 启动： node server.js  [port]
 * 依赖： node:http / node:sqlite / node:crypto / qrcode
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* 无 qrcode 时降级为文本 */ }

const PORT = Number(process.env.PORT || process.argv[2] || 8099);
const PUBLIC = path.join(__dirname, 'public');
const DEV = process.env.NODE_ENV !== 'production';
const SHOW_DEV_CODE = process.env.SHOW_DEV_CODE !== '0';     // 演示环境把短信验证码回显，生产设 SHOW_DEV_CODE=0
const DATA_DIR = process.env.DATA_DIR || __dirname;          // 云上把持久卷挂到这里
const ACCESS_CODE = process.env.ACCESS_CODE || '';           // 设了就要求访问口令（公网必开）
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ============================ 加密层 ============================ */
// 与逆向到的协议同构：AES-256-CBC(key,iv) + HmacSHA256(密文) → yscryp / yscry / yscrys
const CRY = {
  key: process.env.APP_AES_KEY || 'zhxy-clone-key-32bytes-demo-0001', // 32 字节
  iv: process.env.APP_AES_IV || 'clone-iv-16byt3!',                  // 16 字节
  hmac: process.env.APP_HMAC_KEY || 'clone-hmac-key-demo',
};
const enc = (obj) => {
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(CRY.key), Buffer.from(CRY.iv));
  return Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]).toString('base64');
};
const dec = (b64) => {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(CRY.key), Buffer.from(CRY.iv));
  return JSON.parse(Buffer.concat([d.update(String(b64), 'base64'), d.final()]).toString('utf8'));
};
const hmac = (s) => crypto.createHmac('sha256', CRY.hmac).update(String(s)).digest('hex');
const randomId = (n = 16) => crypto.randomBytes(n).toString('hex');
const uuid = () => crypto.randomUUID();
const now = () => Date.now();
const pwdHash = (pwd, salt) => crypto.scryptSync(pwd, salt, 32).toString('hex');
const pwdCheck = (pwd, stored) => {
  const [salt, hash] = String(stored).split('$');
  return pwdHash(pwd, salt) === hash;
};
const pwdMake = (pwd) => { const salt = randomId(8); return `${salt}$${pwdHash(pwd, salt)}`; };

/* ============================ 数据库 ============================ */
const db = new DatabaseSync(path.join(DATA_DIR, 'data.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, name TEXT, unique_name TEXT, module_type INTEGER,
  register_enable INTEGER, need_approval INTEGER, title TEXT);
CREATE TABLE IF NOT EXISTS orgs(id TEXT PRIMARY KEY, tenant_id TEXT, parent_id TEXT, name TEXT,
  unit_attr INTEGER, level INTEGER, path TEXT);
CREATE TABLE IF NOT EXISTS roles(code TEXT PRIMARY KEY, name TEXT, pages TEXT, btns TEXT);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, tenant_id TEXT, org_id TEXT, user_name TEXT,
  pwd TEXT, phone TEXT UNIQUE, real_name TEXT, role TEXT, status INTEGER, fail_count INTEGER,
  locked_until INTEGER, created_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_tenant_name ON users(tenant_id, user_name);
CREATE TABLE IF NOT EXISTS applies(id TEXT PRIMARY KEY, tenant_id TEXT, org_id TEXT, phone TEXT,
  user_name TEXT, real_name TEXT, pwd TEXT, state INTEGER, remark TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS captchas(sid TEXT PRIMARY KEY, code TEXT, expire_at INTEGER);
CREATE TABLE IF NOT EXISTS sms(phone TEXT PRIMARY KEY, code TEXT, expire_at INTEGER, last_send INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, expire_at INTEGER, ua TEXT);
CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS qr(once_token TEXT PRIMARY KEY, tenant_id TEXT, state INTEGER, user_id TEXT,
  expire_at INTEGER, poll_count INTEGER, last_poll INTEGER, consumed INTEGER,
  require_user TEXT, ua TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS once_tokens(token TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT,
  expire_at INTEGER, used INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tenant_id TEXT,
  user_id TEXT, user_name TEXT, ip TEXT, method TEXT, path TEXT, status INTEGER, detail TEXT);
`);

const q = (sql) => db.prepare(sql);
const get = (sql, ...a) => q(sql).get(...a);
const all = (sql, ...a) => q(sql).all(...a);
const run = (sql, ...a) => q(sql).run(...a);

/* ============================ 种子数据 ============================ */
function seed() {
  if (get('SELECT id FROM tenants LIMIT 1')) return;

  const tenants = [
    { id: 'T1001', name: '示范实验学校', unique: 'demo', mt: 0, reg: 1, appr: 1, title: '智慧校园平台' },
    { id: 'T1002', name: '区域教育局版', unique: 'district', mt: 1, reg: 1, appr: 1, title: '区域教育管理平台' },
    { id: 'T1003', name: '关闭注册的学校', unique: 'closed', mt: 0, reg: 0, appr: 1, title: '智慧校园平台' },
  ];
  tenants.forEach(t => run('INSERT INTO tenants VALUES(?,?,?,?,?,?,?)', t.id, t.name, t.unique, t.mt, t.reg, t.appr, t.title));

  // 机构树：教育局 → 学校 → 年级/科室
  const orgs = [
    ['O100', 'T1001', '0', '示范实验学校', 16, 1, 'O100'],
    ['O101', 'T1001', 'O100', '小学部', 16, 2, 'O100,O101'],
    ['O102', 'T1001', 'O100', '初中部', 16, 2, 'O100,O102'],
    ['O103', 'T1001', 'O100', '教务处', 64, 2, 'O100,O103'],
    ['O104', 'T1001', 'O101', '五年级', 32, 3, 'O100,O101,O104'],
    ['O105', 'T1001', 'O101', '六年级', 32, 3, 'O100,O101,O105'],
    ['O106', 'T1001', 'O102', '初一', 32, 3, 'O100,O102,O106'],
    ['O200', 'T1002', '0', '市教育局', 2, 1, 'O200'],
    ['O201', 'T1002', 'O200', '第一中学', 16, 2, 'O200,O201'],
    ['O202', 'T1002', 'O200', '第二小学', 16, 2, 'O200,O202'],
    ['O300', 'T1003', '0', '封闭注册学校', 16, 1, 'O300'],
  ];
  orgs.forEach(o => run('INSERT INTO orgs VALUES(?,?,?,?,?,?,?)', ...o));

  const roles = [
    ['super', '超级管理员', JSON.stringify(['*']), JSON.stringify(['*'])],
    ['school_admin', '学校管理员',
      JSON.stringify(['base_student', 'base_teacher', 'base_class', 'base_org', 'sys_apply', 'sys_audit']),
      JSON.stringify(['base_student_insert', 'base_student_update', 'base_student_delete',
        'base_teacher_insert', 'base_teacher_update', 'base_apply_pass', 'base_apply_refuse'])],
    ['teacher', '教师', JSON.stringify(['base_student', 'base_class']), JSON.stringify([])],
    ['student', '学生', JSON.stringify([]), JSON.stringify([])],
  ];
  roles.forEach(r => run('INSERT INTO roles VALUES(?,?,?,?)', ...r));

  const mk = (id, tid, oid, uname, pwd, phone, name, role) =>
    run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, tid, oid, uname, pwdMake(pwd), phone, name, role, 0, 0, 0, now());

  mk('U001', 'T1001', 'O100', 'admin', 'Admin@2026', '13800000001', '张校长', 'school_admin');
  mk('U002', 'T1001', 'O104', 'teacher1', 'Teach@2026', '13800000002', '李老师', 'teacher');
  mk('U003', 'T1001', 'O100', 'root', 'Root@2026', '13800000003', '平台超管', 'super');
  mk('U004', 'T1002', 'O200', 'admin', 'Admin@2026', '13800000004', '王局长', 'school_admin');
  console.log('[seed] 租户/机构/角色/账号 初始化完成');
}
seed();

/* ============================ 工具 ============================ */
const log = (o) => {
  run('INSERT INTO audit(ts,tenant_id,user_id,user_name,ip,method,path,status,detail) VALUES(?,?,?,?,?,?,?,?,?)',
    now(), o.tenant_id || '', o.user_id || '', o.user_name || '', o.ip || '',
    o.method || '', o.path || '', o.status || 0, (o.detail || '').slice(0, 500));
};
const send = (res, status, body, extra = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(buf);
};
const ok = (res, data = null, msg = 'OK') => send(res, 200, { code: 0, msg, data, success: true });
const fail = (res, code, msg, data = null) => send(res, 200, { code, msg, data, success: false });

/* ============================ 图形验证码 ============================ */
const CAPTCHA_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function makeCaptcha() {
  const code = Array.from({ length: 4 }, () => CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)]).join('');
  const sid = uuid();
  run('INSERT OR REPLACE INTO captchas VALUES(?,?,?)', sid, code, now() + 120000);
  const lines = Array.from({ length: 3 }, () => {
    const x1 = crypto.randomInt(0, 120), y1 = crypto.randomInt(0, 40);
    const x2 = crypto.randomInt(0, 120), y2 = crypto.randomInt(0, 40);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9bb" stroke-width="1"/>`;
  }).join('');
  const chars = code.split('').map((ch, i) => {
    const rot = crypto.randomInt(-25, 25), x = 12 + i * 26, y = 30 + crypto.randomInt(-4, 5);
    return `<text x="${x}" y="${y}" font-size="26" font-family="monospace" fill="#256"
      transform="rotate(${rot} ${x} ${y})">${ch}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">
    <rect width="120" height="40" fill="#eef3f7"/>${lines}${chars}</svg>`;
  return { sid, code, img: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') };
}
function checkCaptcha(sid, code) {
  if (!sid || !code) return false;
  const row = get('SELECT * FROM captchas WHERE sid=?', sid);
  if (!row || row.expire_at < now()) return false;
  run('DELETE FROM captchas WHERE sid=?', sid);           // 一次性
  return row.code.toLowerCase() === String(code).toLowerCase();
}

/* ============================ 会话 / 权限 ============================ */
function newSession(user, ua) {
  const token = randomId(32);
  run('INSERT INTO sessions VALUES(?,?,?,?,?)', token, user.id, user.tenant_id, now() + 24 * 3600 * 1000, ua || '');
  return token;
}
function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const s = get('SELECT * FROM sessions WHERE token=?', token);
  if (!s || s.expire_at < now()) return null;
  const u = get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u || u.status !== 0) return null;
  return { ...u, token };
}
const roleOf = (u) => get('SELECT * FROM roles WHERE code=?', u.role) || { pages: '[]', btns: '[]', code: u.role };
function hasPage(u, page) {
  const pages = JSON.parse(roleOf(u).pages || '[]');
  return pages.includes('*') || pages.includes(page);
}
function hasBtn(u, btn) {
  const btns = JSON.parse(roleOf(u).btns || '[]');
  return btns.includes('*') || btns.includes(btn);
}

/* ============================ 请求体解析（含解密） ============================ */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      let body;
      try { body = JSON.parse(raw); } catch { return resolve({}); }

      const sig = req.headers.yscrys;
      const flag = req.headers.yscry;
      const ts = Number(req.headers['x-ts'] || 0);
      const nonce = req.headers['x-nonce'] || '';
      if (!sig || flag !== 'ysr2a' || !body.yscryp) return resolve({ __plain: body });

      if (Math.abs(now() - ts) > 300000) return resolve({ __err: '请求时间戳超出 5 分钟窗口' });
      if (!nonce || nonce.length < 8) return resolve({ __err: '缺少 nonce' });
      if (get('SELECT nonce FROM nonces WHERE nonce=?', nonce)) return resolve({ __err: '重放请求（nonce 已使用）' });
      if (hmac(body.yscryp) !== sig) return resolve({ __err: '签名校验失败' });

      let data;
      try { data = dec(body.yscryp); } catch { return resolve({ __err: '密文解析失败' }); }
      run('INSERT OR REPLACE INTO nonces VALUES(?,?)', nonce, now());
      resolve({ ...data, __enc: true });
    });
  });
}
const rawBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

/* ============================ 路由 ============================ */
const routes = [];
const R = (method, p, fn, opt = {}) => routes.push({ method, p, fn, ...opt });

// 外部可访问的基地址：跟随请求的 Host 与协议（支持反向代理 / 隧道）
const baseOf = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host || `127.0.0.1:${PORT}`}`;
};

/* ---------- 平台配置 ---------- */
R('GET', '/base/api/open/config/platform/config/v2', async (ctx) => {
  const base = baseOf(ctx.req);
  ok(ctx.res, {
    platformGatewayUrl: base,
    platformFnUrl: base,
    tenantEnable: true, singleTenant: false,
    ysCry: { enable: true, forceAll: true },
    cry: { key: CRY.key, iv: CRY.iv, hmac: CRY.hmac },
    secureTips: { authBeforeValidate: true, corsWhitelist: true, nonce: true },
  });
}, { encrypt: false });

R('GET', '/base/api/tenant/query', async (ctx) => {
  const un = ctx.query.uniqueName || '';
  if (!un) return fail(ctx.res, 400, 'uniqueName 不能为空');
  const t = get('SELECT * FROM tenants WHERE unique_name=?', un);
  if (!t) return fail(ctx.res, 404, '未查询到该租户');
  ok(ctx.res, { id: t.id, name: t.name, uniqueName: t.unique_name, moduleType: t.module_type,
    registerEnable: !!t.register_enable, needApproval: !!t.need_approval, title: t.title });
}, { encrypt: false });

/* ---------- 图形验证码 / 短信 ---------- */
R('GET', '/base/api/auth/checkCode/image', async (ctx) => {
  const c = makeCaptcha();
  ok(ctx.res, { checkCodeSessionId: c.sid, checkCodeImageData: c.img, ...(SHOW_DEV_CODE ? { devCode: c.code } : {}) });
}, { encrypt: false });

R('POST', '/base/api/auth/sms/code/send', async (ctx) => {
  const { phone } = ctx.body;
  if (!/^1\d{10}$/.test(phone || '')) return fail(ctx.res, 400, '手机号格式不正确');
  const prev = get('SELECT * FROM sms WHERE phone=?', phone);
  if (prev && now() - prev.last_send < 60000)
    return fail(ctx.res, 429, `请 ${Math.ceil((60000 - (now() - prev.last_send)) / 1000)} 秒后重试`);
  const ipCount = get('SELECT COUNT(*) c FROM audit WHERE ip=? AND path=? AND ts>?',
    ctx.ip, '/base/api/auth/sms/code/send', now() - 600000).c;
  if (ipCount >= 5) return fail(ctx.res, 429, '发送过于频繁，请稍后再试');

  const code = String(crypto.randomInt(1000, 9999));
  run('INSERT OR REPLACE INTO sms VALUES(?,?,?,?)', phone, code, now() + 300000, now());
  console.log(`[SMS] ${phone} 验证码 ${code}（5 分钟内有效）`);
  ok(ctx.res, { sent: true, ...(SHOW_DEV_CODE ? { devCode: code } : {}) });
});

/* ---------- 登录：账号密码 ---------- */
R('POST', '/base/api/auth/loginByUserPwdNoOrg', async (ctx) => {
  const { userName, password, checkCode, checkCodeSessionId, tenantId } = ctx.body;
  if (!tenantId) return fail(ctx.res, 400, 'tenantId 不能为空');
  if (!userName || !password) return fail(ctx.res, 400, '账号和密码不能为空');

  const user = get('SELECT * FROM users WHERE user_name=? AND tenant_id=?', userName, tenantId);
  const needCaptcha = !!(user && user.fail_count >= 2);
  if (needCaptcha && !checkCaptcha(checkCodeSessionId, checkCode)) {
    const c = makeCaptcha();
    return fail(ctx.res, 2001, '图形验证码输入有误',
      { needCode: true, checkCodeSessionId: c.sid, checkCodeImageData: c.img });
  }
  if (user && user.locked_until > now())
    return fail(ctx.res, 2003, `账号已锁定，请 ${Math.ceil((user.locked_until - now()) / 60000)} 分钟后重试`);

  if (!user || !pwdCheck(password, user.pwd)) {
    if (user) {
      const fc = user.fail_count + 1;
      const lock = fc >= 5 ? now() + 15 * 60000 : 0;
      run('UPDATE users SET fail_count=?, locked_until=? WHERE id=?', fc, lock, user.id);
      return fail(ctx.res, 2002, `账号或密码错误（第 ${fc}/5 次）`);
    }
    return fail(ctx.res, 2002, '账号或密码错误');
  }
  run('UPDATE users SET fail_count=0, locked_until=0 WHERE id=?', user.id);
  const token = newSession(user, ctx.req.headers['user-agent']);
  log({ tenant_id: tenantId, user_id: user.id, user_name: user.user_name, ip: ctx.ip,
    method: 'POST', path: ctx.path, status: 0, detail: '密码登录成功' });
  ok(ctx.res, { operationType: 5, userToken: { accessToken: token }, tenantId, orgId: user.org_id, needCode: false });
});

/* ---------- 登录：短信验证码 ---------- */
R('POST', '/base/api/auth/loginByPhoneSms', async (ctx) => {
  const { phone, smsCode, tenantId } = ctx.body;
  if (!phone || !smsCode) return fail(ctx.res, 400, '手机号和验证码不能为空');
  const row = get('SELECT * FROM sms WHERE phone=?', phone);
  if (!row || row.expire_at < now()) return fail(ctx.res, 4001, '验证码已过期，请重新获取');
  if (row.code !== String(smsCode)) return fail(ctx.res, 4002, '验证码不正确');
  run('DELETE FROM sms WHERE phone=?', phone);
  const user = get('SELECT * FROM users WHERE phone=? AND tenant_id=?', phone, tenantId);
  if (!user) return fail(ctx.res, 4003, '该手机号未绑定账号');
  const token = newSession(user, ctx.req.headers['user-agent']);
  log({ tenant_id: tenantId, user_id: user.id, user_name: user.user_name, ip: ctx.ip,
    method: 'POST', path: ctx.path, status: 0, detail: '短信登录成功' });
  ok(ctx.res, { operationType: 5, userToken: { accessToken: token }, orgId: user.org_id });
});

/* ---------- 用户详情 / 退出 ---------- */
R('GET', '/base/api/auth/user/current/detail', async (ctx) => {
  const u = ctx.user, r = roleOf(u);
  const org = get('SELECT * FROM orgs WHERE id=?', u.org_id);
  ok(ctx.res, {
    id: u.id, userName: u.user_name, realName: u.real_name, phone: u.phone,
    tenantId: u.tenant_id, orgId: u.org_id, orgName: org ? org.name : '',
    role: u.role, roleName: r.name,
    permissions: { pages: JSON.parse(r.pages || '[]'), btns: JSON.parse(r.btns || '[]') },
    userType: 1,
  });
}, { auth: true });

R('POST', '/base/api/auth/logout', async (ctx) => {
  run('DELETE FROM sessions WHERE token=?', ctx.user.token);
  ok(ctx.res, true);
}, { auth: true });

/* ---------- 注册：提交 / 审批 ---------- */
R('POST', '/base/api/auth/signUp/v2', async (ctx) => {
  const { tenantId, orgId, phone, userName, realName, password, smsCode } = ctx.body;
  const t = get('SELECT * FROM tenants WHERE id=?', tenantId);
  if (!t) return fail(ctx.res, 404, '租户不存在');
  if (!t.register_enable) return fail(ctx.res, 4030, '该租户未开放注册');
  if (!/^1\d{10}$/.test(phone || '')) return fail(ctx.res, 400, '手机号格式不正确');
  if (!userName || !password || !realName) return fail(ctx.res, 400, '账号/姓名/密码不能为空');
  if (String(password).length < 8) return fail(ctx.res, 400, '密码至少 8 位');
  const row = get('SELECT * FROM sms WHERE phone=?', phone);
  if (!row || row.expire_at < now() || row.code !== String(smsCode)) return fail(ctx.res, 4002, '验证码不正确或已过期');
  if (get('SELECT id FROM users WHERE phone=?', phone)) return fail(ctx.res, 4005, '该手机号已注册');
  if (get('SELECT id FROM applies WHERE phone=? AND state=0', phone)) return fail(ctx.res, 4006, '已有待审核的申请');
  const org = get('SELECT * FROM orgs WHERE id=? AND tenant_id=?', orgId, tenantId);
  if (!org) return fail(ctx.res, 400, '机构不存在');
  run('DELETE FROM sms WHERE phone=?', phone);

  const id = 'A' + randomId(6).toUpperCase();
  run('INSERT INTO applies VALUES(?,?,?,?,?,?,?,?,?,?)', id, tenantId, orgId, phone, userName, realName,
    pwdMake(password), t.need_approval ? 0 : 1, '', now());
  if (!t.need_approval) {
    const uid = 'U' + randomId(6).toUpperCase();
    run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', uid, tenantId, orgId, userName,
      pwdMake(password), phone, realName, 'teacher', 0, 0, 0, now());
    log({ tenant_id: tenantId, ip: ctx.ip, method: 'POST', path: ctx.path, status: 0, detail: '免审核注册直接建号 ' + userName });
    return ok(ctx.res, { state: 1, applyId: id, accountCreated: true });
  }
  log({ tenant_id: tenantId, ip: ctx.ip, method: 'POST', path: ctx.path, status: 0, detail: '提交注册申请 ' + id });
  ok(ctx.res, { state: 2, applyId: id, accountCreated: false });
});

R('POST', '/base/api/auth/register/apply', async (ctx) => {
  if (!hasBtn(ctx.user, 'base_apply_pass') && !hasBtn(ctx.user, 'base_apply_refuse'))
    return fail(ctx.res, 403, '暂无权限');
  const { applyId, pass, remark } = ctx.body;
  const a = get('SELECT * FROM applies WHERE id=? AND tenant_id=?', applyId, ctx.user.tenant_id);
  if (!a) return fail(ctx.res, 404, '申请不存在');
  if (a.state !== 0) return fail(ctx.res, 400, '该申请已处理');
  if (pass) {
    if (get('SELECT id FROM users WHERE user_name=? AND tenant_id=?', a.user_name, a.tenant_id))
      return fail(ctx.res, 4007, '账号已存在');
    const uid = 'U' + randomId(6).toUpperCase();
    run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', uid, a.tenant_id, a.org_id, a.user_name,
      a.pwd, a.phone, a.real_name, 'teacher', 0, 0, 0, now());
    run('UPDATE applies SET state=1, remark=? WHERE id=?', remark || '', applyId);
    log({ tenant_id: ctx.user.tenant_id, user_id: ctx.user.id, user_name: ctx.user.user_name, ip: ctx.ip,
      method: 'POST', path: ctx.path, status: 0, detail: '批准注册 ' + a.user_name });
    return ok(ctx.res, { state: 1, accountId: uid });
  }
  run('UPDATE applies SET state=2, remark=? WHERE id=?', remark || '', applyId);
  log({ tenant_id: ctx.user.tenant_id, user_id: ctx.user.id, user_name: ctx.user.user_name, ip: ctx.ip,
    method: 'POST', path: ctx.path, status: 0, detail: '驳回注册 ' + a.user_name });
  ok(ctx.res, { state: 2 });
}, { auth: true });

R('POST', '/base/api/auth/register/apply/page', async (ctx) => {
  const { pageIndex = 1, pageSize = 20 } = ctx.body;
  const rows = all('SELECT * FROM applies WHERE tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ctx.user.tenant_id, pageSize, (pageIndex - 1) * pageSize).map(a => ({ ...a, pwd: undefined }));
  const total = get('SELECT COUNT(*) c FROM applies WHERE tenant_id=?', ctx.user.tenant_id).c;
  ok(ctx.res, { list: rows, total });
}, { auth: true, page: 'sys_apply' });

/* ---------- 扫码登录（安全版） ---------- */
R('POST', '/base/api/auth/getLoginQrCode', async (ctx) => {
  const { tenantId } = ctx.body;
  if (!tenantId) return fail(ctx.res, 400, 'tenantId 不能为空');
  const t = get('SELECT * FROM tenants WHERE id=?', tenantId);
  if (!t) return fail(ctx.res, 404, '租户不存在');

  const onceToken = uuid();                    // 服务端生成、不可预测
  const expire = now() + 120000;
  run('INSERT INTO qr VALUES(?,?,?,?,?,?,?,?,?,?,?)', onceToken, tenantId, 0, null, expire, 0, 0, 0,
    null, ctx.req.headers['user-agent'] || '', now());

  const scanUrl = `${baseOf(ctx.req)}/scan.html?t=${onceToken}`;
  let qr = null;
  if (QRCode) qr = await QRCode.toDataURL(scanUrl, { width: 260, margin: 1 });
  ok(ctx.res, { onceToken, expireAt: expire, scanUrl, qrCode: qr });
}, { encrypt: false });

R('POST', '/base/api/auth/getLoginStatus', async (ctx) => {
  const { onceToken } = ctx.body;
  const r = get('SELECT * FROM qr WHERE once_token=?', onceToken);
  if (!r) return fail(ctx.res, 4004, '会话不存在');
  if (now() - r.last_poll < 1500) return fail(ctx.res, 429, '轮询过于频繁');
  run('UPDATE qr SET last_poll=?, poll_count=? WHERE once_token=?', now(), r.poll_count + 1, onceToken);
  if (r.consumed) return ok(ctx.res, { state: 5, over: true, msg: '该会话已被消费' });
  if (r.expire_at < now()) return ok(ctx.res, { state: 1, over: true });
  if (r.state === 3 && r.user_id) {
    const u = get('SELECT * FROM users WHERE id=?', r.user_id);
    const token = newSession(u, 'qr-login');
    run('UPDATE qr SET consumed=1 WHERE once_token=?', onceToken);   // 一次性
    log({ tenant_id: r.tenant_id, user_id: u.id, user_name: u.user_name, ip: ctx.ip,
      method: 'POST', path: ctx.path, status: 0, detail: '扫码登录成功（onceToken 已消费）' });
    return ok(ctx.res, { state: 3, over: true, userToken: { accessToken: token }, accountId: u.id, orgId: u.org_id });
  }
  ok(ctx.res, { state: r.state, over: false });
}, { encrypt: false });

// 手机端确认（模拟小程序 authorize）：手机端必须已有会话
R('POST', '/base/api/auth/scan/confirm', async (ctx) => {
  const { onceToken } = ctx.body;
  const r = get('SELECT * FROM qr WHERE once_token=?', onceToken);
  if (!r) return fail(ctx.res, 4004, '会话不存在');
  if (r.expire_at < now() || r.consumed) return fail(ctx.res, 4008, '会话已失效');
  if (r.state !== 0) return fail(ctx.res, 4009, '会话状态异常');
  run('UPDATE qr SET state=3, user_id=? WHERE once_token=?', ctx.user.id, onceToken);
  log({ tenant_id: ctx.user.tenant_id, user_id: ctx.user.id, user_name: ctx.user.user_name, ip: ctx.ip,
    method: 'POST', path: ctx.path, status: 0, detail: '扫码确认登录 onceToken=' + onceToken.slice(0, 8) });
  ok(ctx.res, { confirmed: true });
}, { auth: true });

R('GET', '/base/api/auth/scan/info', async (ctx) => {
  const r = get('SELECT * FROM qr WHERE once_token=?', ctx.query.t);
  if (!r) return fail(ctx.res, 4004, '会话不存在');
  ok(ctx.res, { onceToken: r.once_token, tenantId: r.tenant_id, expireAt: r.expire_at,
    state: r.state, ua: r.ua, created: r.created_at });
}, { encrypt: false });

/* ---------- 跨应用一次性 token ---------- */
R('POST', '/base/api/auth/swap/once/token', async (ctx) => {
  const t = randomId(24);
  run('INSERT INTO once_tokens VALUES(?,?,?,?,?)', t, ctx.user.id, ctx.user.tenant_id, now() + 60000, 0);
  ok(ctx.res, { accessToken: t });
}, { auth: true });

R('GET', '/base/api/auth/swap/token/byonce', async (ctx) => {
  const t = ctx.query.oncetoken;
  const r = get('SELECT * FROM once_tokens WHERE token=?', t);
  if (!r || r.expire_at < now() || r.used) return fail(ctx.res, 401, '凭证无效');
  run('UPDATE once_tokens SET used=1 WHERE token=?', t);   // 一次性
  const u = get('SELECT * FROM users WHERE id=?', r.user_id);
  ok(ctx.res, { accessToken: newSession(u, 'swap'), userName: u.user_name });
}, { encrypt: false });

/* ---------- 机构树（数据域） ---------- */
R('GET', '/base/api/organizationUnit/all', async (ctx) => {
  const u = ctx.user;
  const parentId = ctx.query.parentId || '0';
  const me = get('SELECT * FROM orgs WHERE id=?', u.org_id);
  if (!me) return fail(ctx.res, 404, '机构不存在');
  let target = me.id;
  if (parentId !== '0') {
    const p = get('SELECT * FROM orgs WHERE id=? AND tenant_id=?', parentId, u.tenant_id);
    if (!p) return fail(ctx.res, 404, '机构不存在');
    if (!p.path.startsWith(me.path)) return fail(ctx.res, 403, '无权访问该机构');
    target = parentId;
  }
  const rows = all('SELECT * FROM orgs WHERE tenant_id=? AND parent_id=? ORDER BY level,id', u.tenant_id, target)
    .map(o => ({ id: o.id, displayName: o.name, parentId: o.parent_id, unitAttr: o.unit_attr,
      level: o.level, path: o.path }));
  ok(ctx.res, rows);
}, { auth: true, page: 'base_org' });

R('POST', '/base/api/organizationUnit/queryOrgByName', async (ctx) => {
  const { name = '' } = ctx.body, u = ctx.user;
  const me = get('SELECT * FROM orgs WHERE id=?', u.org_id);
  const rows = all('SELECT * FROM orgs WHERE tenant_id=? AND path LIKE ? ORDER BY level', u.tenant_id, me.path + '%')
    .filter(o => !name || o.name.includes(name))
    .map(o => ({ id: o.id, displayName: o.name, unitAttr: o.unit_attr, level: o.level }));
  ok(ctx.res, rows);
}, { auth: true });

/* ---------- 业务：学生 / 教师 / 班级 ---------- */
const pageArgs = (body) => ({
  pageIndex: Math.max(1, Number(body.pageIndex || 1)),
  pageSize: Math.min(100, Math.max(1, Number(body.pageSize || 10))),
});
const BIZ = { student: [], teacher: [], klass: [] };
(function seedBiz() {
  const names = ['王小明', '李思远', '张一诺', '陈佳怡', '刘子轩', '赵雨桐', '周景行', '吴梓涵', '徐若晨', '孙博文',
    '马晨曦', '朱可欣', '胡亦然', '郭沐阳', '何书瑶', '高子墨', '林知夏', '罗嘉言', '郑安稳', '梁予安'];
  const orgs = ['O104', 'O105', 'O106'];
  names.forEach((n, i) => BIZ.student.push({
    id: 'S' + String(1000 + i), tenantId: 'T1001', orgId: orgs[i % 3], name: n,
    studentNo: '2026' + String(100 + i), gender: i % 2 ? '女' : '男',
    phone: '139' + String(10000000 + i), status: 0,
  }));
  ['语文', '数学', '英语', '物理', '化学'].forEach((s, i) => BIZ.teacher.push({
    id: 'E' + String(2000 + i), tenantId: 'T1001', orgId: 'O100', name: '教师' + (i + 1),
    subject: s, phone: '137' + String(20000000 + i), status: 0,
  }));
  ['五年级1班', '五年级2班', '六年级1班', '初一1班'].forEach((c, i) => BIZ.klass.push({
    id: 'C' + String(3000 + i), tenantId: 'T1001', orgId: ['O104', 'O104', 'O105', 'O106'][i],
    name: c, headTeacher: '教师' + (i + 1), count: 40 + i, status: 0,
  }));
})();
function domainFilter(u, rows) {
  const me = get('SELECT * FROM orgs WHERE id=?', u.org_id);
  if (!me) return [];
  return rows.filter(r => {
    const o = get('SELECT * FROM orgs WHERE id=?', r.orgId);
    return o && o.path.startsWith(me.path);
  });
}
const paged = (list, body) => {
  const { pageIndex, pageSize } = pageArgs(body);
  return { list: list.slice((pageIndex - 1) * pageSize, pageIndex * pageSize), total: list.length, pageIndex, pageSize };
};

R('POST', '/base/api/student/page', async (ctx) => {
  ok(ctx.res, paged(domainFilter(ctx.user, BIZ.student.filter(s => s.tenantId === ctx.user.tenant_id)), ctx.body));
}, { auth: true, page: 'base_student' });

R('POST', '/base/api/student/save', async (ctx) => {
  if (!hasBtn(ctx.user, 'base_student_insert')) return fail(ctx.res, 403, '暂无权限');
  const b = ctx.body;
  if (!b.name || !b.orgId) return fail(ctx.res, 400, '姓名与机构不能为空');
  const org = get('SELECT * FROM orgs WHERE id=? AND tenant_id=?', b.orgId, ctx.user.tenant_id);
  const me = get('SELECT * FROM orgs WHERE id=?', ctx.user.org_id);
  if (!org || !org.path.startsWith(me.path)) return fail(ctx.res, 403, '无权在该机构下建学生');
  BIZ.student.push({ id: 'S' + randomId(4).toUpperCase(), tenantId: ctx.user.tenant_id, orgId: b.orgId,
    name: b.name, studentNo: b.studentNo || '', gender: b.gender || '男', phone: b.phone || '', status: 0 });
  log({ tenant_id: ctx.user.tenant_id, user_id: ctx.user.id, user_name: ctx.user.user_name, ip: ctx.ip,
    method: 'POST', path: ctx.path, status: 0, detail: '新增学生 ' + b.name });
  ok(ctx.res, true);
}, { auth: true });

R('POST', '/base/api/teacher/page', async (ctx) => {
  ok(ctx.res, paged(domainFilter(ctx.user, BIZ.teacher.filter(s => s.tenantId === ctx.user.tenant_id)), ctx.body));
}, { auth: true, page: 'base_teacher' });

R('POST', '/base/api/class/page', async (ctx) => {
  ok(ctx.res, paged(domainFilter(ctx.user, BIZ.klass.filter(s => s.tenantId === ctx.user.tenant_id)), ctx.body));
}, { auth: true, page: 'base_class' });

/* ---------- 审计日志 ---------- */
R('GET', '/base/api/audit/page', async (ctx) => {
  const { pageIndex = 1, pageSize = 20 } = ctx.query;
  const rows = all('SELECT * FROM audit WHERE tenant_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
    ctx.user.tenant_id, Number(pageSize), (Number(pageIndex) - 1) * Number(pageSize));
  const total = get('SELECT COUNT(*) c FROM audit WHERE tenant_id=?', ctx.user.tenant_id).c;
  ok(ctx.res, { list: rows, total });
}, { auth: true, page: 'sys_audit' });

/* ============================ 分发 ============================ */
// CORS：允许同 Host、localhost、以及本机所有网卡地址（局域网访问时 Origin 也是这些）
function localOrigins(req) {
  const set = new Set([
    `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
    `https://localhost:${PORT}`,
  ]);
  if (req.headers.host) { set.add('http://' + req.headers.host); set.add('https://' + req.headers.host); }
  for (const list of Object.values(require('node:os').networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        set.add(`http://${ni.address}:${PORT}`);
        set.add(`https://${ni.address}:${PORT}`);
      }
    }
  }
  return set;
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '';

  const origin = req.headers.origin;
  const allow = localOrigins(req);
  const cors = {};
  if (origin && allow.has(origin)) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Credentials'] = 'true';
    cors['Access-Control-Allow-Headers'] = 'authorization,content-type,yscry,yscrys,x-ts,x-nonce';
    cors['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    cors['Vary'] = 'Origin';
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...SEC_HEADERS, ...cors }); return res.end(); }

  /* ---------- 访问口令（设 ACCESS_CODE 后生效，公网部署必开） ---------- */
  if (ACCESS_CODE) {
    const jar = Object.fromEntries(String(req.headers.cookie || '').split(';')
      .map(s => s.trim().split('=')).filter(a => a.length === 2));
    const want = hmac('gate:' + ACCESS_CODE).slice(0, 24);
    if (jar.ac !== want) {
      const given = url.searchParams.get('code');
      if (given === ACCESS_CODE) {
        res.writeHead(302, { Location: '/', 'Set-Cookie': `ac=${want}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`, ...SEC_HEADERS });
        return res.end();
      }
      const gate = `<!DOCTYPE html><meta charset="utf-8"><title>访问口令</title>
        <style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0f1b2d;color:#e8f0f8;
        font:14px/1.7 -apple-system,"Microsoft YaHei",sans-serif}form{background:#16263d;border:1px solid #27405f;
        border-radius:14px;padding:28px;width:320px}h3{margin:0 0 6px}p{color:#8fa6bf;font-size:12.5px;margin:0 0 16px}
        input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #27405f;background:#0e1a2b;color:#e8f0f8;
        box-sizing:border-box;margin-bottom:12px}button{width:100%;padding:10px;border:0;border-radius:8px;
        background:#37b3a2;color:#04201c;font-weight:700;cursor:pointer}</style>
        <form method="get" action="/__gate">
          <h3>智慧校园平台</h3><p>请输入访问口令后继续</p>
          <input name="code" placeholder="访问口令" autofocus autocomplete="off" />
          <button>进入</button>
        </form>${given ? '<p style="color:#e2574c;margin-top:10px">口令不正确</p>' : ''}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS, ...cors });
      return res.end(gate);
    }
  }

  if (!pathname.startsWith('/base/api/')) {
    const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory())
      return send(res, 404, { code: 404, msg: 'Not Found' }, { ...SEC_HEADERS, ...cors });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ...SEC_HEADERS, ...cors });
    return res.end(fs.readFileSync(full));
  }

  const route = routes.find(r => r.method === req.method && r.p === pathname);
  if (!route) return send(res, 404, { code: 404, msg: 'Not Found', success: false }, { ...SEC_HEADERS, ...cors });

  // 鉴权前置
  let user = null;
  if (route.auth) {
    user = authUser(req);
    if (!user) return send(res, 200, { code: 401, msg: '请登录后再操作', data: null, success: false }, { ...SEC_HEADERS, ...cors });
    if (route.page && !hasPage(user, route.page))
      return send(res, 200, { code: 403, msg: '暂无权限', data: null, success: false }, { ...SEC_HEADERS, ...cors });
  }

  const body = route.encrypt === false ? await rawBody(req) : await readBody(req);
  if (body.__err) return send(res, 200, { code: 400, msg: body.__err, data: null, success: false }, { ...SEC_HEADERS, ...cors });
  if (body.__plain) return send(res, 200, { code: 400, msg: '请求必须加密（yscryp 缺失）', data: null, success: false }, { ...SEC_HEADERS, ...cors });

  const ctx = { req, res, body, query: Object.fromEntries(url.searchParams), user, ip, path: pathname };
  const _writeHead = res.writeHead.bind(res);
  res.writeHead = (status, headers) => _writeHead(status, { ...SEC_HEADERS, ...cors, ...headers });
  try {
    await route.fn(ctx);
    log({ tenant_id: user ? user.tenant_id : '', user_id: user ? user.id : '', user_name: user ? user.user_name : '',
      ip, method: req.method, path: pathname, status: 0 });
  } catch (e) {
    console.error('[ERR]', pathname, e);
    if (!res.headersSent) send(res, 200, { code: 500, msg: '服务器异常', data: null, success: false });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('node:os');
  const ips = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  console.log(`\n智慧校园平台（同类实现）已启动，监听 0.0.0.0:${PORT}`);
  console.log(`  本机     http://127.0.0.1:${PORT}/`);
  ips.forEach(ip => console.log(`  局域网   http://${ip}:${PORT}/   ← 同一 WiFi/网段的设备可直接打开`));
  console.log(`  后台     http://127.0.0.1:${PORT}/admin.html`);
  console.log(`\n演示账号：admin / Admin@2026 · teacher1 / Teach@2026 · root / Root@2026`);
  console.log(`数据目录：${DATA_DIR}${ACCESS_CODE ? '   访问口令：已启用' : ''}\n`);
});
