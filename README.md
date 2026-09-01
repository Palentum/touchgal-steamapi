# touchgal-steamapi

一个轻量的 Steam Store 抓取服务，用来根据 `appid` 提取游戏页面上的标签（tags）和开发者（developers）信息。

当前版本把 Steam 登录态管理重构为 `steam-session` 驱动：

- 首次通过一次交互式登录拿到 `refresh token`
- 把 `refresh token` 持久化到本地文件
- 服务启动后自动用 `refresh token` 换取最新 Steam Cookie
- 定时刷新 Cookie，无需再依赖远程浏览器同步

## 功能

- 根据 `appid` 抓取 Steam 商店页标签
- 提取开发者名称和对应的 Steam 链接
- 获取默认简体中文游戏名
- 获取英文、日文、繁体中文名称别名
- 获取并格式化发售日期为 `yyyy-mm-dd`
- 基于 `steam-session` 一次性登录并持久化 `refresh token`
- 自动用 `refresh token` 刷新 Steam Cookie
- 自动尝试通过常见年龄验证页
- 默认补齐成熟内容偏好 Cookie
- 兼容全局 `STEAM_COOKIE` 和单次请求 `X-Steam-Cookie`
- 内置超时、重试和退避逻辑
- 内置短期缓存，减少重复抓取和上游压力
- 敏感管理接口支持 API Key 保护和基础限流
- 提供健康检查和 Steam 登录状态接口

## 技术栈

- Node.js ≥ 22.12（`socks-proxy-agent`、`axios-cookiejar-support` 为纯 ESM 包，依赖 `require(ESM)` 支持，低版本启动即抛 `ERR_REQUIRE_ESM`）
- Express
- Axios
- axios-cookiejar-support
- tough-cookie
- Cheerio
- steam-session

## 目录结构

```text
.
├── ecosystem.config.js
├── package.json
├── package-lock.json
├── server.js
└── README.md
```

## 安装

```bash
npm install
cp .env.example .env
```

## 启动

```bash
npm start
```

## 使用 PM2 保持运行

项目已内置 `pm2` 和默认配置文件 `ecosystem.config.js`，适合长期运行和开机自启。

首次启动：

```bash
npm run pm2:start
```

常用命令：

```bash
npm run pm2:logs
npm run pm2:restart
npm run pm2:reload
npm run pm2:stop
npm run pm2:delete
```

如果你希望机器重启后自动拉起：

```bash
npm run pm2:save
npx pm2 startup
```

说明：

- 进程名固定为 `touchgal-steamapi`
- `pm2` 以单进程 `fork` 模式运行，避免当前内存缓存和 Steam 会话状态在多实例下出现不一致
- 服务现在支持接收 `SIGINT` / `SIGTERM` 后优雅退出，`pm2 restart` 或 `pm2 reload` 时会先停止定时刷新任务并关闭 HTTP 服务

也支持从项目根目录的 `.env` 文件读取环境变量，并且 `.env` 中的值会覆盖系统环境变量与代码默认值。

默认监听地址：

```text
http://127.0.0.1:8765
```

## 环境变量

加载顺序：

1. 项目根目录 `.env`
2. 系统环境变量
3. 代码内默认值

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8765` | 服务监听端口 |
| `HOST` | `127.0.0.1` | 服务监听地址。默认只监听本机；暴露到公网或经反代转发时，务必同时配置 `ADMIN_API_KEY` 和 `TRUST_PROXY` |
| `DEFAULT_LANG` | `schinese` | 默认语言，可通过请求参数覆盖 |
| `REQUEST_TIMEOUT_MS` | `10000` | 单次上游请求超时时间（毫秒） |
| `MAX_RETRIES` | `3` | 单次上游请求的最大尝试次数（含首次请求，必须 ≥ 1；填 `0` 或非法值会回退默认值并打印告警） |
| `RETRY_BASE_DELAY_MS` | `800` | 重试基础退避时间（毫秒） |
| `MAX_RETRY_AFTER_DELAY_MS` | `30000` | 上游 `Retry-After` 头的最大可信等待时间（毫秒）：超出部分钳制到该值，空值/负值/HTTP-date 形式回落到指数退避 |
| `EMPTY_RESULT_RETRY_DELAY_MS` | `1500` | 当 `tags` 或 `developers` 为空时，下一次轮询前的等待时间（毫秒） |
| `APP_TAGS_MAX_FETCH_ATTEMPTS` | `3` | 单次接口请求最多向上游尝试抓取完整结果的次数，超过后返回 `504` |
| `APP_TAGS_TOTAL_DEADLINE_MS` | `90000` | 单次接口请求整个抓取循环的总截止时间（毫秒）：超时后不再开启新一轮重试，直接返回 `504` 和已有的部分数据 |
| `APP_DETAILS_CACHE_TTL_MS` | `600000` | Steam `appdetails` 元数据缓存时长（毫秒） |
| `APP_DETAILS_CACHE_MAX_ENTRIES` | `500` | Steam `appdetails` 元数据缓存最大条目数 |
| `APP_TAGS_CACHE_TTL_MS` | `120000` | 成功抓取到的标签结果缓存时长（毫秒） |
| `APP_TAGS_CACHE_MAX_ENTRIES` | `500` | 标签结果缓存最大条目数 |
| `APP_TAGS_NEGATIVE_CACHE_TTL_MS` | `60000` | 失败结果的负缓存时长（毫秒）：`504` 不完整结果和 `appdetails` 查无此 app 的结果在此期间直接返回缓存，不再触发上游抓取 |
| `STEAM_COOKIE` | 空 | 可选，全局 Steam Cookie，优先级低于单次请求头 |
| `USER_AGENT` | 内置浏览器 UA | 可选，自定义请求头 UA |
| `SOCKS5_PROXY_URL` | 空 | 可选。设置后所有对外请求（商店页抓取、`appdetails`、steam-session 登录/刷新）都经由该 SOCKS5 代理发出。格式 `socks5://user:pass@host:port` 或 `socks5h://host:port`（`socks5h` 表示域名也交给代理端解析） |
| `STEAM_SESSION_STORE_PATH` | `./steam-session-auth.json` | `refresh token` 和最近一次成功换取的 Cookie 持久化文件 |
| `STEAM_SESSION_REFRESH_INTERVAL_MS` | `1800000` | 定时用 `refresh token` 刷新 Cookie 的间隔（毫秒） |
| `STEAM_SESSION_COOKIE_TIMEOUT_MS` | `45000` | 单次用 `refresh token` 换取 Cookie 的超时时间（毫秒），防止上游停滞时刷新永久挂起 |
| `STEAM_SESSION_LOGIN_TIMEOUT_MS` | `300000` | 单次交互式登录的超时时间（毫秒） |
| `STEAM_SESSION_LOGIN_ATTEMPT_TTL_MS` | `600000` | 登录会话在内存中保留的时长（毫秒） |
| `STEAM_SESSION_COOKIE_DOMAINS` | `store.steampowered.com,steamcommunity.com,help.steampowered.com` | 自动映射 Cookie 的域名列表，逗号分隔 |
| `JSON_BODY_LIMIT` | `16kb` | JSON 请求体大小限制 |
| `ADMIN_API_KEY` | 空 | **启用管理接口的必要条件**。`/api/steam-auth/*` 和 `/api/steam-cookies/*` 需要 `X-API-Key` 或 `Authorization: Bearer <key>`。未配置、使用占位值（如 `replace_me`）或长度不足 16 位时，这些接口一律返回 `403`，交互式登录不可用（不影响 `/api/app/:appid/tags`）。建议用 `openssl rand -hex 32` 生成 |
| `ADMIN_ROUTE_WINDOW_MS` | `300000` | 管理写接口限流窗口（毫秒） |
| `ADMIN_ROUTE_MAX_REQUESTS` | `12` | 单个客户端在限流窗口内允许访问管理写接口的最大次数 |
| `PUBLIC_ROUTE_WINDOW_MS` | `60000` | 公开接口 `/api/app/:appid/tags` 的限流窗口（毫秒） |
| `PUBLIC_ROUTE_MAX_REQUESTS` | `30` | 单个客户端在限流窗口内允许访问公开接口的最大次数，超过返回 `429` |
| `TRUST_PROXY` | 空（不信任） | 部署在 Nginx 等反代后面时必填，否则 `req.ip` 恒为反代地址、上面的限流会退化成所有调用者共用一个桶。取值：数字表示信任的反代跳数（单层反代填 `1`）、`true` 表示全信任、也接受 IP / CIDR / `loopback` 等 Express 预设名 |
| `SHUTDOWN_TIMEOUT_MS` | `5000` | 进程收到退出信号后的优雅停机等待时间（毫秒），超过后会强制断开剩余连接。必须明显小于 PM2 的 `kill_timeout`（`ecosystem.config.js`，当前 `15000`），否则强制断连来不及在 SIGKILL 前触发，进程会被直接杀死 |

示例：

```bash
.env
PORT=8765
DEFAULT_LANG=schinese
STEAM_SESSION_STORE_PATH=./steam-session-auth.json
# 下面是示例值，务必换成你自己的：openssl rand -hex 32
ADMIN_API_KEY=3f0b7c1d9a4e6528b1d47f0c9e2a8b5647fd3c10e98a2b6741cd05e3f8a92b7c
# 单层 Nginx 反代填 1；直连不填
TRUST_PROXY=1
```

```bash
npm start
```

## 一次性登录流程

### 1. 发起登录

```bash
curl -X POST http://127.0.0.1:8765/api/steam-auth/login/start \
  -H "Content-Type: application/json" \
  -d '{
    "accountName": "your_steam_account",
    "password": "your_steam_password"
  }'
```

返回示例：

```json
{
  "success": true,
  "data": {
    "loginId": "ef1f07f5-8fd8-48ca-a2c2-6a9d4c51b9ff",
    "accountName": "your_steam_account",
    "steamId": null,
    "status": "awaiting_guard",
    "actionRequired": true,
    "validActions": [
      {
        "type": 2,
        "typeName": "EmailCode",
        "detail": "@gmail.com",
        "description": "请输入发送到邮箱域名 @gmail.com 的验证码。"
      }
    ],
    "error": null
  }
}
```

### 2. 提交 Guard 验证码

如果返回 `awaiting_guard`，继续提交邮箱验证码或手机令牌验证码：

```bash
curl -X POST http://127.0.0.1:8765/api/steam-auth/login/submit-guard \
  -H "Content-Type: application/json" \
  -d '{
    "loginId": "ef1f07f5-8fd8-48ca-a2c2-6a9d4c51b9ff",
    "code": "12345"
  }'
```

### 3. 查询登录结果

如果需要在 Steam 手机 App 中确认，或者想轮询登录结果：

```bash
curl http://127.0.0.1:8765/api/steam-auth/login/ef1f07f5-8fd8-48ca-a2c2-6a9d4c51b9ff
```

登录成功后，服务会：

- 持久化 `refresh token`
- 立即换取一组可用的 Steam Cookie
- 启动定时刷新 Cookie

上面的管理接口请求**必须**携带 `ADMIN_API_KEY`：

```bash
-H "X-API-Key: your_admin_key"
```

服务端未配置有效的 `ADMIN_API_KEY` 时，这些接口会直接返回：

```json
{
  "success": false,
  "error": "ADMIN_API_DISABLED",
  "message": "管理接口未启用：服务端未配置有效的 ADMIN_API_KEY（至少 16 位且不能是占位值）"
}
```

## 接口

### `GET /health`

健康检查。

请求示例：

```bash
curl http://127.0.0.1:8765/health
```

返回示例：

```json
{
  "ok": true,
  "service": "steam-tags-api",
  "steamSessionAuth": {
    "provider": "steam-session",
    "hasRefreshToken": false,
    "cookieCount": 0,
    "hasCookies": false,
    "source": null,
    "lastCookieRefreshOkAt": null,
    "hasError": false,
    "lastErrorAt": null,
    "refreshInProgress": false,
    "pendingLoginCount": 0
  }
}
```

### `GET /api/steam-auth/status`

查看当前 `refresh token` 和 Cookie 状态。

请求示例：

```bash
curl http://127.0.0.1:8765/api/steam-auth/status
```

### `GET /api/steam-cookies/status`

`/api/steam-auth/status` 的兼容别名。

### `POST /api/steam-cookies/sync`

立刻用当前保存的 `refresh token` 刷新一次 Cookie。

请求示例：

```bash
curl -X POST http://127.0.0.1:8765/api/steam-cookies/sync
```

### `GET /api/app/:appid/tags`

根据 Steam `appid` 抓取标签、开发者、多语言名称和发售日期信息。

查询参数：

- `lang`：可选，默认使用 `DEFAULT_LANG`

请求头：

- `X-Steam-Cookie`：可选，单次请求使用的 Steam Cookie，优先级高于 `steam-session` 自动维护的 Cookie 和全局 `STEAM_COOKIE`

返回行为：

- 如果 `tags` 或 `developers` 为空，接口会按 `EMPTY_RESULT_RETRY_DELAY_MS` 重试，最多重试 `APP_TAGS_MAX_FETCH_ATTEMPTS` 次
- 如果连续重试后仍拿不到完整结果，接口会返回 `504`，并在 `data` 字段中附带最后一次抓取到的部分数据
- `name`/`aliases`/`releaseDate` 来自 appdetails，某一语言抓取失败同样会触发上述重试，且 `name` 和 `releaseDate` 会在四种语言间依次回退
- `comingSoon` 表示该作品是否未发售（来自 appdetails 的 `release_date.coming_soon`，四种语言的元数据全部获取失败时为 `null`）。未发售作品 Steam 会填 `9998-12-31` 之类的占位日期，因此 `comingSoon` 为 `true` 时 `releaseDate` 固定为 `null`
- 如果重试耗尽后仍有语言的元数据获取失败，接口仍返回 `200`，但 `warning` 字段会说明哪些语言可能不完整（正常情况下 `warning` 为 `null`）

请求示例：

```bash
curl "http://127.0.0.1:8765/api/app/620/tags?lang=schinese"
```

带单次登录态 Cookie 的示例：

```bash
curl "http://127.0.0.1:8765/api/app/620/tags?lang=schinese" \
  -H "X-Steam-Cookie: sessionid=xxx; steamLoginSecure=xxx"
```

成功返回示例：

```json
{
  "success": true,
  "data": {
    "appid": "620",
    "name": "传送门 2",
    "aliases": {
      "english": "Portal 2",
      "japanese": "Portal 2",
      "tchinese": "傳送門 2"
    },
    "releaseDate": "2011-04-19",
    "comingSoon": false,
    "tags": ["动作", "解谜", "合作"],
    "developers": [
      {
        "name": "Valve",
        "link": "https://store.steampowered.com/developer/valve"
      }
    ]
  },
  "warning": null
}
```

## 持久化文件

默认会在项目根目录生成 `steam-session-auth.json`，内容包括：

- 当前账号的 `refresh token`
- 最近一次成功换取的 Cookie
- 最近一次认证和刷新时间

这个文件等同于长期登录态，请自行控制文件权限，不要提交到版本库。

## 开发说明

核心逻辑都在 [server.js](/Users/palentum/2/touchgal-steamapi/server.js)：

- `steam-session` 登录和 Cookie 刷新
- Cookie 持久化与自动续期
- 年龄门处理和商店页抓取
- 标签、开发者、多语言名称、发售日期提取

## 注意事项

- `steam-session` 获取到的是登录态 Cookie；成熟内容偏好 Cookie 由服务端默认补齐，避免成人内容页反复卡在偏好页
- 如果你的账号登录策略发生变化，或者 `refresh token` 失效，重新走一次登录接口即可
- 如果你明确传入 `X-Steam-Cookie`，当前请求不会使用自动维护的 Cookie
