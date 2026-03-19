# touchgal-steamapi

一个轻量的 Steam Store 抓取服务，用来根据 `appid` 提取游戏页面上的标签（tags）和开发者（developers）信息。

这个服务适合给站点、脚本或聚合服务做一个本地中间层，避免每次都手动处理 Steam 的年龄门、Cookie 和重试逻辑。

## 功能

- 根据 `appid` 抓取 Steam 商店页标签
- 提取开发者名称和对应的 Steam 链接
- 获取默认简体中文游戏名
- 获取英文、日文、繁体中文名称别名
- 获取并格式化发售日期为 `yyyy-mm-dd`
- 支持从远程浏览器自动同步 Steam Cookie
- 自动尝试通过常见年龄验证页
- 支持全局 Steam Cookie 或单次请求注入 Cookie
- 内置超时、重试和退避逻辑
- 提供健康检查接口

## 技术栈

- Node.js
- Express
- Axios
- axios-cookiejar-support
- tough-cookie
- Cheerio
- ws

## 目录结构

```text
.
├── server.js
└── README.md
```

## 安装

当前仓库是一个单文件服务，没有内置 `package.json`。可以直接在仓库根目录初始化并安装依赖：

```bash
npm init -y
npm install express axios axios-cookiejar-support tough-cookie cheerio ws
```

## 启动

```bash
node server.js
```

默认监听地址：

```text
http://127.0.0.1:8765
```

## 环境变量

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8765` | 服务监听端口 |
| `DEFAULT_LANG` | `schinese` | 默认语言，可通过请求参数覆盖 |
| `REQUEST_TIMEOUT_MS` | `10000` | 单次上游请求超时时间（毫秒） |
| `MAX_RETRIES` | `3` | 最大重试次数 |
| `RETRY_BASE_DELAY_MS` | `800` | 重试基础退避时间（毫秒） |
| `STEAM_COOKIE` | 空 | 可选，全局 Steam Cookie |
| `USER_AGENT` | 内置浏览器 UA | 可选，自定义请求头 UA |
| `REMOTE_BROWSER_ENABLED` | `false` | 是否开启远程浏览器 Cookie 自动同步 |
| `REMOTE_BROWSER_CDP_HTTP_URL` | 空 | 远程浏览器的 CDP HTTP 地址，例如 `http://127.0.0.1:9222` |
| `REMOTE_BROWSER_CDP_WS_URL` | 空 | 可选，直接指定 CDP WebSocket 地址 |
| `REMOTE_BROWSER_SYNC_INTERVAL_MS` | `60000` | 自动同步间隔（毫秒） |
| `REMOTE_BROWSER_CDP_TIMEOUT_MS` | 跟随 `REQUEST_TIMEOUT_MS` | 读取远程浏览器 Cookie 的超时时间 |
| `REMOTE_BROWSER_COOKIE_STORE_PATH` | `./steam-remote-browser-cookies.json` | 持久化保存同步 Cookie 的文件路径 |
| `REMOTE_BROWSER_COOKIE_DOMAINS` | `store.steampowered.com,steamcommunity.com,help.steampowered.com` | 允许同步的域名列表，逗号分隔 |

示例：

```bash
export PORT=8765
export DEFAULT_LANG=schinese
export STEAM_COOKIE='sessionid=xxx; steamLoginSecure=xxx'
node server.js
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
  "remoteBrowserCookieSync": {
    "enabled": false,
    "configured": false,
    "cookieCount": 0,
    "hasCookies": false,
    "source": null,
    "lastSyncOkAt": null,
    "lastError": null,
    "syncInProgress": false
  }
}
```

### `GET /api/steam-cookies/status`

查看远程浏览器 Cookie 同步状态。

请求示例：

```bash
curl http://127.0.0.1:8765/api/steam-cookies/status
```

返回示例：

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "configured": true,
    "cdpHttpUrl": "http://127.0.0.1:9222",
    "cdpWsUrlConfigured": false,
    "syncIntervalMs": 60000,
    "cookieDomains": [
      "store.steampowered.com",
      "steamcommunity.com",
      "help.steampowered.com"
    ],
    "cookieStorePath": "/app/steam-remote-browser-cookies.json",
    "source": "remote_browser_cdp",
    "cookieCount": 12,
    "hasCookies": true,
    "lastSyncAt": "2026-03-19T09:30:00.000Z",
    "lastSyncOkAt": "2026-03-19T09:30:00.000Z",
    "lastError": null,
    "lastErrorAt": null,
    "syncInProgress": false
  }
}
```

### `POST /api/steam-cookies/sync`

立刻从远程浏览器拉取一次 Steam Cookie。适合你在远程浏览器里手动登录完成后立即触发。

请求示例：

```bash
curl -X POST http://127.0.0.1:8765/api/steam-cookies/sync
```

### `GET /api/app/:appid/tags`

根据 Steam `appid` 抓取标签、开发者、多语言名称和发售日期信息。

查询参数：

- `lang`：可选，默认使用 `DEFAULT_LANG`

请求头：

- `X-Steam-Cookie`：可选，单次请求使用的 Steam Cookie，优先级高于远程浏览器同步 Cookie 和全局 `STEAM_COOKIE`

请求示例：

```bash
curl "http://127.0.0.1:8765/api/app/620/tags?lang=schinese"
```

带登录态 Cookie 的示例：

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

当页面结构变化、页面受限或没有成功提取到标签时，接口仍可能返回成功，但会附带提示：

```json
{
  "success": true,
  "data": {
    "appid": "123456",
    "name": null,
    "aliases": {
      "english": null,
      "japanese": null,
      "tchinese": null
    },
    "releaseDate": null,
    "tags": [],
    "developers": []
  },
  "warning": "未提取到标签。可能是页面结构变动，或该页面仍受登录态/偏好/地区限制。"
}
```

## 常见错误

### `400 INVALID_APPID`

`appid` 不是纯数字。

```json
{
  "success": false,
  "error": "INVALID_APPID",
  "message": "appid 必须是纯数字"
}
```

### `403 AGE_GATE_BLOCKED`

服务尝试处理年龄门后，页面仍停留在年龄验证。

```json
{
  "success": false,
  "error": "AGE_GATE_BLOCKED",
  "message": "页面仍然停留在年龄验证，当前无法继续获取标签"
}
```

### `403 LOGIN_OR_PREFERENCE_REQUIRED`

页面大概率需要登录态、成熟内容偏好或特定地区权限。

```json
{
  "success": false,
  "error": "LOGIN_OR_PREFERENCE_REQUIRED",
  "message": "这个页面大概率需要登录后的 Steam 账号权限、成熟内容偏好设置，或受地区限制。请传入你自己的 Steam Cookie，或开启远程浏览器 Cookie 同步。"
}
```

### `502 UPSTREAM_FETCH_FAILED`

请求 Steam 上游失败，可能是超时、限流、网络波动或上游异常。

```json
{
  "success": false,
  "error": "UPSTREAM_FETCH_FAILED",
  "message": "上游请求失败: HTTP 503"
}
```

## 工作方式

服务的大致流程如下：

1. 访问 `https://store.steampowered.com/app/:appid/`
2. 判断是否遇到年龄验证页
3. 如有需要，自动提交年龄验证表单
4. 重新抓取真实页面
5. 从页面中提取标签和开发者信息
6. 如果上游返回超时、限流或部分 5xx，会自动重试

如果开启了远程浏览器 Cookie 同步，服务会优先匿名抓取；只有遇到登录态或内容偏好限制时，才会按下面的优先级自动重试：

1. 请求头 `X-Steam-Cookie`
2. 远程浏览器自动同步的 Cookie
3. 环境变量 `STEAM_COOKIE`

## 远程浏览器登录同步

这一功能的设计是：

- 你在服务器上的远程浏览器里手动登录 Steam
- 服务通过 Chromium DevTools Protocol 读取并更新当前浏览器里的 Steam Cookie
- 后续接口自动复用这些 Cookie，不需要手工复制

实现上不强绑定某个具体产品。只要是支持 Chromium 内核并暴露 CDP 调试接口的远程浏览器都可以，例如 Neko。

使用步骤：

1. 在服务器上启动一个可远程访问的 Chromium 浏览器，并确保它暴露了 CDP 调试端口
2. 配置本服务环境变量
3. 打开远程浏览器，手动登录 Steam
4. 调用一次 `POST /api/steam-cookies/sync`，或者等待自动同步
5. 用 `GET /api/steam-cookies/status` 确认 Cookie 已就绪

示例配置：

```bash
export REMOTE_BROWSER_ENABLED=true
export REMOTE_BROWSER_CDP_HTTP_URL=http://127.0.0.1:9222
export REMOTE_BROWSER_SYNC_INTERVAL_MS=60000
export REMOTE_BROWSER_COOKIE_STORE_PATH=./steam-remote-browser-cookies.json
node server.js
```

说明：

- `REMOTE_BROWSER_ENABLED=true` 时，服务启动后会先尝试同步一次，并按间隔自动刷新
- 如果你不想自动轮询，也可以不打开 `REMOTE_BROWSER_ENABLED`，只保留 CDP 地址，然后通过 `POST /api/steam-cookies/sync` 手动触发
- 程序会把最新同步到的 Cookie 持久化到 `REMOTE_BROWSER_COOKIE_STORE_PATH`，服务重启后会优先加载这份缓存
- 强烈建议把 CDP 端口放在内网，不要直接暴露到公网

## 使用建议

- 遇到成人内容、偏好限制或地区限制页面时，优先通过 `X-Steam-Cookie` 传入你自己的 Steam Cookie
- 如果你已经在远程浏览器里登录 Steam，优先使用自动同步而不是手工复制 Cookie
- 不要把真实 Cookie 提交到仓库或写死在代码里
- 不要把远程浏览器的调试端口直接暴露到公网
- 这是基于页面结构的抓取服务，Steam 页面改版后可能需要调整选择器
- 如果你要给生产环境使用，建议在反向代理层再补上日志、限流和监控

## 已知限制

- 当前返回名称、发售日期、标签和开发者信息，不包含价格、简介、截图等字段
- 名称和发售日期来自 `appdetails` 接口，若上游未返回或日期不可解析，对应字段会是 `null`
- 远程浏览器同步依赖 Chromium 的 CDP 调试接口，不支持完全不暴露调试能力的浏览器容器
- 依赖 Steam 商店前端页面结构，结构变更会影响提取结果
- 某些页面即使带 Cookie，仍可能受到地区、账号年龄或偏好设置影响

## 开发说明

核心逻辑都在 [server.js](/Users/palentum/2/touchgal-steamapi/server.js)：

- 路由入口：`/health`、`/api/app/:appid/tags`
- Cookie 同步接口：`/api/steam-cookies/status`、`/api/steam-cookies/sync`
- 抓取逻辑：`fetchSteamTags`
- 年龄门处理：`passAgeGateIfNeeded`
- 解析逻辑：`extractTags`
- 远程浏览器同步：`syncRemoteBrowserCookies`

如果后续要扩展，比较自然的方向有：

- 增加 `package.json`
- 增加 Dockerfile
- 补单元测试和集成测试
- 提供更多字段提取能力
