# AI 校园管理系统（同类实现）

按逆向出来的架构重做的可运行系统：**多租户 + 机构树 + 三种登录 + 请求加密 + RBAC + 注册审批**。
原系统（元素 ecscc `zhxy`）的每个缺陷，这里都换成了正确实现，并可用一次冒烟测试自证。

## 启动

```powershell
cd D:\Projects\zhxy-clone
node server.js            # 默认 8099，可传端口：node server.js 9000
node smoke.js             # 端到端测试（35 项）
```

打开 <http://127.0.0.1:8099/>

| 页面 | 地址 |
|---|---|
| 登录页（账号 / 短信 / 扫码 / 注册） | `/` |
| 管理后台（按权限渲染） | `/admin.html` |
| 手机端扫码确认 | `/scan.html?t=<onceToken>` |

演示账号（租户 `demo`）：

| 账号 | 密码 | 角色 | 权限差异 |
|---|---|---|---|
| `admin` | `Admin@2026` | 学校管理员 | 全部业务页 + 注册审批 + 审计 |
| `head1` / `head2` | `Head@2026` | 班主任 | 学生/班级/成绩/通知/请假；可录入成绩、审批请假 |
| `teacher1` | `Teach@2026` | 教师 | 只读：学生/班级/成绩/通知，无任何写权限 |
| `root` | `Root@2026` | 超级管理员 | 通配权限 `*`

## 让别人访问

服务监听 `0.0.0.0`，三种入口：

| 场景 | 地址 | 说明 |
|---|---|---|
| 本机 | `http://127.0.0.1:8099/` | — |
| **同一局域网** | `http://<本机IP>:8099/` 例：`http://192.168.1.9:8099/` | 同一 WiFi/网段直接打开；本机防火墙三个配置文件已关闭，无需额外放行 |
| **公网（异地/手机流量）** | `https://xxx.trycloudflare.com` | 跑 `.\tunnel.ps1` 生成，每次重启域名会变 |

```powershell
.\tunnel.ps1            # 起公网隧道（自动下载 cloudflared 到 D:\Programs\cloudflared）
.\tunnel.ps1 9000       # 指定端口
Stop-Process -Id <PID>  # 关闭隧道
```

服务端所有对外链接（`platformGatewayUrl`、扫码 `scanUrl`）都跟随请求的 `Host` / `X-Forwarded-Proto` 生成，所以局域网 IP、隧道域名、本机 127.0.0.1 三种访客拿到的链接都是对的。

> 公网隧道是**无鉴权直达**：任何人拿到链接就能登演示账号、改演示数据。演示完记得关掉隧道；要长期对外开放，先加访问码或改成只读演示租户。

## 技术栈

| 层 | 选择 | 说明 |
|---|---|---|
| HTTP | `node:http` 手写路由 | 零框架，便于看清鉴权/加密/分发的顺序 |
| 存储 | `node:sqlite`（内置） | 单文件 `data.db`，无外部依赖 |
| 密码 | `scrypt` + 随机盐 | `salt$hash` 存库 |
| 加密 | `AES-256-CBC` + `HmacSHA256` | 前端 WebCrypto 加密，后端解密验签 |
| 二维码 | `qrcode` | 唯一的第三方包 |
| 前端 | 原生 JS + CSS | 无构建、无 CDN，双击即用 |

## 架构

```
浏览器 ──① 取平台配置（含加密参数）──▶ /base/api/open/config/platform/config/v2
        ──② 所有业务请求：AES 加密 body + HMAC 签名 + x-ts + x-nonce ──▶ 网关
                                                                        │
                       鉴权前置（先验 token，再校验参数） ◀──────────────┘
                       参数校验 → 数据域（orgs.path 前缀）→ 业务
```

- **请求信封**：`{ code, msg, data, success }`，`code 0=成功 / 401=未登录 / 403=无权限`
- **加密协议**：body 变成 `{"yscryp":"<base64>"}`，头带 `yscry: ysr2a`、`yscrys: <hmac>`、`x-ts`、`x-nonce`
- **机构数据域**：每个机构有 `path`（如 `O100,O101,O104`），读写都要求目标机构的 `path` 以自己机构的 `path` 为前缀
- **权限**：`page` 码控制接口访问，`btn` 码控制写操作，**两者都在服务端校验**

## 功能清单

| 模块 | 接口 | 说明 |
|---|---|---|
| 平台配置 | `GET /base/api/open/config/platform/config/v2` | 下发网关地址与加密参数 |
| 租户 | `GET /base/api/tenant/query?uniqueName=` | 域名/标识 → 租户 |
| 图形码 | `GET /base/api/auth/checkCode/image` | SVG 验证码，带干扰线与随机旋转，一次性 |
| 短信 | `POST /base/api/auth/sms/code/send` | 60 秒/号 + 10 分钟 5 次/IP |
| 密码登录 | `POST /base/api/auth/loginByUserPwdNoOrg` | 失败计数、2 次后强制图形码、5 次锁 15 分钟 |
| 短信登录 | `POST /base/api/auth/loginByPhoneSms` | 验证码一次性 |
| 用户详情 | `GET /base/api/auth/user/current/detail` | 返回角色 + 页面/按钮权限码 |
| 扫码登录 | `POST /base/api/auth/getLoginQrCode` + `getLoginStatus` + `scan/confirm` | onceToken 服务端生成、一次性、轮询限流、确认页展示发起方 |
| 注册 | `POST /base/api/auth/signUp/v2` | 提交申请，**不建号** |
| 审批 | `POST /base/api/auth/register/apply` | 需 `base_apply_pass` 按钮权限，批准才建号 |
| 机构树 | `GET /base/api/organizationUnit/all?parentId=` | 按数据域过滤 |
| 学生/教师/班级 | `POST /base/api/student|teacher|class/page` | 分页 + 数据域 |
| 一次性 Token | `POST /base/api/auth/swap/once/token` → `GET …/byonce?oncetoken=` | 60 秒、用一次即失效 |
| 审计 | `GET /base/api/audit/page` | 谁在何时调了什么 |
| **成绩** | `POST /base/api/score/page` / `score/save` | 学科/班级/姓名筛选，返回均分、及格率、分学科统计；录入校验 0~100 + 数据域 |
| **通知** | `POST /base/api/notice/page` / `notice/save` / `GET notice/detail` | 置顶排序、搜索、阅读计数；发布需按钮权限 |
| **请假** | `POST /base/api/leave/page` / `leave/apply` / `leave/approve` | 状态流转 待审→通过/驳回，审批校验数据域 |
| **AI 问答** | `POST /base/api/ai/chat` | SSE 流式；云端 API → 本机 Ollama → 离线兜底 |

## 与原系统的对照（每一条都是实测过的缺陷 → 这里的修法）

| 原系统缺陷 | 本实现 |
|---|---|
| AES 密钥硬编码在前端 CDN，服务端还接受明文 | 服务端**强制**要求密文，明文直接 `400 请求必须加密`；密钥走环境变量 |
| 签名不含时间戳/nonce，可重放 | `x-ts` 5 分钟窗口 + `x-nonce` 一次性，重放返回 `400 重放请求` |
| CORS 反射任意 Origin + 允许凭据 | 白名单反射，非白名单不下发 `ACAO` |
| 扫码 `onceToken` 由调用方生成 → 谁持有谁拿会话 | 服务端 `uuid()` 生成、一次性消费、1.5 秒轮询限流、确认页显示发起方 UA |
| 未授权可遍历全量机构树（含经纬度） | 需登录 + `base_org` 权限 + `path` 前缀过滤，且不返回经纬度 |
| 参数校验先于鉴权（500 假信号 + 字段结构泄露） | 鉴权在路由分发最前，未登录一律 `401`，不进入参数校验 |
| 未授权改他人注册申请（IDOR） | 审批接口校验 token + 按钮权限 + 租户归属 |
| 注册可被脚本化绕过（图形码仅一道防线） | 短信 60 秒/号 + IP 频控 + 注册必须管理员批准 |
| 按钮权限只在前端 `v-if` | `student/save`、`register/apply` 等写接口在服务端校验 `btn` 码 |
| 缺 `XFO` / `CSP` / `HSTS` / `XCTO` | 全部下发（`SAMEORIGIN` + `default-src 'self'`） |
| `loginPageInfo` 用 `eval` 反序列化 | 全部改为 `JSON.parse` |

## 冒烟测试覆盖（35 项，全绿）

```
✅ 租户解析 / 租户策略            ✅ 拒绝明文请求
✅ 重放同一 nonce 被拒            ✅ 错误口令计数 → 第 3 次强制图形码
✅ 管理员登录 / 用户详情+权限      ✅ 数据域内读列表
✅ 跨机构写入被拒                 ✅ 本机构写入成功
✅ 教师访问审批页被拒（page 码）    ✅ 教师无按钮码 → 服务端拒绝
✅ CORS 非白名单不下发 ACAO       ✅ CORS 白名单正常
✅ 扫码：签发→state0→限流→确认→拿 token→二次轮询不发票据
✅ 一次性 token：首次成功/二次拒绝  ✅ 短信频控
✅ 注册→待审（不建号）→ 无权限者审批被拒 → 管理员批准 → 新账号可登录
✅ 未开放注册的租户拒绝           ✅ 未登录访问业务接口 401
```

## 目录

```
server.js          后端全部逻辑（路由/加密/鉴权/权限/业务/审计）
smoke.js           端到端测试
public/
  index.html       登录页（账号 / 短信 / 扫码 / 注册）
  admin.html       管理后台（侧边栏按 page 权限渲染，按钮按 btn 权限渲染）
  scan.html        手机端扫码确认页
  app.js           加密层 + 请求封装（WebCrypto）
  style.css        样式
data.db            SQLite 数据（首次启动自动建表 + 种子）
```

## AI 智能助手

后端 `/base/api/ai/chat` 是一个 **OpenAI 兼容代理**，三层回退：

| 优先级 | 条件 | 说明 |
|---|---|---|
| 1 | 配了 `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL` | 任意 OpenAI 兼容服务（DeepSeek/通义/OpenAI/Moonshot…） |
| 2 | 本机 `127.0.0.1:11434` 有 Ollama 模型 | 自动探测并选用 qwen/llama/deepseek 系模型，**无需 key** |
| 3 | 都没有 | 返回内置知识库答案（平台使用类问题） |

- 密钥只在服务端使用，永不下发浏览器；
- 响应是 **SSE 流式**，前端逐字渲染；离线兜底返回普通 JSON；
- 需要登录才能用（防白嫖）；
- 系统提示词限定了助手角色：只答平台使用与一般教育咨询，不编造功能。

```bash
# 用云端模型
AI_BASE_URL=https://api.deepseek.com/v1 AI_API_KEY=sk-xxx AI_MODEL=deepseek-chat node server.js
# 用本机 Ollama（什么都不用配，自动探测）
node server.js
```

## 演示环境专用接口

`SHOW_DEV_CODE=1` 时额外开放（生产请设 `0`）：

| 接口 | 用途 |
|---|---|
| `POST /base/api/dev/reset-user` | 重置某账号的失败计数/锁定 |
| `POST /base/api/dev/reset-sms-limit` | 清短信频控记录（`clearCodes:true` 连验证码一起清） |
| `POST /base/api/dev/seed-reset` | 清理测试注册申请 |

## 改造建议（想接真实业务时）

1. `BIZ` 三张内存表换成 SQLite 表，加租户/机构索引。
2. 加密密钥改为「会话派生」：登录后用会话临时密钥，`config` 接口只下发非敏感参数。
3. 短信换成真实服务商，`devCode` 在 `NODE_ENV=production` 下自动关闭（已内置）。
4. 扫码确认页接入微信/钉钉授权，替换现在的「手机端先登录再确认」。
5. 分页参数统一 `pageIndex/pageSize`，并对 `pageSize` 上限做服务端夹取（已内置 100）。
