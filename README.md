# touchgal-steamapi

一个轻量的 Steam Store 抓取服务，用来根据 `appid` 提取游戏页面上的标签（tags）和开发者（developers）信息。

这个服务适合给站点、脚本或聚合服务做一个本地中间层，避免每次都手动处理 Steam 的年龄门、Cookie 和重试逻辑。

## 功能

- 根据 `appid` 抓取 Steam 商店页标签
- 提取开发者名称和对应的 Steam 链接
- 获取默认简体中文游戏名
- 获取英文、日文、繁体中文名称别名
- 获取并格式化发售日期为 `yyyy-mm-dd`
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
npm install express axios axios-cookiejar-support tough-cookie cheerio
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
  "service": "steam-tags-api"
}
```

### `GET /api/app/:appid/tags`

根据 Steam `appid` 抓取标签、开发者、多语言名称和发售日期信息。

查询参数：

- `lang`：可选，默认使用 `DEFAULT_LANG`

请求头：

- `X-Steam-Cookie`：可选，单次请求使用的 Steam Cookie，优先级高于全局 `STEAM_COOKIE`

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
  "message": "这个页面大概率需要登录后的 Steam 账号权限、成熟内容偏好设置，或受地区限制。请传入你自己的 Steam Cookie。"
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

## 使用建议

- 遇到成人内容、偏好限制或地区限制页面时，优先通过 `X-Steam-Cookie` 传入你自己的 Steam Cookie
- 不要把真实 Cookie 提交到仓库或写死在代码里
- 这是基于页面结构的抓取服务，Steam 页面改版后可能需要调整选择器
- 如果你要给生产环境使用，建议在反向代理层再补上日志、限流和监控

## 已知限制

- 当前返回名称、发售日期、标签和开发者信息，不包含价格、简介、截图等字段
- 名称和发售日期来自 `appdetails` 接口，若上游未返回或日期不可解析，对应字段会是 `null`
- 依赖 Steam 商店前端页面结构，结构变更会影响提取结果
- 某些页面即使带 Cookie，仍可能受到地区、账号年龄或偏好设置影响

## 开发说明

核心逻辑都在 [server.js](/Users/palentum/2/touchgal-steamapi/server.js)：

- 路由入口：`/health`、`/api/app/:appid/tags`
- 抓取逻辑：`fetchSteamTags`
- 年龄门处理：`passAgeGateIfNeeded`
- 解析逻辑：`extractTags`

如果后续要扩展，比较自然的方向有：

- 增加 `package.json`
- 增加 Dockerfile
- 补单元测试和集成测试
- 提供更多字段提取能力
