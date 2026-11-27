/**
 * 端到端冒烟测试：验证这套实现的安全设计真的生效
 *   node smoke.js [baseUrl]
 * 覆盖：加密层强制 / 防重放 / 登录锁定 / 图形码 / 数据域越权 / 角色权限 /
 *       扫码登录（含一次性消费）/ 一次性 token / 注册审批流 / CORS 白名单
 */
'use strict';
const crypto = require('node:crypto');
const BASE = process.argv[2] || 'http://127.0.0.1:8099';

let CRY = null;
const TE = (s) => Buffer.from(s, 'utf8');
const b64 = (b) => Buffer.from(b).toString('base64');

async function cfg() {
  const r = await fetch(BASE + '/base/api/open/config/platform/config/v2').then(x => x.json());
  CRY = r.data.cry;
}
function enc(obj) {
  const c = crypto.createCipheriv('aes-256-cbc', TE(CRY.key), TE(CRY.iv));
  const cipher = b64(Buffer.concat([c.update(TE(JSON.stringify(obj))), c.final()]));
  const sig = crypto.createHmac('sha256', TE(CRY.hmac)).update(cipher).digest('hex');
  return { body: { yscryp: cipher }, headers: {
    'Content-Type': 'application/json', yscry: 'ysr2a', yscrys: sig,
    'x-ts': String(Date.now()), 'x-nonce': crypto.randomUUID(),
  } };
}
async function call(method, path, data = {}, opt = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
  if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
  let body, url = BASE + path;
  if (opt.plain) { body = JSON.stringify(data); }
  else { const e = enc(data); body = JSON.stringify(e.body); Object.assign(headers, e.headers); }
  const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

const results = [];
function expect(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  console.log('\n=== 智慧校园平台 · 端到端冒烟测试 ===\n');
  await cfg();
  console.log(`加密参数已下发：key=${CRY.key.slice(0, 8)}… iv=${CRY.iv}\n`);

  /* 1. 租户 */
  let r = await call('GET', '/base/api/tenant/query?uniqueName=demo', {}, { plain: true });
  expect('租户解析 demo', r.json.code === 0 && r.json.data.id === 'T1001', `tenantId=${r.json.data && r.json.data.id}`);
  const T = r.json.data.id;
  expect('租户策略：开放注册 + 需审批', r.json.data.registerEnable === true && r.json.data.needApproval === true);

  /* 2. 明文请求必须被拒 */
  r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId: T, userName: 'admin', password: 'Admin@2026' }, { plain: true });
  expect('拒绝明文请求（服务端强制加密）', r.json.code === 400 && /必须加密/.test(r.json.msg), r.json.msg);

  /* 3. 防重放：同一个 nonce 用两次 */
  const e = enc({ tenantId: T, userName: 'admin', password: 'Admin@2026' });
  const h = { ...e.headers, 'Content-Type': 'application/json' };
  const first = await fetch(BASE + '/base/api/auth/loginByUserPwdNoOrg', { method: 'POST', headers: h, body: JSON.stringify(e.body) }).then(x => x.json());
  const second = await fetch(BASE + '/base/api/auth/loginByUserPwdNoOrg', { method: 'POST', headers: h, body: JSON.stringify(e.body) }).then(x => x.json());
  expect('首次密文请求通过', first.code === 0 && first.data.operationType === 5);
  expect('重放同一 nonce 被拒', second.code === 400 && /重放/.test(second.msg), second.msg);

  /* 4. 错误口令 → 失败计数；连续 2 次后要求图形码 */
  r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId: T, userName: 'teacher1', password: 'wrong' });
  expect('错误口令被拒并计数', r.json.code === 2002 && /1\/5/.test(r.json.msg), r.json.msg);
  r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId: T, userName: 'teacher1', password: 'wrong' });
  expect('第 2 次失败', r.json.code === 2002, r.json.msg);
  r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId: T, userName: 'teacher1', password: 'wrong' });
  expect('第 3 次起强制图形验证码', r.json.data && r.json.data.needCode === true, r.json.msg);

  /* 5. 正常登录（管理员） */
  r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId: T, userName: 'admin', password: 'Admin@2026' });
  expect('管理员登录成功', r.json.code === 0 && r.json.data.operationType === 5);
  const adminToken = r.json.data.userToken.accessToken;

  r = await call('GET', '/base/api/auth/user/current/detail', {}, { token: adminToken });
  expect('获取用户详情 + 权限', r.json.code === 0 && Array.isArray(r.json.data.permissions.pages),
    `${r.json.data.realName} / ${r.json.data.roleName} / pages=${r.json.data.permissions.pages.length}`);

  /* 6. 数据域：管理员在学生列表范围内；写入跨机构应被拒 */
  r = await call('POST', '/base/api/student/page', { pageIndex: 1, pageSize: 5 }, { token: adminToken });
  expect('学生列表（数据域内）', r.json.code === 0 && r.json.data.total > 0, `total=${r.json.data && r.json.data.total}`);
  r = await call('POST', '/base/api/student/save', { name: '越权测试', orgId: 'O201' }, { token: adminToken });
  expect('跨租户/跨机构写入被拒', r.json.code === 403, r.json.msg);
  r = await call('POST', '/base/api/student/save', { name: '正常新增', orgId: 'O104' }, { token: adminToken });
  expect('本机构内写入成功', r.json.code === 0);

  /* 7. 教师登录 → 页面权限受限 */
  r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId: T, userName: 'teacher1', password: 'Teach@2026' });
  // 该账号已被失败计数污染，可能要求验证码；用短信登录更稳
  if (r.json.code !== 0) {
    const sms = await call('POST', '/base/api/auth/sms/code/send', { phone: '13800000002' });
    r = await call('POST', '/base/api/auth/loginByPhoneSms', { tenantId: T, phone: '13800000002', smsCode: String(sms.json.data.devCode) });
  }
  expect('教师登录成功', r.json.code === 0);
  const teacherToken = r.json.data.userToken.accessToken;
  r = await call('POST', '/base/api/auth/register/apply/page', { pageIndex: 1, pageSize: 5 }, { token: teacherToken });
  expect('教师访问「注册审批」被拒（页面权限码）', r.json.code === 403, r.json.msg);
  r = await call('POST', '/base/api/student/save', { name: 'x', orgId: 'O104' }, { token: teacherToken });
  expect('教师无「新增学生」按钮权限 → 服务端拒绝', r.json.code === 403, r.json.msg);

  /* 8. CORS 白名单 */
  const bad = await fetch(BASE + '/base/api/tenant/query?uniqueName=demo', { headers: { Origin: 'https://attacker.example' } });
  expect('非白名单 Origin 不下发 ACAO', !bad.headers.get('access-control-allow-origin'),
    `ACAO=${bad.headers.get('access-control-allow-origin')}`);
  const good = await fetch(BASE + '/base/api/tenant/query?uniqueName=demo', { headers: { Origin: BASE } });
  expect('白名单 Origin 正常下发 ACAO', good.headers.get('access-control-allow-origin') === BASE);

  /* 9. 扫码登录全链路 */
  r = await call('POST', '/base/api/auth/getLoginQrCode', { tenantId: T }, { plain: true });
  expect('签发扫码会话（服务端生成 onceToken）', r.json.code === 0 && /^[0-9a-f-]{36}$/.test(r.json.data.onceToken), r.json.data.onceToken);
  const once = r.json.data.onceToken;
  r = await call('POST', '/base/api/auth/getLoginStatus', { onceToken: once }, { plain: true });
  expect('未扫码时 state=0', r.json.data.state === 0);
  r = await call('POST', '/base/api/auth/getLoginStatus', { onceToken: once }, { plain: true });
  expect('轮询限流生效（1.5s 内重复请求被拒）', r.json.code === 429, r.json.msg);
  await new Promise(x => setTimeout(x, 1600));
  r = await call('POST', '/base/api/auth/scan/confirm', { onceToken: once }, { token: teacherToken });
  expect('手机端确认（需已登录）', r.json.code === 0);
  r = await call('POST', '/base/api/auth/getLoginStatus', { onceToken: once }, { plain: true });
  expect('扫码后拿到会话 token', r.json.data.state === 3 && !!r.json.data.userToken.accessToken);
  await new Promise(x => setTimeout(x, 1600));
  r = await call('POST', '/base/api/auth/getLoginStatus', { onceToken: once }, { plain: true });
  expect('onceToken 一次性：二次轮询不再发 token', r.json.data.state === 5 && !r.json.data.userToken, JSON.stringify(r.json.data));

  /* 10. 一次性 token */
  r = await call('POST', '/base/api/auth/swap/once/token', {}, { token: adminToken });
  const onceT = r.json.data.accessToken;
  expect('换取一次性 token', r.json.code === 0);
  r = await call('GET', '/base/api/auth/swap/token/byonce?oncetoken=' + onceT, {}, { plain: true });
  expect('首次兑换成功', r.json.code === 0 && !!r.json.data.accessToken);
  r = await call('GET', '/base/api/auth/swap/token/byonce?oncetoken=' + onceT, {}, { plain: true });
  expect('二次兑换被拒（一次性）', r.json.code === 401, r.json.msg);

  /* 11. 注册审批流 */
  const phone = '137' + String(Math.floor(Math.random() * 90000000) + 10000000);
  r = await call('POST', '/base/api/auth/sms/code/send', { phone });
  expect('发送注册短信', r.json.code === 0 && !!r.json.data.devCode, `devCode=${r.json.data && r.json.data.devCode}`);
  const code = r.json.data.devCode;
  r = await call('POST', '/base/api/auth/sms/code/send', { phone });
  expect('60 秒内重复发送被限流', r.json.code === 429, r.json.msg);
  r = await call('POST', '/base/api/auth/signUp/v2', {
    tenantId: T, orgId: 'O101', phone, smsCode: code, realName: '新老师', userName: 'newteacher', password: 'New@2026',
  });
  expect('提交注册 → 待审核（不建号）', r.json.code === 0 && r.json.data.state === 2 && r.json.data.accountCreated === false,
    `applyId=${r.json.data && r.json.data.applyId}`);
  const applyId = r.json.data.applyId;
  r = await call('POST', '/base/api/auth/register/apply', { applyId, pass: true }, { token: teacherToken });
  expect('教师无审批权限 → 拒绝', r.json.code === 403, r.json.msg);
  r = await call('POST', '/base/api/auth/register/apply', { applyId, pass: true }, { token: adminToken });
  expect('管理员批准 → 建号成功', r.json.code === 0 && r.json.data.state === 1);
  r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId: T, userName: 'newteacher', password: 'New@2026' });
  expect('新账号可登录', r.json.code === 0 && r.json.data.operationType === 5);

  /* 12. 关闭注册的租户 */
  r = await call('POST', '/base/api/auth/signUp/v2', { tenantId: 'T1003', orgId: 'O300', phone: '13800000009', smsCode: '0000', realName: 'x', userName: 'x', password: 'Xx@20260' });
  expect('未开放注册的租户拒绝注册', r.json.code === 4030, r.json.msg);

  /* 13. 未登录访问受保护接口 */
  r = await call('POST', '/base/api/student/page', {}, {});
  expect('未登录访问业务接口 → 401', r.json.code === 401, r.json.msg);

  const okCount = results.filter(x => x.pass).length;
  console.log(`\n=== 结果：${okCount}/${results.length} 通过 ===`);
  if (okCount !== results.length) {
    console.log('\n未通过项：');
    results.filter(x => !x.pass).forEach(x => console.log(`  - ${x.name} ${x.detail}`));
    process.exit(1);
  }
})();
