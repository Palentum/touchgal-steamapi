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

- Node.js
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
| `HOST` | `127.0.0.1` | 服务监听地址。默认只监听本机，若暴露到公网建议同时设置 `ADMIN_API_KEY` |
| `DEFAULT_LANG` | `schinese` | 默认语言，可通过请求参数覆盖 |
| `REQUEST_TIMEOUT_MS` | `10000` | 单次上游请求超时时间（毫秒） |
| `MAX_RETRIES` | `3` | 最大重试次数 |
| `RETRY_BASE_DELAY_MS` | `800` | 重试基础退避时间（毫秒） |
| `EMPTY_RESULT_RETRY_DELAY_MS` | `1500` | 当 `tags` 或 `developers` 为空时，下一次轮询前的等待时间（毫秒） |
| `APP_TAGS_MAX_FETCH_ATTEMPTS` | `3` | 单次接口请求最多向上游尝试抓取完整结果的次数，超过后返回 `504` |
| `APP_DETAILS_CACHE_TTL_MS` | `600000` | Steam `appdetails` 元数据缓存时长（毫秒） |
| `APP_DETAILS_CACHE_MAX_ENTRIES` | `500` | Steam `appdetails` 元数据缓存最大条目数 |
| `APP_TAGS_CACHE_TTL_MS` | `120000` | 成功抓取到的标签结果缓存时长（毫秒） |
| `APP_TAGS_CACHE_MAX_ENTRIES` | `500` | 标签结果缓存最大条目数 |
| `STEAM_COOKIE` | 空 | 可选，全局 Steam Cookie，优先级低于单次请求头 |
| `USER_AGENT` | 内置浏览器 UA | 可选，自定义请求头 UA |
| `STEAM_SESSION_STORE_PATH` | `./steam-session-auth.json` | `refresh token` 和最近一次成功换取的 Cookie 持久化文件 |
| `STEAM_SESSION_REFRESH_INTERVAL_MS` | `1800000` | 定时用 `refresh token` 刷新 Cookie 的间隔（毫秒） |
| `STEAM_SESSION_LOGIN_TIMEOUT_MS` | `300000` | 单次交互式登录的超时时间（毫秒） |
| `STEAM_SESSION_LOGIN_ATTEMPT_TTL_MS` | `600000` | 登录会话在内存中保留的时长（毫秒） |
| `STEAM_SESSION_COOKIE_DOMAINS` | `store.steampowered.com,steamcommunity.com,help.steampowered.com` | 自动映射 Cookie 的域名列表，逗号分隔 |
| `JSON_BODY_LIMIT` | `16kb` | JSON 请求体大小限制 |
| `ADMIN_API_KEY` | 空 | 可选。设置后，`/api/steam-auth/*` 和 `/api/steam-cookies/*` 需要 `X-API-Key` 或 `Authorization: Bearer <key>` |
| `ADMIN_ROUTE_WINDOW_MS` | `300000` | 管理写接口限流窗口（毫秒） |
| `ADMIN_ROUTE_MAX_REQUESTS` | `12` | 单个客户端在限流窗口内允许访问管理写接口的最大次数 |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | 进程收到退出信号后的优雅停机等待时间（毫秒），超过后会强制断开剩余连接 |

示例：

```bash
.env
PORT=8765
DEFAULT_LANG=schinese
STEAM_SESSION_STORE_PATH=./steam-session-auth.json
ADMIN_API_KEY=replace_me
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

如果设置了 `ADMIN_API_KEY`，上面的管理接口请求需要额外携带：

```bash
-H "X-API-Key: your_admin_key"
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
    "lastError": null,
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
