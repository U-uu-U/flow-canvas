# configserver — Flow Canvas 模型能力 CONFIG 服务

给 `artconfig.ravenhash.org` 用的配置服务：客户端从 `/config` 拉模型能力表，运营在 `/admin`
用网页交互式编辑、发布、回滚。零框架、零构建，只用 Node 原生模块（唯一可选依赖是 ajv）。

```
客户端（Flow Canvas）  ── GET /config ──►  最新 CONFIG（公开只读，带 ETag）
运营（浏览器）         ── /admin ──────►  密码登录 → 编辑 / 发布 / 回滚 / 删除 / 下载
```

## 1. 目录与数据

```
configserver/
├── server.mjs              入口：路由、鉴权、HTTP 服务（也可 --hash-password 生成密码）
├── lib/store.mjs           版本仓库：时间戳版本文件 + state 指针 + 审计日志
├── lib/validate.mjs        复用客户端那份 JSON Schema（ajv），缺 ajv 时降级为结构校验
├── lib/auth.mjs            scrypt 密码 + 会话 cookie + 登录限流
├── lib/pages.mjs           登录页 / 管理面板 / 落地页
├── schema/                 随包 schema（由 scripts/sync-model-config.mjs 同步，勿手改）
├── seed/                   首次启动的种子配置（同上，勿手改）
└── data/                   ← 运行时数据，不进版本库（.gitignore 已忽略）
    ├── configs/20260911T230012-r7.json   每个版本一个文件，文件名带 UTC 时间戳
    ├── state.json                        当前指针 current + 操作审计
    └── admin.json                        密码哈希（若用文件方式设置密码）
```

**备份 = 备份 `data/` 整个目录。** 版本文件只增不改，回滚只挪 `state.json` 里的指针，
所以「老的自动备份」和「一键应用老的」都不需要额外机制。

## 2. 本地跑起来

```bash
cd configserver
npm install                 # 只装 ajv（可选，但强烈建议：没有它只能做结构校验）
CONFIG_ADMIN_PASSWORD='换成你的密码' npm start
# → http://127.0.0.1:8087/config   （客户端地址）
# → http://127.0.0.1:8087/admin    （管理面板）
```

首次启动会用 `seed/model-config.default.json` 播种一个 `-r0` 版本，所以 `/config` 立刻可用。

## 3. 生产部署（artconfig.ravenhash.org）

服务只监听 `127.0.0.1`，反代与 TLS 由你自己终止——进程本身不直接暴露在公网。

**a) 一键安装（推荐）**

```bash
# 开发机：打部署包（也可直接用 release/ 里已经打好的 tgz）
node scripts/pack-configserver.mjs          # → release/configserver-<版本>-<日期>.tgz
scp release/configserver-*.tgz root@服务器IP:/tmp/

# 服务器：
ssh root@服务器IP
sudo mkdir -p /srv && tar xzf /tmp/configserver-*.tgz -C /srv
cd /srv/configserver-* && sudo ./deploy/install.sh
```

`install.sh` 会：建系统用户 `flowconfig` 与目录 → 复制代码 → 装 ajv → **生成管理密码（只打印这一次）**
→ 写 systemd 单元并启动（只监听 `127.0.0.1:8087`）→ 打印本机自检结果与后续命令。
**重复执行就是升级**，数据与密码保持不变。可用
`--domain` `--port` `--password` `--app-dir` `--data-dir` `--user` `--no-start` 覆盖。
停止 / 卸载见下一节 d)。

**b) 手动安装 / 自定义路径**

下面是没有 systemd、或要自定义目录布局时的等价手工步骤。

**b-1) 放置代码并装依赖**

```bash
sudo mkdir -p /srv/flow-config && sudo chown "$USER" /srv/flow-config
# 把 configserver/ 整个目录拷进去（schema/ 与 seed/ 必须一起拷）
cd /srv/flow-config/configserver && npm install --omit=dev
```

**b) 设置管理密码（三选一，优先级从高到低）**

```bash
# 1) 环境变量明文（最简单，但会出现在 systemd unit / 进程环境里）
CONFIG_ADMIN_PASSWORD='...'

# 2) 环境变量哈希（推荐：明文不落盘、不进 unit 文件）
node server.mjs --hash-password        # 交互输入，不显示；或先设 CONFIG_ADMIN_PASSWORD 再跑
# 把打印出来的 JSON 填到 CONFIG_ADMIN_PASSWORD_HASH='{...}'

# 3) 密码文件 data/admin.json（由 --hash-password 直接写入）
```

**没有配置任何密码时服务会拒绝启动**（fail closed），避免把管理面板裸奔挂在公网。

**c) systemd**

```ini
# /etc/systemd/system/flow-config.service
[Unit]
Description=Flow Canvas model config server
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/flow-config/configserver
Environment=CONFIG_HOST=127.0.0.1
Environment=CONFIG_PORT=8087
Environment=CONFIG_DATA_DIR=/var/lib/flow-config
Environment=CONFIG_PUBLIC_ORIGIN=https://artconfig.ravenhash.org
Environment=CONFIG_ADMIN_PASSWORD_HASH={"algorithm":"scrypt","N":16384,"r":8,"p":1,"keylen":64,"salt":"...","hash":"..."}
ExecStart=/usr/bin/node /srv/flow-config/configserver/server.mjs
Restart=always
User=flowconfig
Group=flowconfig

[Install]
WantedBy=multi-user.target
```

**c) 反向代理：自行配置**

服务**只监听 `127.0.0.1:8087`**，不直接暴露公网。反代（Caddy / nginx / 其它）由你自己配，把请求
转发到 `http://127.0.0.1:8087` 即可。建议带上这两个头：

```
X-Forwarded-For:   $proxy_add_x_forwarded_for     # 登录限流按第一段 IP 计数
X-Forwarded-Proto: $scheme                        # 为 https 时自动给会话 cookie 加 Secure
```

不带头也能跑（限流会退化成按反代 IP 计数，cookie 不带 Secure），客户端本身不强制 https——
你用什么协议、怎么终止 TLS 完全由反代决定。

<details>
<summary>需要进程自己终止 TLS 时（可选）</summary>

```bash
CONFIG_TLS_CERT=/path/fullchain.pem CONFIG_TLS_KEY=/path/privkey.pem npm start
```
</details>

**d) 停止 / 卸载**

```bash
sudo ./deploy/stop.sh                 # 停止（systemd 或手工启动都能停）
sudo ./deploy/stop.sh --status        # 只看状态
sudo ./deploy/stop.sh --disable       # 停止并取消开机自启
sudo ./deploy/stop.sh --uninstall     # 停止 + 取消自启 + 删除 systemd 单元与代码（保留数据）
sudo ./deploy/stop.sh --uninstall --purge   # 连数据目录一起删（会要求二次确认）
```

停止顺序是 **systemd 单元 → PID 文件 → 按监听端口反查进程**，后两种都会先核对进程命令行里确实是
`server.mjs`，不会误杀占用同端口的其它程序。参数与 `install.sh` 一致（`--port` / `--app-dir` /
`--data-dir` / `--user`）。

## 4. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CONFIG_HOST` / `CONFIG_PORT` | `127.0.0.1` / `8087` | 监听地址；默认只对本机开放 |
| `CONFIG_DATA_DIR` | `./data` | 版本库与 state 的存放目录 |
| `CONFIG_ADMIN_PASSWORD` | — | 管理密码明文（≥8 位），启动时即时哈希 |
| `CONFIG_ADMIN_PASSWORD_HASH` | — | scrypt 哈希 JSON，优先于 `data/admin.json` |
| `CONFIG_PUBLIC_ORIGIN` | 空 | 对外域名，用于页面展示与 Origin 校验 |
| `CONFIG_TRUSTED_ORIGIN` | 空 | 额外允许的 Origin（同源反代时一般不用） |
| `CONFIG_COOKIE_SECURE=1` | 关 | 强制会话 cookie 带 `Secure`（反代没传 `X-Forwarded-Proto` 时用） |
| `CONFIG_TLS_CERT` / `CONFIG_TLS_KEY` | 空 | 直接起 https 时使用 |
| `CONFIG_SEED_PATH` / `CONFIG_SCHEMA_PATH` | 随包路径 | 只在自定义目录布局时需要 |

## 5. 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/config` | 公开 | 现行 CONFIG（`application/json`、`no-cache`、ETag/304、`Access-Control-Allow-Origin: *`） |
| GET | `/health` | 公开 | `{ ok, current, versions, validator, uptimeSeconds }`，给监控用 |
| GET | `/` | 公开 | 落地页：现行版本摘要 + 入口 |
| GET | `/admin` | 会话 | 管理面板；`?version=<文件名>` 可把某个历史版本载入编辑器 |
| GET | `/admin/login` · POST 同名 | 公开 | 登录（表单 `password`），成功后种 HttpOnly + SameSite=Strict 会话 cookie |
| POST | `/admin/logout` | 会话 | 退出（需 CSRF） |
| POST | `/admin/save` | 会话 | 表单：`content`(JSON 文本)、`note`、`draft=1` 表示只存版本不切换现行 |
| POST | `/admin/apply` | 会话 | 表单：`name` —— 一键把旧版本切回现行（只挪指针） |
| POST | `/admin/delete` | 会话 | 表单：`name` —— 删除非现行版本（现行版本受保护） |
| POST | `/admin/validate` | 会话 | 只校验不落盘；body 是 JSON 文本，返回 `{ ok, errors, mode, modelCount }` |
| GET | `/admin/download?name=` | 会话 | 下载某个版本的原始 JSON |

所有写操作需要三件套：会话 cookie + CSRF token（表单里的 `csrf` 或 `X-CSRF-Token` 头）
+ Origin 同源。非法版本文件名（路径穿越）一律拒绝。

## 6. 版本、备份、回滚语义

- **发布**：`/admin` 里编辑 → 「保存并应用」。文件名形如 `20260911T230012-r7.json`
  （UTC 时间戳 + 自增 revision），同秒冲突自动加 `-01` 后缀，**同名文件永不覆盖**。
- **revision / updatedAt / source 由服务端盖章**，忽略管理员手填的值——客户端靠 revision
  展示与比对，不能被手滑改乱。
- **回滚**：版本列表里任意非现行版本点「应用为现行」。**文件内容逐字节不变**，只改 `state.json`
  的 `current` 指针；客户端下一次拉取（≤1 小时，或用户点「立即刷新」）即可见。
- **仅存草稿**：勾选「仅保存为版本」→ 生成新版本但不切换现行，准备好再一键应用。
- **删除**：现行版本不允许删除（先切换再删）；每次保存/应用/删除/播种都会写入审计日志，
  面板底部可查「谁在什么时候把哪个版本推上去了」。
- **指针损坏自愈**：`state.json` 指向不存在的文件时，启动自动回退到最新版本并记一条 `repair`。

## 7. 与客户端的契约

客户端（Flow Canvas）把更新源写死为 `https://artconfig.ravenhash.org/config`（可在设置面板改成
任意 http(s) 地址，或清空以关闭远端更新），每 1 小时自动拉取一次，设置面板也能手动刷新。
服务端必须满足：

- 返回 **合法 JSON**，且通过 `schema/model-config.schema.json`（客户端主进程也会用同一份
  schema 再校验一次，不合格整包丢弃并回退到本地缓存/内置默认配置）；
- `schemaVersion` 必须是 `1`；响应体 ≤ **2MB**；地址只要求是 **http(s) URL**（不强制 https，
  协议与 TLS 由你的反代决定）；
- `refreshIntervalMs` 可选（单位毫秒，客户端夹在 5 分钟 ~ 24 小时，默认 1 小时）。

所以**不要手改 `data/configs/` 里的 JSON 去绕过校验**：改动请走 `/admin`（保存前会校验并按
schema 报错），否则客户端会静静地回退到旧配置，看起来像「发布了但没生效」。

改 `shared/model-config.default.json`（默认配置）后，务必在仓库根目录跑
`node scripts/sync-model-config.mjs --write`，把 schema 与种子同步到本目录；根目录
`npm test` 会断言这两份副本与 `shared/` 逐字一致，防止漂移。

## 8. 运维小抄

```bash
curl -s https://artconfig.ravenhash.org/health | jq
curl -s https://artconfig.ravenhash.org/config | jq '.revision, (.models|length)'

# 备份（版本文件都是不可变的小 JSON，直接打包整个 data/ 即可）
tar czf flow-config-$(date +%F).tgz -C /var/lib/flow-config .

# 回滚：登录面板 → 版本列表 → 目标版本「应用为现行」；或用 API
#   curl -c cj -d 'password=...' https://artconfig.ravenhash.org/admin/login
#   curl -b cj -d "csrf=$TOKEN&name=20260911T230012-r0.json" https://artconfig.ravenhash.org/admin/apply
```

**运维命令速查**

```bash
systemctl status flow-config          # 状态
journalctl -u flow-config -f          # 日志
sudo ./deploy/stop.sh                 # 停止
sudo ./deploy/stop.sh --disable       # 停止并取消开机自启
sudo ./deploy/stop.sh --uninstall     # 卸载（保留数据；--purge 连数据一起删）
sudo ./deploy/install.sh              # 升级代码（数据与密码保留）
```

**排查**

| 现象 | 处理 |
| --- | --- |
| `/config` 返回 404 | 仓库为空（没有种子也没发布过），登录 `/admin` 保存一个版本 |
| 面板顶部提示「结构校验（降级）」 | 没装 ajv：`cd configserver && npm install` 后重启 |
| 登录一直提示密码不正确 | 检查 `CONFIG_ADMIN_PASSWORD` / `CONFIG_ADMIN_PASSWORD_HASH` / `data/admin.json` 是否生效；连续失败 8 次会按 IP 封禁 15 分钟 |
| 保存报 CSRF 校验失败 | 页面停留过久或代理改写了 Origin；刷新页面重新登录 |
| 客户端一直「拉取失败」 | 看客户端设置面板的错误文案：HTTP 状态、schema 校验、超时都会明确写出来 |

## 9. 安全清单

- [x] 密码只以 scrypt 哈希存在（salt 随机，`timingSafeEqual` 比较），无密码则拒绝启动
- [x] 会话 cookie：HttpOnly + SameSite=Strict + 12 小时滑动过期；反代传 `X-Forwarded-Proto: https`
      时自动加 `Secure`（也可用 `CONFIG_COOKIE_SECURE=1` 强制）
- [x] 写操作要求 CSRF token 且校验 Origin 同源
- [x] 登录失败按 IP 限流（8 次 / 15 分钟）
- [x] 版本名白名单正则，杜绝路径穿越；请求体上限 1MB
- [x] 默认只监听 127.0.0.1；错误页不吐堆栈（堆栈只进日志）
- [x] 日志只记方法/路径/状态/IP，不记请求体、cookie 与密码
