/**
 * 直接登录并展示"登录之后能看到什么"
 *   node demo.js [tenantId]
 * 走完整加密链路（AES + HMAC + ts + nonce）登录，然后拉核心接口，把结果按界面结构打印出来。
 */
'use strict';
const crypto = require('node:crypto');
const BASE = 'http://127.0.0.1:8099';
const TE = (s) => Buffer.from(s, 'utf8');
const b64 = (b) => Buffer.from(b).toString('base64');
let CRY = null;

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
    'x-ts': String(Date.now()), 'x-nonce': crypto.randomUUID() } };
}
async function call(method, path, data = {}, opt = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
  let body;
  if (opt.plain) body = JSON.stringify(data);
  else { const e = enc(data); body = JSON.stringify(e.body); Object.assign(headers, e.headers); }
  const json = await fetch(BASE + path, { method, headers, body: method === 'GET' ? undefined : body }).then(x => x.json());
  return json;
}

const line = (c = '─') => console.log(c.repeat(74));
const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

async function login(userName, password, tenantId) {
  let r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', { tenantId, userName, password });
  // 该账号历史失败 ≥2 次时服务端强制图形验证码 —— 演示环境 devCode 直接回显，自动过码
  if (r.code === 2001 && r.data && r.data.needCode) {
    const cap = await call('GET', '/base/api/auth/checkCode/image', {}, { method: 'GET', plain: true });
    if (cap.code === 0) {
      r = await call('POST', '/base/api/auth/loginByUserPwdNoOrg', {
        tenantId, userName, password,
        checkCode: cap.data.devCode, checkCodeSessionId: cap.data.checkCodeSessionId,
      });
    }
  }
  if (r.code !== 0) throw new Error(r.msg);
  return r.data.userToken.accessToken;
}

(async () => {
  const T = process.argv[2] || 'T1001';
  await cfg();

  /* ---------- 1. 登录 ---------- */
  console.log('\n【1】走加密链路登录（AES-256-CBC 加密 body + HMAC 签名 + 时间戳 + nonce）\n');
  const adminToken = await login('admin', 'Admin@2026', T);
  console.log(`  身份：admin / Admin@2026        租户：${T}`);
  console.log(`  accessToken：${adminToken.slice(0, 24)}…（32 字节随机）`);

  const me = await call('GET', '/base/api/auth/user/current/detail', {}, { token: adminToken });
  const p = me.data.permissions;
  console.log(`\n  姓名：${me.data.realName}    机构：${me.data.orgName}（${me.data.orgId}）    角色：${me.data.roleName}`);
  console.log(`  页面权限码：${p.pages.join(', ')}`);
  console.log(`  按钮权限码：${p.btns.join(', ')}`);

  /* ---------- 2. 概览 ---------- */
  console.log('\n【2】后台首页统计\n');
  const st = await call('POST', '/base/api/student/page', { pageIndex: 1, pageSize: 1 }, { token: adminToken });
  const te = await call('POST', '/base/api/teacher/page', { pageIndex: 1, pageSize: 1 }, { token: adminToken });
  const kl = await call('POST', '/base/api/class/page', { pageIndex: 1, pageSize: 1 }, { token: adminToken });
  const ap = await call('POST', '/base/api/auth/register/apply/page', { pageIndex: 1, pageSize: 1 }, { token: adminToken });
  console.log(`  ┌──────────────┬──────────────┬──────────────┬──────────────┐`);
  console.log(`  │ 学生 ${padL(st.data.total, 8)}   │ 教师 ${padL(te.data.total, 8)}   │ 班级 ${padL(kl.data.total, 8)}   │ 待审 ${padL(ap.data.total, 8)}   │`);
  console.log(`  └──────────────┴──────────────┴──────────────┴──────────────┘`);

  /* ---------- 3. 学生列表 ---------- */
  console.log('\n【3】学生管理（按机构数据域过滤）\n');
  const stu = await call('POST', '/base/api/student/page', { pageIndex: 1, pageSize: 6 }, { token: adminToken });
  console.log('  ' + pad('学号', 10) + pad('姓名', 10) + pad('性别', 6) + pad('机构', 8) + '手机号');
  line();
  stu.data.list.forEach(s => console.log('  ' + pad(s.studentNo, 10) + pad(s.name, 10) + pad(s.gender, 6) + pad(s.orgId, 8) + s.phone));
  console.log(`  …共 ${stu.data.total} 条，每页 ${stu.data.pageSize} 条`);

  /* ---------- 4. 机构树 ---------- */
  console.log('\n【4】机构树（只能看自己机构及下级）\n');
  async function walk(parentId, depth) {
    const r = await call('GET', `/base/api/organizationUnit/all?parentId=${parentId}`, {}, { token: adminToken });
    if (r.code !== 0 || !r.data) return;
    for (const o of r.data) {
      console.log('  ' + '│  '.repeat(depth) + (depth ? '├─ ' : '') + o.displayName + `  (${o.id}, unitAttr=${o.unitAttr}, L${o.level})`);
      if (depth < 2) await walk(o.id, depth + 1);
    }
  }
  console.log(`  ${me.data.orgName}  (${me.data.orgId})  ← 当前账号所在机构，树从它的子节点开始`);
  await walk('0', 0);
  /* ---------- 5. 越权尝试 ---------- */
  console.log('\n【5】越权测试：跨机构写学生\n');
  const bad = await call('POST', '/base/api/student/save', { name: '越权测试', orgId: 'O201' }, { token: adminToken });
  console.log(`  往 O201（属于另一个租户的机构）新增学生 → ${bad.code === 403 ? '拒绝 ' : '竟然通过 '}${bad.msg}`);
  const okw = await call('POST', '/base/api/student/save', { name: '新增示例', orgId: 'O104' }, { token: adminToken });
  console.log(`  往 O104（自己的下级机构）新增学生 → ${okw.code === 0 ? '成功' : okw.msg}`);

  /* ---------- 6. 教师登录对比 ---------- */
  console.log('\n【6】换教师账号登录，看权限收窄\n');
  const teacherToken = await login('teacher1', 'Teach@2026', T);
  const tme = await call('GET', '/base/api/auth/user/current/detail', {}, { token: teacherToken });
  console.log(`  ${tme.data.realName} / ${tme.data.roleName}`);
  console.log(`  页面权限码：${tme.data.permissions.pages.join(', ') || '（无）'}`);
  console.log(`  按钮权限码：${tme.data.permissions.btns.join(', ') || '（无）'}`);
  const t1 = await call('POST', '/base/api/auth/register/apply/page', { pageIndex: 1, pageSize: 1 }, { token: teacherToken });
  console.log(`  访问「注册审批」页 → ${t1.code === 403 ? '403 暂无权限' : t1.msg}`);
  const t2 = await call('POST', '/base/api/student/save', { name: 'x', orgId: 'O104' }, { token: teacherToken });
  console.log(`  调「新增学生」接口（绕过前端按钮）→ ${t2.code === 403 ? '403 暂无权限（服务端独立校验）' : t2.msg}`);

  /* ---------- 7. 审计 ---------- */
  console.log('\n【7】审计日志（最后 6 条）\n');
  const au = await call('GET', '/base/api/audit/page?pageIndex=1&pageSize=6', {}, { token: adminToken });
  console.log('  ' + pad('时间', 21) + pad('操作人', 12) + pad('方法', 6) + '路径');
  line();
  au.data.list.reverse().forEach(a => console.log('  ' + pad(new Date(a.ts).toLocaleString('zh-CN'), 21)
    + pad(a.user_name || '-', 12) + pad(a.method, 6) + a.path));

  console.log(`\n【可直接访问的后台链接】\n  ${BASE}/admin.html?token=${adminToken}\n`);
})();
