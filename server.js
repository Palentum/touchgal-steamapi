const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { randomUUID, timingSafeEqual } = require("crypto");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar, Cookie } = require("tough-cookie");
const cheerio = require("cheerio");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { createCookieAgent } = require("http-cookie-agent/http");
const {
  LoginSession,
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  ESessionPersistence,
} = require("steam-session");

const dotenvResult = dotenv.config({
  path: path.resolve(process.cwd(), ".env"),
  override: true,
  quiet: true,
});

if (dotenvResult.error && dotenvResult.error.code !== "ENOENT") {
  throw new Error(`加载 .env 文件失败: ${dotenvResult.error.message}`);
}

const app = express();
const PORT = Number(process.env.PORT || 8765);
const HOST = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const DEFAULT_LANG = process.env.DEFAULT_LANG || "schinese";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 800);
const EMPTY_RESULT_RETRY_DELAY_MS = Number(
  process.env.EMPTY_RESULT_RETRY_DELAY_MS || 1500
);
const APP_TAGS_MAX_FETCH_ATTEMPTS = toPositiveInteger(
  process.env.APP_TAGS_MAX_FETCH_ATTEMPTS,
  3
);
const APP_DETAILS_CACHE_TTL_MS = toPositiveInteger(
  process.env.APP_DETAILS_CACHE_TTL_MS,
  10 * 60 * 1000
);
const APP_DETAILS_CACHE_MAX_ENTRIES = toPositiveInteger(
  process.env.APP_DETAILS_CACHE_MAX_ENTRIES,
  500
);
const APP_TAGS_CACHE_TTL_MS = toPositiveInteger(
  process.env.APP_TAGS_CACHE_TTL_MS,
  2 * 60 * 1000
);
const APP_TAGS_CACHE_MAX_ENTRIES = toPositiveInteger(
  process.env.APP_TAGS_CACHE_MAX_ENTRIES,
  500
);
// 失败结果（504 不完整数据、appdetails 查无此 app）的短 TTL 负缓存，
// 用来压制无效 appid 反复触发全量上游抓取的放大攻击面。
const APP_TAGS_NEGATIVE_CACHE_TTL_MS = toPositiveInteger(
  process.env.APP_TAGS_NEGATIVE_CACHE_TTL_MS,
  60 * 1000
);
const STEAM_SESSION_REFRESH_INTERVAL_MS = Number(
  process.env.STEAM_SESSION_REFRESH_INTERVAL_MS || 30 * 60 * 1000
);
const STEAM_SESSION_LOGIN_TIMEOUT_MS = Number(
  process.env.STEAM_SESSION_LOGIN_TIMEOUT_MS || 5 * 60 * 1000
);
const STEAM_SESSION_LOGIN_ATTEMPT_TTL_MS = Number(
  process.env.STEAM_SESSION_LOGIN_ATTEMPT_TTL_MS || 10 * 60 * 1000
);
const STEAM_SESSION_STORE_PATH = path.resolve(
  process.cwd(),
  process.env.STEAM_SESSION_STORE_PATH || "./steam-session-auth.json"
);
const STEAM_SESSION_COOKIE_DOMAINS = parseCsvList(
  process.env.STEAM_SESSION_COOKIE_DOMAINS ||
    "store.steampowered.com,steamcommunity.com,help.steampowered.com"
);
const JSON_BODY_LIMIT = String(process.env.JSON_BODY_LIMIT || "16kb").trim() || "16kb";
const ADMIN_API_KEY_MIN_LENGTH = 16;
const ADMIN_API_KEY_PLACEHOLDERS = new Set([
  "replace_me",
  "changeme",
  "change_me",
  "your_api_key",
]);
const ADMIN_API_KEY_RAW = String(process.env.ADMIN_API_KEY || "").trim();
const ADMIN_API_KEY = normalizeAdminApiKey(ADMIN_API_KEY_RAW);
const ADMIN_ROUTE_WINDOW_MS = toPositiveInteger(
  process.env.ADMIN_ROUTE_WINDOW_MS,
  5 * 60 * 1000
);
const ADMIN_ROUTE_MAX_REQUESTS = toPositiveInteger(
  process.env.ADMIN_ROUTE_MAX_REQUESTS,
  12
);
const PUBLIC_ROUTE_WINDOW_MS = toPositiveInteger(
  process.env.PUBLIC_ROUTE_WINDOW_MS,
  60 * 1000
);
const PUBLIC_ROUTE_MAX_REQUESTS = toPositiveInteger(
  process.env.PUBLIC_ROUTE_MAX_REQUESTS,
  30
);
// 部署在反代后面时必须配置，否则 req.ip 恒为反代地址，管理写接口的限流会退化成全局共用一个桶。
const TRUST_PROXY_SETTING = resolveTrustProxySetting(process.env.TRUST_PROXY);
const SHUTDOWN_TIMEOUT_MS = toPositiveInteger(
  process.env.SHUTDOWN_TIMEOUT_MS,
  10000
);

// 可选：把你自己浏览器里的 Steam Cookie 整串放到环境变量里。
// 也可以每次请求时通过 X-Steam-Cookie 请求头单独传入。
const GLOBAL_STEAM_COOKIE = process.env.STEAM_COOKIE || "";

const DEFAULT_USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

// 可选：所有对外请求（Steam 商店抓取 + steam-session 登录/刷新）走 SOCKS5 代理。
// 格式：socks5://user:pass@host:port 或 socks5h://host:port（socks5h 由代理端解析域名）。
const SOCKS5_PROXY_URL = parseSocks5ProxyUrl(process.env.SOCKS5_PROXY_URL);
// axios-cookiejar-support 的 wrapper 不允许外部 Agent，代理模式下改用
// http-cookie-agent（wrapper 的底层实现）直接组合出 cookie + SOCKS5 的 Agent。
const SocksCookieAgent = createCookieAgent(SocksProxyAgent);

function parseSocks5ProxyUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SOCKS5_PROXY_URL 不是合法的 URL: ${raw}`);
  }

  if (!["socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(
      `SOCKS5_PROXY_URL 必须是 socks5:// 或 socks5h:// 开头且包含主机名: ${raw}`
    );
  }

  return raw;
}

const ENGLISH_MONTH_MAP = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const steamCookieState = {
  cookieStrings: [],
  cookies: [],
  cookieCount: 0,
  source: null,
};

const appDetailsCache = new Map();
const appDetailsInflightRequests = new Map();
const appTagResponseCache = new Map();
const appTagInflightRequests = new Map();
const adminRouteBuckets = new Map();
const publicRouteBuckets = new Map();

const steamSessionState = {
  refreshToken: "",
  accountName: null,
  steamId: null,
  lastAuthenticatedAt: null,
  lastCookieRefreshAt: null,
  lastCookieRefreshOkAt: null,
  lastError: null,
  lastErrorAt: null,
  refreshInProgress: false,
};

const pendingSteamLogins = new Map();

let steamCookieRefreshPromise = null;
let steamCookieRefreshTimer = null;
let server = null;
let isShuttingDown = false;

app.set("trust proxy", TRUST_PROXY_SETTING);
app.disable("x-powered-by");
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function parseBooleanEnv(value = "") {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}

function parseCsvList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// 占位值和过短的密钥一律当作未配置，避免「设了等于没设」。入参必须是已 trim 的字符串。
function normalizeAdminApiKey(key) {
  if (!key || ADMIN_API_KEY_PLACEHOLDERS.has(key.toLowerCase())) {
    return "";
  }

  return key.length >= ADMIN_API_KEY_MIN_LENGTH ? key : "";
}

function resolveTrustProxySetting(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }

  // 纯数字按 Express 语义解释为信任的反代跳数，0 等价于不信任。
  // 这个分支必须排在下面的布尔判断之前：parseBooleanEnv 也认 "1"，
  // 但 trust proxy 的 1（只信任最后一跳）和 true（信任整条 XFF 链）安全含义完全不同。
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) {
    return hops;
  }

  if (parseBooleanEnv(raw)) {
    return true;
  }

  if (["false", "no", "off"].includes(raw.toLowerCase())) {
    return false;
  }

  // 其余原样交给 Express，支持 IP、CIDR 和 loopback 等预设名。
  return raw;
}

function cloneJsonValue(value) {
  if (value == null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function getCacheEntry(cache, key) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return cloneJsonValue(entry.value);
}

function setCacheEntry(cache, key, value, ttlMs, maxEntries) {
  if (!ttlMs || ttlMs <= 0) {
    return;
  }

  const expiresAt = Date.now() + ttlMs;
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, {
    value: cloneJsonValue(value),
    expiresAt,
  });

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function safeTimingEqual(expected = "", provided = "") {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const providedBuffer = Buffer.from(String(provided || ""));

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function getRequestIp(req) {
  return (
    String(req.ip || "").trim() ||
    String(req.socket?.remoteAddress || "").trim() ||
    "unknown"
  );
}

function extractApiKey(req) {
  const authorization = String(req.header("authorization") || "").trim();
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }

  return String(req.header("x-api-key") || "").trim();
}

function requireAdminAccess(req, res, next) {
  res.setHeader("Cache-Control", "no-store");

  if (!ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: "ADMIN_API_DISABLED",
      message: `管理接口未启用：服务端未配置有效的 ADMIN_API_KEY（至少 ${ADMIN_API_KEY_MIN_LENGTH} 位且不能是占位值）`,
    });
  }

  if (safeTimingEqual(ADMIN_API_KEY, extractApiKey(req))) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: "UNAUTHORIZED",
    message: "缺少有效的管理接口访问凭证",
  });
}

function createRateLimiter({ namespace, windowMs, maxRequests, buckets }) {
  // 过期桶的全量清扫放定时器里做，请求路径只碰自己的桶——
  // 公开高频端点不能为 O(所有桶) 的扫描买单。
  const cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [key, timestamps] of buckets.entries()) {
      const activeTimestamps = timestamps.filter(
        (timestamp) => now - timestamp < windowMs
      );

      if (activeTimestamps.length === 0) {
        buckets.delete(key);
        continue;
      }

      buckets.set(key, activeTimestamps);
    }
  }, windowMs);

  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }

  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${namespace}:${getRequestIp(req)}`;
    const bucket = buckets.get(bucketKey) || [];
    const recentTimestamps = bucket.filter((timestamp) => now - timestamp < windowMs);

    recentTimestamps.push(now);
    buckets.set(bucketKey, recentTimestamps);

    if (recentTimestamps.length > maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowMs - (now - recentTimestamps[0])) / 1000)
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        error: "RATE_LIMITED",
        message: `请求过于频繁，请在 ${retryAfterSeconds} 秒后重试`,
      });
    }

    next();
  };
}

const steamMutationRateLimiter = createRateLimiter({
  namespace: "steam-admin-mutation",
  windowMs: ADMIN_ROUTE_WINDOW_MS,
  maxRequests: ADMIN_ROUTE_MAX_REQUESTS,
  buckets: adminRouteBuckets,
});

const publicTagsRateLimiter = createRateLimiter({
  namespace: "public-app-tags",
  windowMs: PUBLIC_ROUTE_WINDOW_MS,
  maxRequests: PUBLIC_ROUTE_MAX_REQUESTS,
  buckets: publicRouteBuckets,
});

function buildRequestHeaders(lang) {
  return {
    "User-Agent": DEFAULT_USER_AGENT,
    "Accept-Language":
      lang === "schinese"
        ? "zh-CN,zh;q=0.9,en;q=0.8"
        : lang === "tchinese"
        ? "zh-TW,zh;q=0.9,en;q=0.8"
        : "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

function isRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableError(err) {
  if (!err) return false;
  const code = err.code || "";
  const msg = String(err.message || "");
  return (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ERR_NETWORK" ||
    msg.includes("timeout") ||
    msg.includes("socket hang up") ||
    msg.includes("ECONNRESET")
  );
}

async function requestWithRetry(client, config) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.request({
        ...config,
        timeout:
          Number.isFinite(Number(config.timeout)) && Number(config.timeout) > 0
            ? Number(config.timeout)
            : REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });

      if (isRetryableStatus(response.status)) {
        if (attempt === MAX_RETRIES - 1) {
          return response;
        }

        const retryAfter = Number(response.headers?.["retry-after"]);
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 250);

        await sleep(delay);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;

      if (!isRetryableError(err) || attempt === MAX_RETRIES - 1) {
        throw err;
      }

      const delay =
        RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }

  throw lastError || new Error("Unknown request error");
}

function splitCookieHeader(raw = "") {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.includes("="));
}

function normalizeCookieDomain(value = "") {
  return String(value || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();
}

function isAllowedSteamCookieDomain(domain = "") {
  const normalizedDomain = normalizeCookieDomain(domain);
  if (!normalizedDomain) return false;

  return STEAM_SESSION_COOKIE_DOMAINS.some(
    (allowedDomain) =>
      normalizedDomain === allowedDomain ||
      normalizedDomain.endsWith(`.${allowedDomain}`)
  );
}

function buildNormalizedCookie({
  name = "",
  value = "",
  domain = "",
  path: cookiePath = "/",
  secure = false,
  httpOnly = false,
  sameSite = null,
  expires = -1,
}) {
  const normalizedDomain = normalizeCookieDomain(domain);

  if (!name || !normalizedDomain || !isAllowedSteamCookieDomain(normalizedDomain)) {
    return null;
  }

  return {
    name: String(name || "").trim(),
    value: String(value || ""),
    domain: normalizedDomain,
    path: String(cookiePath || "/").startsWith("/")
      ? String(cookiePath || "/")
      : `/${cookiePath}`,
    secure: Boolean(secure),
    httpOnly: Boolean(httpOnly),
    sameSite: sameSite || null,
    expires: Number.isFinite(Number(expires)) ? Number(expires) : -1,
  };
}

function normalizeSteamSessionCookieString(cookieString = "") {
  const parsed = Cookie.parse(String(cookieString || ""));
  if (!parsed?.key) {
    return [];
  }

  const expires =
    parsed.expires instanceof Date && Number.isFinite(parsed.expires.getTime())
      ? Math.floor(parsed.expires.getTime() / 1000)
      : -1;
  const domains = parsed.domain
    ? [normalizeCookieDomain(parsed.domain)]
    : STEAM_SESSION_COOKIE_DOMAINS;

  return domains
    .map((domain) =>
      buildNormalizedCookie({
        name: parsed.key,
        value: parsed.value,
        domain,
        path: parsed.path || "/",
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        sameSite: parsed.sameSite || null,
        expires,
      })
    )
    .filter(Boolean);
}

function dedupeCookies(cookies = []) {
  const uniqueCookies = new Map();

  for (const cookie of cookies) {
    const key = [cookie.domain, cookie.path, cookie.name].join("\t");
    uniqueCookies.set(key, cookie);
  }

  return [...uniqueCookies.values()];
}

function isExpiredCookie(cookie = {}) {
  return (
    Number.isFinite(cookie.expires) &&
    cookie.expires > 0 &&
    cookie.expires * 1000 <= Date.now()
  );
}

function serializeCookieForJar(cookie = {}) {
  let serialized = `${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${
    cookie.path || "/"
  }`;

  if (cookie.secure) {
    serialized += "; Secure";
  }

  if (cookie.httpOnly) {
    serialized += "; HttpOnly";
  }

  if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
    serialized += `; Expires=${new Date(cookie.expires * 1000).toUTCString()}`;
  }

  return serialized;
}

function setManagedSteamCookies(cookieStrings = [], source = null) {
  const normalizedCookieStrings = [...new Set(cookieStrings.map(String).filter(Boolean))];
  const normalizedCookies = dedupeCookies(
    normalizedCookieStrings
      .flatMap((cookieString) => normalizeSteamSessionCookieString(cookieString))
      .filter((cookie) => !isExpiredCookie(cookie))
  );

  steamCookieState.cookieStrings = normalizedCookieStrings;
  steamCookieState.cookies = normalizedCookies;
  steamCookieState.cookieCount = normalizedCookies.length;
  steamCookieState.source = source;
}

async function seedManagedSteamCookies(jar) {
  for (const cookie of steamCookieState.cookies) {
    if (!cookie?.name || !cookie?.domain || isExpiredCookie(cookie)) {
      continue;
    }

    try {
      await jar.setCookie(
        serializeCookieForJar(cookie),
        `https://${cookie.domain}${cookie.path || "/"}`
      );
    } catch {
      // 忽略单个损坏 cookie，避免整个请求失败
    }
  }
}

function hasStoredAuthCookies() {
  return Boolean(GLOBAL_STEAM_COOKIE || steamCookieState.cookieCount > 0);
}

async function seedJar(jar, rawCookieHeader = "", options = {}) {
  const { useStoredAuthCookies = true } = options;
  const baseUrl = "https://store.steampowered.com/";

  if (useStoredAuthCookies) {
    for (const pair of splitCookieHeader(GLOBAL_STEAM_COOKIE)) {
      await jar.setCookie(pair, baseUrl);
    }

    await seedManagedSteamCookies(jar);
  }

  for (const pair of splitCookieHeader(rawCookieHeader)) {
    await jar.setCookie(pair, baseUrl);
  }

  await jar.setCookie(
    "birthtime=0; Domain=store.steampowered.com; Path=/",
    baseUrl
  );
  await jar.setCookie(
    "lastagecheckage=1-0-1970; Domain=store.steampowered.com; Path=/",
    baseUrl
  );
  await jar.setCookie(
    "wants_mature_content=1; Domain=store.steampowered.com; Path=/",
    baseUrl
  );
  await jar.setCookie(
    "wants_mature_content_sex=1; Domain=store.steampowered.com; Path=/",
    baseUrl
  );
  await jar.setCookie(
    "wants_mature_content_violence=1; Domain=store.steampowered.com; Path=/",
    baseUrl
  );
}

function createClient(jar) {
  if (SOCKS5_PROXY_URL) {
    const proxyCookieAgent = new SocksCookieAgent(SOCKS5_PROXY_URL, {
      cookies: { jar },
    });

    return axios.create({
      withCredentials: true,
      maxRedirects: 5,
      decompress: true,
      httpAgent: proxyCookieAgent,
      httpsAgent: proxyCookieAgent,
      proxy: false,
    });
  }

  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 5,
      decompress: true,
    })
  );
}

function getFinalUrl(response, fallback) {
  return response?.request?.res?.responseUrl || fallback;
}

function normalizeText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeName(value = "") {
  const normalized = normalizeText(value);
  return normalized || null;
}

function safeParseJson(payload) {
  if (payload && typeof payload === "object") {
    return payload;
  }

  if (typeof payload !== "string") {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function formatDateParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d) ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > 31
  ) {
    return null;
  }

  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(
    d
  ).padStart(2, "0")}`;
}

function normalizeReleaseDate(value = "") {
  const text = normalizeText(value);
  if (!text) return null;

  let match = text.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
  if (match) {
    return formatDateParts(match[1], match[2], match[3]);
  }

  match = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
  if (match) {
    return formatDateParts(match[1], match[2], match[3]);
  }

  match = text.match(/^(\d{1,2})\s+([A-Za-z.]+),?\s+(\d{4})$/);
  if (match) {
    const month = ENGLISH_MONTH_MAP[match[2].replace(/\./g, "").toLowerCase()];
    if (month) {
      return formatDateParts(match[3], month, match[1]);
    }
  }

  match = text.match(/^([A-Za-z.]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const month = ENGLISH_MONTH_MAP[match[1].replace(/\./g, "").toLowerCase()];
    if (month) {
      return formatDateParts(match[3], month, match[2]);
    }
  }

  return null;
}

function summarizeDomainCookies(domain = "") {
  const normalizedDomain = normalizeCookieDomain(domain);
  const cookies = steamCookieState.cookies.filter(
    (cookie) => cookie.domain === normalizedDomain
  );

  return {
    count: cookies.length,
    names: cookies.map((cookie) => cookie.name).sort(),
  };
}

function getStoredCookieDiagnostics() {
  const storeSummary = summarizeDomainCookies("store.steampowered.com");
  const communitySummary = summarizeDomainCookies("steamcommunity.com");
  const storeCookieNames = new Set(storeSummary.names);
  const communityCookieNames = new Set(communitySummary.names);

  return {
    store: {
      count: storeSummary.count,
      hasSessionId: storeCookieNames.has("sessionid"),
      hasSteamLoginSecure: storeCookieNames.has("steamLoginSecure"),
      seedsAgeGateCookies: true,
      seedsMatureContentPrefs: true,
    },
    community: {
      count: communitySummary.count,
      hasSessionId: communityCookieNames.has("sessionid"),
      hasSteamLoginSecure: communityCookieNames.has("steamLoginSecure"),
    },
  };
}

function getSteamSessionStatus() {
  const activePendingLogins = [...pendingSteamLogins.values()].filter(
    (attempt) => !attempt.completed
  );

  return {
    provider: "steam-session",
    storeFileName: path.basename(STEAM_SESSION_STORE_PATH),
    refreshIntervalMs: STEAM_SESSION_REFRESH_INTERVAL_MS,
    loginTimeoutMs: STEAM_SESSION_LOGIN_TIMEOUT_MS,
    cookieDomains: STEAM_SESSION_COOKIE_DOMAINS,
    source: steamCookieState.source,
    cookieCount: steamCookieState.cookieCount,
    hasCookies: steamCookieState.cookieCount > 0,
    hasRefreshToken: Boolean(steamSessionState.refreshToken),
    accountName: steamSessionState.accountName,
    steamId: steamSessionState.steamId,
    lastAuthenticatedAt: steamSessionState.lastAuthenticatedAt,
    lastCookieRefreshAt: steamSessionState.lastCookieRefreshAt,
    lastCookieRefreshOkAt: steamSessionState.lastCookieRefreshOkAt,
    lastError: steamSessionState.lastError,
    lastErrorAt: steamSessionState.lastErrorAt,
    refreshInProgress: steamSessionState.refreshInProgress,
    pendingLoginCount: activePendingLogins.length,
    diagnostics: getStoredCookieDiagnostics(),
  };
}

function getSteamSessionHealthSummary() {
  return {
    provider: "steam-session",
    hasRefreshToken: Boolean(steamSessionState.refreshToken),
    cookieCount: steamCookieState.cookieCount,
    hasCookies: steamCookieState.cookieCount > 0,
    source: steamCookieState.source,
    lastCookieRefreshOkAt: steamSessionState.lastCookieRefreshOkAt,
    lastError: steamSessionState.lastError,
    refreshInProgress: steamSessionState.refreshInProgress,
    pendingLoginCount: [...pendingSteamLogins.values()].filter(
      (attempt) => !attempt.completed
    ).length,
  };
}

async function loadPersistedSteamSessionState() {
  try {
    const raw = await fs.readFile(STEAM_SESSION_STORE_PATH, "utf8");
    const payload = safeParseJson(raw);

    steamSessionState.refreshToken = String(payload?.refreshToken || "").trim();
    steamSessionState.accountName = payload?.accountName || null;
    steamSessionState.steamId = payload?.steamId || null;
    steamSessionState.lastAuthenticatedAt = payload?.lastAuthenticatedAt || null;
    steamSessionState.lastCookieRefreshAt = payload?.lastCookieRefreshAt || null;
    steamSessionState.lastCookieRefreshOkAt =
      payload?.lastCookieRefreshOkAt || null;

    const cookieStrings = Array.isArray(payload?.cookieStrings)
      ? payload.cookieStrings
      : [];
    setManagedSteamCookies(cookieStrings, cookieStrings.length ? "persisted_file" : null);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return;
    }

    steamSessionState.lastError = `读取 steam-session 持久化文件失败: ${err.message}`;
    steamSessionState.lastErrorAt = new Date().toISOString();
  }
}

async function persistSteamSessionState() {
  await fs.mkdir(path.dirname(STEAM_SESSION_STORE_PATH), {
    recursive: true,
  });

  const serializedState = JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      accountName: steamSessionState.accountName,
      steamId: steamSessionState.steamId,
      refreshToken: steamSessionState.refreshToken,
      lastAuthenticatedAt: steamSessionState.lastAuthenticatedAt,
      lastCookieRefreshAt: steamSessionState.lastCookieRefreshAt,
      lastCookieRefreshOkAt: steamSessionState.lastCookieRefreshOkAt,
      cookieDomains: STEAM_SESSION_COOKIE_DOMAINS,
      cookieStrings: steamCookieState.cookieStrings,
    },
    null,
    2
  );

  await fs.writeFile(
    STEAM_SESSION_STORE_PATH,
    serializedState,
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );

  try {
    await fs.chmod(STEAM_SESSION_STORE_PATH, 0o600);
  } catch {
    // 忽略 chmod 失败，避免非 POSIX 环境下持久化直接报错
  }
}

function formatSteamSessionError(err) {
  if (!err) {
    return "未知 Steam 会话错误";
  }

  const message = String(err.message || "Steam 会话操作失败");
  return Number.isInteger(Number(err.eresult))
    ? `${message} (EResult ${Number(err.eresult)})`
    : message;
}

function normalizeSteamId(steamId) {
  if (!steamId) return null;

  if (typeof steamId.getSteamID64 === "function") {
    return String(steamId.getSteamID64());
  }

  const asText = String(steamId).trim();
  return asText || null;
}

function cleanupExpiredPendingSteamLogins() {
  const now = Date.now();

  for (const [loginId, attempt] of pendingSteamLogins.entries()) {
    const referenceTime = Date.parse(
      attempt.completedAt || attempt.errorAt || attempt.updatedAt || attempt.createdAt
    );

    if (!Number.isFinite(referenceTime)) {
      continue;
    }

    if (now - referenceTime < STEAM_SESSION_LOGIN_ATTEMPT_TTL_MS) {
      continue;
    }

    if (!attempt.completed) {
      try {
        attempt.session.cancelLoginAttempt();
      } catch {
        // 忽略清理阶段的取消失败
      }
    }

    pendingSteamLogins.delete(loginId);
  }
}

function guardTypeName(type) {
  return EAuthSessionGuardType[type] || String(type);
}

function describeGuardAction(action = {}) {
  const type = action?.type;
  const typeName = guardTypeName(type);
  const detail = action?.detail || null;

  let description = "需要继续完成 Steam 登录验证。";
  if (type === EAuthSessionGuardType.EmailCode) {
    description = detail
      ? `请输入发送到邮箱域名 ${detail} 的验证码。`
      : "请输入邮箱验证码。";
  } else if (type === EAuthSessionGuardType.DeviceCode) {
    description = "请输入 Steam 手机令牌生成的两步验证码。";
  } else if (type === EAuthSessionGuardType.DeviceConfirmation) {
    description = "请在 Steam 手机 App 中确认本次登录。";
  } else if (type === EAuthSessionGuardType.EmailConfirmation) {
    description = "请在邮件中确认本次登录。";
  }

  return {
    type,
    typeName,
    detail,
    description,
  };
}

function serializeLoginAttempt(attempt) {
  return {
    loginId: attempt.id,
    accountName: attempt.accountName,
    steamId: attempt.steamId,
    status: attempt.status,
    actionRequired: attempt.actionRequired,
    validActions: attempt.validActions.map(describeGuardAction),
    error: attempt.error,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    completedAt: attempt.completedAt,
    authenticatedAt: attempt.authenticatedAt,
    remoteInteractionAt: attempt.remoteInteractionAt,
    lastSubmittedGuardAt: attempt.lastSubmittedGuardAt,
    refreshTokenStored: attempt.refreshTokenStored,
    cookiesRefreshedAt: attempt.cookiesRefreshedAt,
  };
}

function markLoginAttemptCompleted(attempt, status, extra = {}) {
  if (attempt.completed) {
    return;
  }

  attempt.status = status;
  attempt.completed = true;
  attempt.actionRequired = false;
  attempt.updatedAt = new Date().toISOString();
  attempt.completedAt = attempt.updatedAt;
  Object.assign(attempt, extra);
  attempt.settle.resolve();
}

function attachSteamLoginEventHandlers(attempt) {
  const { session } = attempt;

  session.on("polling", () => {
    attempt.status = attempt.actionRequired ? "awaiting_completion" : "polling";
    attempt.updatedAt = new Date().toISOString();
  });

  session.on("remoteInteraction", () => {
    attempt.status = "awaiting_confirmation";
    attempt.remoteInteractionAt = new Date().toISOString();
    attempt.updatedAt = attempt.remoteInteractionAt;
  });

  session.on("timeout", () => {
    attempt.error = "Steam 登录超时，请重新发起登录。";
    attempt.errorAt = new Date().toISOString();
    markLoginAttemptCompleted(attempt, "timed_out", {
      error: attempt.error,
    });
  });

  session.on("authenticated", async () => {
    const authenticatedAt = new Date().toISOString();

    try {
      const cookieStrings = await session.getWebCookies();
      if (!Array.isArray(cookieStrings) || cookieStrings.length === 0) {
        throw new Error("已拿到 refresh token，但未换取到任何 Cookie");
      }

      steamSessionState.refreshToken = String(session.refreshToken || "").trim();
      steamSessionState.accountName = session.accountName || attempt.accountName || null;
      steamSessionState.steamId = normalizeSteamId(session.steamID) || attempt.steamId;
      steamSessionState.lastAuthenticatedAt = authenticatedAt;
      steamSessionState.lastCookieRefreshAt = authenticatedAt;
      steamSessionState.lastCookieRefreshOkAt = authenticatedAt;
      steamSessionState.lastError = null;
      steamSessionState.lastErrorAt = null;

      setManagedSteamCookies(cookieStrings, "steam_session_interactive_login");
      await persistSteamSessionState();
      ensureSteamCookieRefreshTimer();

      markLoginAttemptCompleted(attempt, "authenticated", {
        authenticatedAt,
        refreshTokenStored: true,
        cookiesRefreshedAt: authenticatedAt,
      });
    } catch (err) {
      const message = `登录成功，但换取 Cookie 失败: ${formatSteamSessionError(err)}`;
      steamSessionState.lastError = message;
      steamSessionState.lastErrorAt = new Date().toISOString();
      attempt.error = message;
      attempt.errorAt = steamSessionState.lastErrorAt;
      markLoginAttemptCompleted(attempt, "failed", {
        error: attempt.error,
      });
    }
  });

  session.on("error", (err) => {
    const message = formatSteamSessionError(err);
    attempt.error = message;
    attempt.errorAt = new Date().toISOString();
    markLoginAttemptCompleted(attempt, "failed", {
      error: message,
    });
  });
}

async function waitForLoginAttemptProgress(attempt, timeoutMs = 1200) {
  await Promise.race([
    attempt.settle.promise.catch(() => null),
    sleep(timeoutMs),
  ]);
}

async function startInteractiveSteamLogin({
  accountName,
  password,
  steamGuardCode = "",
}) {
  cleanupExpiredPendingSteamLogins();

  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser, {
    userAgent: DEFAULT_USER_AGENT,
    ...(SOCKS5_PROXY_URL ? { socksProxy: SOCKS5_PROXY_URL } : {}),
  });
  session.loginTimeout = STEAM_SESSION_LOGIN_TIMEOUT_MS;

  const attempt = {
    id: randomUUID(),
    session,
    settle: createDeferred(),
    accountName: String(accountName || "").trim(),
    steamId: null,
    status: "starting",
    actionRequired: false,
    validActions: [],
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    authenticatedAt: null,
    errorAt: null,
    remoteInteractionAt: null,
    lastSubmittedGuardAt: null,
    refreshTokenStored: false,
    cookiesRefreshedAt: null,
    completed: false,
  };

  attachSteamLoginEventHandlers(attempt);
  pendingSteamLogins.set(attempt.id, attempt);

  let startResult;

  try {
    startResult = await session.startWithCredentials({
      accountName: attempt.accountName,
      password: String(password || ""),
      persistence: ESessionPersistence.Persistent,
      steamGuardCode: String(steamGuardCode || "").trim() || undefined,
    });
  } catch (err) {
    pendingSteamLogins.delete(attempt.id);
    throw err;
  }

  attempt.steamId = normalizeSteamId(session.steamID);
  attempt.actionRequired = Boolean(startResult?.actionRequired);
  attempt.validActions = Array.isArray(startResult?.validActions)
    ? startResult.validActions
    : [];
  attempt.status = attempt.actionRequired ? "awaiting_guard" : "polling";
  attempt.updatedAt = new Date().toISOString();

  await waitForLoginAttemptProgress(attempt);

  return serializeLoginAttempt(attempt);
}

async function submitSteamGuardCodeForLogin(loginId, code) {
  cleanupExpiredPendingSteamLogins();

  const attempt = pendingSteamLogins.get(loginId);
  if (!attempt) {
    return null;
  }

  if (attempt.completed) {
    return serializeLoginAttempt(attempt);
  }

  await attempt.session.submitSteamGuardCode(String(code || "").trim());
  attempt.actionRequired = false;
  attempt.status = "polling";
  attempt.lastSubmittedGuardAt = new Date().toISOString();
  attempt.updatedAt = attempt.lastSubmittedGuardAt;

  await waitForLoginAttemptProgress(attempt);

  return serializeLoginAttempt(attempt);
}

async function refreshSteamSessionCookies() {
  if (!steamSessionState.refreshToken) {
    throw new Error("当前没有可用的 refresh token，请先完成一次交互式登录");
  }

  if (steamCookieRefreshPromise) {
    return steamCookieRefreshPromise;
  }

  steamCookieRefreshPromise = (async () => {
    steamSessionState.refreshInProgress = true;
    steamSessionState.lastCookieRefreshAt = new Date().toISOString();

    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser, {
      userAgent: DEFAULT_USER_AGENT,
      ...(SOCKS5_PROXY_URL ? { socksProxy: SOCKS5_PROXY_URL } : {}),
    });
    session.refreshToken = steamSessionState.refreshToken;

    const cookieStrings = await session.getWebCookies();
    if (!Array.isArray(cookieStrings) || cookieStrings.length === 0) {
      throw new Error("refresh token 换取 Cookie 失败，未返回任何 Cookie");
    }

    steamSessionState.steamId =
      normalizeSteamId(session.steamID) || steamSessionState.steamId;
    steamSessionState.lastCookieRefreshOkAt = new Date().toISOString();
    steamSessionState.lastError = null;
    steamSessionState.lastErrorAt = null;

    setManagedSteamCookies(cookieStrings, "steam_session_refresh_token");
    await persistSteamSessionState();

    return {
      cookieCount: steamCookieState.cookieCount,
      refreshedAt: steamSessionState.lastCookieRefreshOkAt,
    };
  })();

  try {
    return await steamCookieRefreshPromise;
  } catch (err) {
    steamSessionState.lastError = formatSteamSessionError(err);
    steamSessionState.lastErrorAt = new Date().toISOString();
    throw err;
  } finally {
    steamSessionState.refreshInProgress = false;
    steamCookieRefreshPromise = null;
  }
}

function ensureSteamCookieRefreshTimer() {
  if (steamCookieRefreshTimer || !steamSessionState.refreshToken) {
    return;
  }

  steamCookieRefreshTimer = setInterval(() => {
    refreshSteamSessionCookies().catch((err) => {
      console.error(`[steam-session] 定时刷新 Cookie 失败: ${err.message}`);
    });
  }, STEAM_SESSION_REFRESH_INTERVAL_MS);

  if (typeof steamCookieRefreshTimer.unref === "function") {
    steamCookieRefreshTimer.unref();
  }
}

function stopSteamCookieRefreshTimer() {
  if (!steamCookieRefreshTimer) {
    return;
  }

  clearInterval(steamCookieRefreshTimer);
  steamCookieRefreshTimer = null;
}

function cancelPendingSteamLogins() {
  for (const attempt of pendingSteamLogins.values()) {
    if (attempt.completed) {
      continue;
    }

    try {
      attempt.session.cancelLoginAttempt();
    } catch {
      // 忽略停机阶段的会话取消失败
    }
  }
}

async function initializeSteamSessionAuth() {
  await loadPersistedSteamSessionState();

  if (!steamSessionState.refreshToken) {
    return;
  }

  try {
    await refreshSteamSessionCookies();
  } catch (err) {
    console.error(`[steam-session] 初次刷新 Cookie 失败: ${err.message}`);
  }

  ensureSteamCookieRefreshTimer();
}

function toAbsoluteStoreUrl(href = "") {
  const normalizedHref = String(href || "").trim();
  if (!normalizedHref) return null;

  try {
    const url = new URL(normalizedHref, "https://store.steampowered.com");
    url.searchParams.delete("snr");
    return url.toString();
  } catch {
    return null;
  }
}

function isAgeGate(html = "", url = "") {
  const normalizedHtml = String(html || "");

  return (
    url.includes("/agecheck/") ||
    /Please enter your birth date to continue/i.test(normalizedHtml) ||
    /name=["']ageDay["']/i.test(normalizedHtml) ||
    /name=["']ageMonth["']/i.test(normalizedHtml) ||
    /name=["']ageYear["']/i.test(normalizedHtml) ||
    /agecheckset/i.test(normalizedHtml)
  );
}

function looksLikeLoginOrPreferenceRestricted(html = "", finalUrl = "") {
  // 只认结构化特征：全文关键词（login/adult/登录 等）会命中所有正常商店页的
  // 全局页头和内嵌 JSON，导致该判定恒真
  if (String(finalUrl || "").includes("/login")) {
    return true;
  }

  const $ = cheerio.load(String(html || ""));

  return Boolean(
    $("#view_product_page_btn").length ||
      $(".content_warning_ctn").length ||
      $(".adult_content_under_age").length ||
      $(".mature_content_notice").length
  );
}

function scoreSteamResult(result = {}) {
  return (Array.isArray(result.tags) ? result.tags.length : 0) * 10 +
    (Array.isArray(result.developers) ? result.developers.length : 0);
}

function hasCompleteTagPayload(result = {}) {
  return (
    Array.isArray(result.tags) &&
    result.tags.length > 0 &&
    Array.isArray(result.developers) &&
    result.developers.length > 0
  );
}

function pickSelectValue($, $select, matchers) {
  const options = $select.find("option").toArray();

  for (const option of options) {
    const $option = $(option);
    const value = String($option.attr("value") || "").trim();
    const text = String($option.text() || "").trim();

    for (const matcher of matchers) {
      if (matcher.test(value) || matcher.test(text)) {
        return value || text;
      }
    }
  }

  const first = $select.find("option").first();
  if (first.length) {
    return String(first.attr("value") || first.text() || "").trim();
  }

  return null;
}

function buildAgeGatePayload($, form) {
  const payload = {};

  form.find("input[name], select[name], textarea[name]").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;

    const tagName = (el.tagName || "").toLowerCase();

    if (tagName === "select") {
      const $selected = $el.find("option[selected]").first();
      const $first = $el.find("option").first();
      payload[name] = String(
        $selected.attr("value") ||
          $selected.text() ||
          $first.attr("value") ||
          $first.text() ||
          ""
      ).trim();
      return;
    }

    const type = String($el.attr("type") || "").toLowerCase();

    if (type === "checkbox" || type === "radio") {
      if ($el.is(":checked") || $el.attr("checked")) {
        payload[name] = $el.val() || "on";
      }
      return;
    }

    payload[name] = String($el.val() || $el.attr("value") || "").trim();
  });

  const $ageDay = form.find('select[name="ageDay"]');
  const $ageMonth = form.find('select[name="ageMonth"]');
  const $ageYear = form.find('select[name="ageYear"]');

  if ($ageDay.length) {
    payload.ageDay =
      pickSelectValue($, $ageDay, [/^1$/, /^01$/]) ||
      payload.ageDay ||
      "1";
  } else {
    payload.ageDay = payload.ageDay || "1";
  }

  if ($ageMonth.length) {
    payload.ageMonth =
      pickSelectValue($, $ageMonth, [/^1$/, /^01$/, /january/i]) ||
      payload.ageMonth ||
      "1";
  } else {
    payload.ageMonth = payload.ageMonth || "1";
  }

  if ($ageYear.length) {
    payload.ageYear =
      pickSelectValue($, $ageYear, [/^1970$/, /^1969$/, /^1900$/]) ||
      payload.ageYear ||
      "1970";
  } else {
    payload.ageYear = payload.ageYear || "1970";
  }

  return payload;
}

async function passAgeGateIfNeeded(client, appid, lang) {
  const ageUrl = `https://store.steampowered.com/agecheck/app/${appid}/?l=${encodeURIComponent(
    lang
  )}`;

  const ageGet = await requestWithRetry(client, {
    method: "GET",
    url: ageUrl,
    headers: {
      ...buildRequestHeaders(lang),
      Referer: `https://store.steampowered.com/app/${appid}/?l=${encodeURIComponent(
        lang
      )}`,
    },
  });

  let html = typeof ageGet.data === "string" ? ageGet.data : "";
  let finalUrl = getFinalUrl(ageGet, ageUrl);

  if (!isAgeGate(html, finalUrl)) {
    return {
      handled: false,
      html,
      finalUrl,
    };
  }

  const $ = cheerio.load(html);
  const form = $("form").first();

  if (!form.length) {
    return {
      handled: false,
      html,
      finalUrl,
    };
  }

  const action = form.attr("action") || `/agecheckset/app/${appid}/`;
  const actionUrl = new URL(action, ageUrl).toString();
  const payload = buildAgeGatePayload($, form);

  const agePost = await requestWithRetry(client, {
    method: "POST",
    url: actionUrl,
    data: new URLSearchParams(payload).toString(),
    headers: {
      ...buildRequestHeaders(lang),
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: ageUrl,
    },
  });

  html = typeof agePost.data === "string" ? agePost.data : "";
  finalUrl = getFinalUrl(agePost, actionUrl);

  return {
    handled: true,
    html,
    finalUrl,
  };
}

function extractTags(html) {
  const $ = cheerio.load(html);

  let tags = $(
    ".glance_tags.popular_tags a.app_tag, .glance_tags a.app_tag, .glance_tags_ctn a.app_tag"
  )
    .map((_, el) => normalizeText($(el).text()))
    .get()
    .filter(Boolean)
    .filter((tag) => tag !== "+")
    .filter((tag) => tag.length <= 60);

  tags = [...new Set(tags)];

  const developers = $("#developers_list a")
    .map((_, el) => {
      const $el = $(el);
      const developerName = normalizeText($el.text());
      const developerLink = toAbsoluteStoreUrl($el.attr("href"));

      if (!developerName || !developerLink) return null;

      return {
        name: developerName,
        link: developerLink,
      };
    })
    .get()
    .filter(Boolean)
    .filter(
      (developer, index, list) =>
        list.findIndex(
          (item) =>
            item.name === developer.name && item.link === developer.link
        ) === index
    );

  return {
    tags,
    developers,
  };
}

async function fetchAppDetails(client, appid, lang) {
  const cacheKey = `${appid}:${lang}`;
  const cachedEntry = getCacheEntry(appDetailsCache, cacheKey);
  if (cachedEntry) {
    return cachedEntry.missing ? null : cachedEntry;
  }

  if (appDetailsInflightRequests.has(cacheKey)) {
    return appDetailsInflightRequests.get(cacheKey);
  }

  const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(
    appid
  )}&l=${encodeURIComponent(lang)}`;

  const requestPromise = (async () => {
    const response = await requestWithRetry(client, {
      method: "GET",
      url,
      headers: buildRequestHeaders(lang),
    });

    const payload = safeParseJson(response.data);
    const entry = payload?.[String(appid)];

    if (!entry?.success || !entry.data) {
      // 查无此 app 也要短暂缓存（哨兵 { missing: true }，缓存值为 null 会被
      // getCacheEntry 当未命中）：否则无效 appid 的每轮重试都会重发全部 appdetails 请求。
      setCacheEntry(
        appDetailsCache,
        cacheKey,
        { missing: true },
        APP_TAGS_NEGATIVE_CACHE_TTL_MS,
        APP_DETAILS_CACHE_MAX_ENTRIES
      );
      return null;
    }

    setCacheEntry(
      appDetailsCache,
      cacheKey,
      entry.data,
      APP_DETAILS_CACHE_TTL_MS,
      APP_DETAILS_CACHE_MAX_ENTRIES
    );

    return entry.data;
  })();

  appDetailsInflightRequests.set(cacheKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    appDetailsInflightRequests.delete(cacheKey);
  }
}

async function fetchLocalizedAppMetadata(client, appid) {
  const detailRequests = await Promise.allSettled([
    fetchAppDetails(client, appid, "schinese"),
    fetchAppDetails(client, appid, "english"),
    fetchAppDetails(client, appid, "japanese"),
    fetchAppDetails(client, appid, "tchinese"),
  ]);

  const [schinese, english, japanese, tchinese] = detailRequests.map((result) =>
    result.status === "fulfilled" ? result.value : null
  );

  return {
    name: normalizeName(schinese?.name),
    aliases: {
      english: normalizeName(english?.name),
      japanese: normalizeName(japanese?.name),
      tchinese: normalizeName(tchinese?.name),
    },
    releaseDate:
      normalizeReleaseDate(schinese?.release_date?.date) ||
      normalizeReleaseDate(english?.release_date?.date),
  };
}

async function fetchSteamTags(appid, lang, rawCookieHeader = "", options = {}) {
  const { useStoredAuthCookies = true } = options;
  const jar = new CookieJar();
  await seedJar(jar, rawCookieHeader, {
    useStoredAuthCookies,
  });

  const client = createClient(jar);
  const appUrl = `https://store.steampowered.com/app/${appid}/?l=${encodeURIComponent(
    lang
  )}`;

  let response = await requestWithRetry(client, {
    method: "GET",
    url: appUrl,
    headers: buildRequestHeaders(lang),
  });

  let html = typeof response.data === "string" ? response.data : "";
  let finalUrl = getFinalUrl(response, appUrl);
  let ageGateHandled = false;

  if (isAgeGate(html, finalUrl)) {
    const ageResult = await passAgeGateIfNeeded(client, appid, lang);
    ageGateHandled = ageResult.handled;

    response = await requestWithRetry(client, {
      method: "GET",
      url: appUrl,
      headers: {
        ...buildRequestHeaders(lang),
        Referer: ageResult.finalUrl || appUrl,
      },
    });

    html = typeof response.data === "string" ? response.data : "";
    finalUrl = getFinalUrl(response, appUrl);
  }

  const { tags, developers } = extractTags(html);
  const metadata = await fetchLocalizedAppMetadata(client, appid);

  const usedAuthenticatedCookie = Boolean(
    rawCookieHeader || (useStoredAuthCookies && hasStoredAuthCookies())
  );

  return {
    appid: String(appid),
    name: metadata.name,
    aliases: metadata.aliases,
    releaseDate: metadata.releaseDate,
    finalUrl,
    tags,
    developers,
    ageGateHandled,
    usedAuthenticatedCookie,
    rawHtml: html,
  };
}

function buildAppTagPayload(result) {
  return {
    appid: result.appid,
    name: result.name,
    aliases: result.aliases,
    releaseDate: result.releaseDate,
    tags: result.tags,
    developers: result.developers,
  };
}

function sendIncompleteTagsResponse(res, payload) {
  return res.status(504).json({
    success: false,
    error: "INCOMPLETE_UPSTREAM_DATA",
    message: `在 ${APP_TAGS_MAX_FETCH_ATTEMPTS} 次尝试后仍未获取到完整 tags/developers 数据`,
    data: payload,
  });
}

// 完整跑一轮抓取循环：匿名优先、必要时用托管 Cookie 重抓、最多 APP_TAGS_MAX_FETCH_ATTEMPTS 次。
// 无显式 Cookie 的请求会按 appid:lang 共享同一个在途任务，因此本函数不感知单个请求的
// 连接状态；shouldAbort 仅供携带显式 X-Steam-Cookie、不参与共享的请求做断开提前中止。
async function fetchAppTagsPayload(appid, lang, requestCookie = "", options = {}) {
  const { shouldAbort = () => false } = options;
  const requestHasExplicitCookie = Boolean(requestCookie);
  let lastResult = null;

  for (
    let attempt = 1;
    attempt <= APP_TAGS_MAX_FETCH_ATTEMPTS && !shouldAbort();
    attempt++
  ) {
    const anonymousResult = await fetchSteamTags(appid, lang, requestCookie, {
      useStoredAuthCookies: false,
    });
    let result = anonymousResult;
    lastResult = anonymousResult;

    const shouldRetryWithStoredAuth =
      !requestHasExplicitCookie &&
      hasStoredAuthCookies() &&
      (anonymousResult.tags.length === 0 ||
        anonymousResult.developers.length === 0 ||
        looksLikeLoginOrPreferenceRestricted(
          anonymousResult.rawHtml,
          anonymousResult.finalUrl
        ));

    if (shouldRetryWithStoredAuth) {
      const authenticatedResult = await fetchSteamTags(appid, lang, "", {
        useStoredAuthCookies: true,
      });

      if (
        scoreSteamResult(authenticatedResult) > scoreSteamResult(anonymousResult) ||
        (hasCompleteTagPayload(authenticatedResult) &&
          looksLikeLoginOrPreferenceRestricted(
            anonymousResult.rawHtml,
            anonymousResult.finalUrl
          ) &&
          !looksLikeLoginOrPreferenceRestricted(
            authenticatedResult.rawHtml,
            authenticatedResult.finalUrl
          ))
      ) {
        result = authenticatedResult;
      }

      lastResult = result;
    }

    if (shouldAbort()) {
      return { aborted: true, complete: false, payload: null };
    }

    const needsRetry =
      isAgeGate(result.rawHtml, result.finalUrl) || !hasCompleteTagPayload(result);

    if (needsRetry && attempt < APP_TAGS_MAX_FETCH_ATTEMPTS) {
      await sleep(EMPTY_RESULT_RETRY_DELAY_MS);
      continue;
    }

    if (needsRetry) {
      break;
    }

    return { aborted: false, complete: true, payload: buildAppTagPayload(result) };
  }

  if (shouldAbort()) {
    return { aborted: true, complete: false, payload: null };
  }

  return {
    aborted: false,
    complete: false,
    payload: lastResult ? buildAppTagPayload(lastResult) : null,
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "steam-tags-api",
    steamSessionAuth: getSteamSessionHealthSummary(),
  });
});

app.get("/api/steam-auth/status", requireAdminAccess, (_req, res) => {
  cleanupExpiredPendingSteamLogins();
  res.json({
    success: true,
    data: getSteamSessionStatus(),
  });
});

app.get("/api/steam-cookies/status", requireAdminAccess, (_req, res) => {
  cleanupExpiredPendingSteamLogins();
  res.json({
    success: true,
    data: getSteamSessionStatus(),
  });
});

app.post(
  "/api/steam-auth/login/start",
  requireAdminAccess,
  steamMutationRateLimiter,
  async (req, res) => {
    const accountName = String(req.body?.accountName || "").trim();
    const password = String(req.body?.password || "");
    const steamGuardCode = String(req.body?.steamGuardCode || "").trim();

    if (!accountName || !password) {
      return res.status(400).json({
        success: false,
        error: "INVALID_LOGIN_INPUT",
        message: "accountName 和 password 不能为空",
      });
    }

    try {
      const result = await startInteractiveSteamLogin({
        accountName,
        password,
        steamGuardCode,
      });

      return res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: "STEAM_LOGIN_START_FAILED",
        message: formatSteamSessionError(err),
      });
    }
  }
);

app.get("/api/steam-auth/login/:loginId", requireAdminAccess, (req, res) => {
  cleanupExpiredPendingSteamLogins();

  const attempt = pendingSteamLogins.get(String(req.params.loginId || "").trim());
  if (!attempt) {
    return res.status(404).json({
      success: false,
      error: "LOGIN_ATTEMPT_NOT_FOUND",
      message: "找不到对应的登录会话，可能已过期",
    });
  }

  return res.json({
    success: true,
    data: serializeLoginAttempt(attempt),
  });
});

app.post(
  "/api/steam-auth/login/submit-guard",
  requireAdminAccess,
  steamMutationRateLimiter,
  async (req, res) => {
    const loginId = String(req.body?.loginId || "").trim();
    const code = String(req.body?.code || "").trim();

    if (!loginId || !code) {
      return res.status(400).json({
        success: false,
        error: "INVALID_GUARD_INPUT",
        message: "loginId 和 code 不能为空",
      });
    }

    try {
      const result = await submitSteamGuardCodeForLogin(loginId, code);
      if (!result) {
        return res.status(404).json({
          success: false,
          error: "LOGIN_ATTEMPT_NOT_FOUND",
          message: "找不到对应的登录会话，可能已过期",
        });
      }

      return res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: "STEAM_GUARD_SUBMIT_FAILED",
        message: formatSteamSessionError(err),
      });
    }
  }
);

app.post(
  "/api/steam-cookies/sync",
  requireAdminAccess,
  steamMutationRateLimiter,
  async (_req, res) => {
    if (!steamSessionState.refreshToken) {
      return res.status(400).json({
        success: false,
        error: "REFRESH_TOKEN_NOT_FOUND",
        message: "当前没有可用的 refresh token，请先完成一次交互式登录",
      });
    }

    try {
      const result = await refreshSteamSessionCookies();

      return res.json({
        success: true,
        data: {
          ...getSteamSessionStatus(),
          refreshedAt: result.refreshedAt,
        },
      });
    } catch (err) {
      return res.status(502).json({
        success: false,
        error: "STEAM_COOKIE_REFRESH_FAILED",
        message: formatSteamSessionError(err),
      });
    }
  }
);

app.get("/api/app/:appid/tags", publicTagsRateLimiter, async (req, res) => {
  const { appid } = req.params;
  const lang = String(req.query.lang || DEFAULT_LANG).trim();
  const requestCookie = req.header("x-steam-cookie") || "";
  const requestHasExplicitCookie = Boolean(requestCookie);
  const appTagCacheKey = `${appid}:${lang}`;
  let requestClosed = false;

  req.on("close", () => {
    requestClosed = true;
  });

  if (!/^\d+$/.test(appid)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_APPID",
      message: "appid 必须是纯数字",
    });
  }

  try {
    if (!requestHasExplicitCookie) {
      // 缓存条目统一为 { complete, payload }：complete 为假是失败结果的短 TTL 负缓存，
      // 命中时直接回 504，不再触发上游抓取。
      const cachedEntry = getCacheEntry(appTagResponseCache, appTagCacheKey);
      if (cachedEntry) {
        if (cachedEntry.complete) {
          return res.json({
            success: true,
            data: cachedEntry.payload,
            warning: null,
          });
        }

        return sendIncompleteTagsResponse(res, cachedEntry.payload);
      }
    }

    let outcome;

    if (requestHasExplicitCookie) {
      outcome = await fetchAppTagsPayload(appid, lang, requestCookie, {
        shouldAbort: () => requestClosed,
      });
    } else {
      let inflight = appTagInflightRequests.get(appTagCacheKey);

      if (inflight) {
        outcome = await inflight;
      } else {
        inflight = (async () => {
          const result = await fetchAppTagsPayload(appid, lang, "");

          setCacheEntry(
            appTagResponseCache,
            appTagCacheKey,
            { complete: result.complete, payload: result.payload },
            result.complete ? APP_TAGS_CACHE_TTL_MS : APP_TAGS_NEGATIVE_CACHE_TTL_MS,
            APP_TAGS_CACHE_MAX_ENTRIES
          );

          return result;
        })();

        appTagInflightRequests.set(appTagCacheKey, inflight);

        try {
          outcome = await inflight;
        } finally {
          appTagInflightRequests.delete(appTagCacheKey);
        }
      }
    }

    if (outcome.aborted || requestClosed) {
      return;
    }

    if (outcome.complete) {
      return res.json({
        success: true,
        data: outcome.payload,
        warning: null,
      });
    }

    return sendIncompleteTagsResponse(res, outcome.payload);
  } catch (err) {
    const message =
      err?.response?.status
        ? `上游请求失败: HTTP ${err.response.status}`
        : err?.message || "未知错误";

    return res.status(502).json({
      success: false,
      error: "UPSTREAM_FETCH_FAILED",
      message,
    });
  }
});

function warnIfAdminApiDisabled() {
  if (ADMIN_API_KEY) {
    return;
  }

  const reason = ADMIN_API_KEY_RAW
    ? `当前 ADMIN_API_KEY 是占位值或长度不足 ${ADMIN_API_KEY_MIN_LENGTH} 位`
    : "未设置 ADMIN_API_KEY";

  console.warn(
    `[security] 管理接口已禁用（${reason}）。/api/steam-auth/* 与 /api/steam-cookies/* 将一律返回 403，` +
      "无法完成交互式登录。如需启用，请生成一个随机密钥：openssl rand -hex 32"
  );
}

async function startServer() {
  warnIfAdminApiDisabled();

  if (SOCKS5_PROXY_URL) {
    console.log(
      `[proxy] 对外请求已启用 SOCKS5 代理: ${new URL(SOCKS5_PROXY_URL).host}`
    );
  }

  await initializeSteamSessionAuth();

  server = await new Promise((resolve, reject) => {
    const instance = app.listen(PORT, HOST, () => {
      console.log(`Steam tags API listening on http://${HOST}:${PORT}`);
      resolve(instance);
    });

    instance.on("error", reject);
  });
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  stopSteamCookieRefreshTimer();
  cancelPendingSteamLogins();

  if (!server) {
    process.exit(0);
    return;
  }

  const shutdownTimer = setTimeout(() => {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  }, SHUTDOWN_TIMEOUT_MS);

  if (typeof shutdownTimer.unref === "function") {
    shutdownTimer.unref();
  }

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });

    clearTimeout(shutdownTimer);
    process.exit(0);
  } catch (err) {
    clearTimeout(shutdownTimer);
    console.error(`Graceful shutdown failed: ${err.message}`);
    process.exit(1);
  }
}

startServer().catch((err) => {
  console.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
