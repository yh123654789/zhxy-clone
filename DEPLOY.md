# 部署到云服务器（长期在线）

目标：**不依赖你本机开机**、7×24 可访问。四条路，按「多久能上线 / 花多少钱」排序。

| 方案 | 费用 | 上线耗时 | 需要你做什么 | 适合 |
|---|---|---|---|---|
| **A. Render 免费** | 0 元 | 5 分钟 | GitHub 登录 + 3 次点击 | 立刻能用，给别人看 |
| **B. Oracle Cloud 永久免费** | 0 元 | 20 分钟 | 注册（需信用卡验证，扣 1 美元后退回）+ SSH 跑一条命令 | 长期稳定、不休眠、完全可控 |
| **C. 国内轻量云** | 9.9~24 元/月 | 15 分钟 | 实名 + 支付 + SSH 跑一条命令 | 国内访问最快、最稳 |
| **D. Fly.io** | 约 $2~5/月 | 10 分钟 | 绑卡 + `flyctl deploy` | 要持久卷又不想管服务器 |

> 代码已在 GitHub：**<https://github.com/yh123654789/zhxy-clone>**
> 部署包也在桌面：`zhxy-clone-deploy.zip`（Docker / systemd / Caddy / fly / render 配置全在里面）

---

## A. Render 免费层（最快）

1. 打开 <https://render.com> → **Get Started** → 用 GitHub 账号 `yh123654789` 登录授权
2. 右上 **New +** → **Blueprint**
3. 选仓库 **zhxy-clone** → **Connect** → 它会自动读 `render.yaml` → **Apply**
4. 等 2~3 分钟，拿到地址：`https://zhxy-clone-xxxx.onrender.com`

**注意**
- 免费实例 **15 分钟无访问会休眠**，下次打开要冷启动约 30 秒（不是坏，是免费层的机制）。要避免休眠用 B / C / D。
- 免费层**没有持久磁盘**，每次重新部署数据重置（会自动重新种演示数据，够看）。
- `ACCESS_CODE` 在 Render 控制台 → Environment 里填，填了就要口令才能打开。

## B. Oracle Cloud 永久免费（0 元且不休眠，推荐长期用）

1. 注册 <https://www.oracle.com/cloud/free/>，选 **Always Free**，信用卡验证（不扣费）
2. 创建实例：**Ampere A1 (ARM) / 1 OCPU / 6 GB / Ubuntu 24.04**，勾选分配公网 IP
3. 安全列表放行入站：`22`、`80`、`443`、`8099`
4. 本地执行（把 `<IP>` 换掉）：

```powershell
cd D:\Projects\zhxy-clone
scp -r server.js package.json package-lock.json public ubuntu@<IP>:/tmp/zhxy/
scp install.sh ubuntu@<IP>:/tmp/
ssh ubuntu@<IP> "sudo mkdir -p /opt/zhxy-clone && sudo cp -r /tmp/zhxy/* /opt/zhxy-clone/ && cd /opt/zhxy-clone && sudo bash /tmp/install.sh"
```

`install.sh` 会：装 Node 24 → 拷代码 → 生成随机访问口令 → 写 systemd（`Restart=always`）→ 开防火墙 → 打印访问地址和口令。

有域名时加参数即可自动配 HTTPS：

```powershell
ssh ubuntu@<IP> "cd /opt/zhxy-clone && sudo bash /tmp/install.sh demo.yourdomain.com"
```

## C. 国内轻量云（腾讯云 / 阿里云学生机）

和 B 完全一样的步骤，只是：
- 系统选 **Ubuntu 22.04 / 24.04**
- 防火墙在**控制台安全组**里放行 `8099`（或 `80/443`）
- 域名要备案才能绑 80/443，**直接用 `http://IP:8099` 不需要备案**

## D. Fly.io（要持久卷）

```powershell
# 安装 CLI（一次）
iwr https://fly.io/install.ps1 -useb | iex
flyctl auth login
cd D:\Projects\zhxy-clone
flyctl launch --no-deploy --copy-config
flyctl volumes create data --size 1 --region nrt
flyctl secrets set ACCESS_CODE=你的口令
flyctl deploy
```

`fly.toml` 里已设 `auto_stop_machines = false`、`min_machines_running = 1`，不会休眠；`/data` 挂卷，数据持久。

---

## 部署时会被用到的配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8099` | 监听端口（Render/Fly 会注入自己的值） |
| `DATA_DIR` | 程序目录 | SQLite 放这里；云上指向持久卷（如 `/data`） |
| `ACCESS_CODE` | 空 | 设了就要求访问口令（公网**务必**设置） |
| `SHOW_DEV_CODE` | `1` | 演示用：短信/图形验证码直接回显。正式对外设 `0` |
| `NODE_ENV` | — | `production` 时不再打印调试细节 |

**Node 版本必须 ≥ 24**（`node:sqlite` 在 22 需要实验标志，23.4+ 才默认开启）。仓库里已放 `.node-version` = `24`，`engines.node >= 24`，Docker 用 `node:24-slim`，`install.sh` 装 NodeSource 24。

## 部署后自检

```bash
curl -s http://<地址>/base/api/tenant/query?uniqueName=demo      # 应返回 {"code":0,...,"id":"T1001"}
journalctl -u zhxy-clone -f        # systemd 部署看日志
docker compose logs -f web         # Docker 部署看日志
```
