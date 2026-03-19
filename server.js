const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const cheerio = require("cheerio");
const WebSocket = require("ws");

const app = express();

const PORT = Number(process.env.PORT || 8765);
const DEFAULT_LANG = process.env.DEFAULT_LANG || "schinese";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 800);
const REMOTE_BROWSER_ENABLED = parseBooleanEnv(
  process.env.REMOTE_BROWSER_ENABLED || "false"
);
const REMOTE_BROWSER_CDP_HTTP_URL = trimTrailingSlash(
  process.env.REMOTE_BROWSER_CDP_HTTP_URL || ""
);
const REMOTE_BROWSER_CDP_WS_URL = String(
  process.env.REMOTE_BROWSER_CDP_WS_URL || ""
).trim();
const REMOTE_BROWSER_SYNC_INTERVAL_MS = Number(
  process.env.REMOTE_BROWSER_SYNC_INTERVAL_MS || 60000
);
const REMOTE_BROWSER_CDP_TIMEOUT_MS = Number(
  process.env.REMOTE_BROWSER_CDP_TIMEOUT_MS || REQUEST_TIMEOUT_MS
);
const REMOTE_BROWSER_COOKIE_STORE_PATH = path.resolve(
  process.cwd(),
  process.env.REMOTE_BROWSER_COOKIE_STORE_PATH ||
    "./steam-remote-browser-cookies.json"
);
const REMOTE_BROWSER_COOKIE_DOMAINS = parseCsvList(
  process.env.REMOTE_BROWSER_COOKIE_DOMAINS ||
    "store.steampowered.com,steamcommunity.com,help.steampowered.com"
);

// 可选：把你自己浏览器里的 Steam Cookie 整串放到环境变量里。
// 也可以每次请求时通过 X-Steam-Cookie 请求头单独传入。
const GLOBAL_STEAM_COOKIE = process.env.STEAM_COOKIE || "";

const DEFAULT_USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

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

const remoteBrowserCookieState = {
  cookies: [],
  cookieCount: 0,
  lastSyncAt: null,
  lastSyncOkAt: null,
  lastError: null,
  lastErrorAt: null,
  source: null,
  syncInProgress: false,
};

let remoteBrowserSyncPromise = null;
let remoteBrowserSyncTimer = null;
let nextCdpMessageId = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanEnv(value = "") {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}

function trimTrailingSlash(value = "") {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function parseCsvList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
}

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

async function seedRemoteBrowserCookies(jar) {
  for (const cookie of remoteBrowserCookieState.cookies) {
    if (
      !cookie?.name ||
      !cookie?.domain ||
      isExpiredRemoteBrowserCookie(cookie) ||
      !isAllowedRemoteBrowserCookieDomain(cookie.domain)
    ) {
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
  return Boolean(GLOBAL_STEAM_COOKIE || remoteBrowserCookieState.cookieCount > 0);
}

async function seedJar(jar, rawCookieHeader = "", options = {}) {
  const { useStoredAuthCookies = true } = options;
  const baseUrl = "https://store.steampowered.com/";

  if (useStoredAuthCookies) {
    // 全局登录态
    for (const pair of splitCookieHeader(GLOBAL_STEAM_COOKIE)) {
      await jar.setCookie(pair, baseUrl);
    }

    // 远程浏览器同步到本地的登录态
    await seedRemoteBrowserCookies(jar);
  }

  // 单次请求登录态，优先级更高
  for (const pair of splitCookieHeader(rawCookieHeader)) {
    await jar.setCookie(pair, baseUrl);
  }

  // 给普通年龄门准备的 cookie
  await jar.setCookie(
    "birthtime=0; Domain=store.steampowered.com; Path=/",
    baseUrl
  );
  await jar.setCookie(
    "lastagecheckage=1-0-1970; Domain=store.steampowered.com; Path=/",
    baseUrl
  );
}

function createClient(jar) {
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

function normalizeCookieDomain(value = "") {
  return String(value || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();
}

function isRemoteBrowserSyncConfigured() {
  return Boolean(REMOTE_BROWSER_CDP_WS_URL || REMOTE_BROWSER_CDP_HTTP_URL);
}

function isAllowedRemoteBrowserCookieDomain(domain = "") {
  const normalizedDomain = normalizeCookieDomain(domain);
  if (!normalizedDomain) return false;

  return REMOTE_BROWSER_COOKIE_DOMAINS.some(
    (allowedDomain) =>
      normalizedDomain === allowedDomain ||
      normalizedDomain.endsWith(`.${allowedDomain}`)
  );
}

function normalizeRemoteBrowserCookie(cookie = {}) {
  const name = String(cookie.name || "").trim();
  const domain = normalizeCookieDomain(cookie.domain);
  const pathValue = String(cookie.path || "/").trim() || "/";
  const expires = Number(cookie.expires);

  if (!name || !domain) {
    return null;
  }

  return {
    name,
    value: String(cookie.value || ""),
    domain,
    path: pathValue.startsWith("/") ? pathValue : `/${pathValue}`,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || null,
    expires: Number.isFinite(expires) ? expires : -1,
  };
}

function dedupeRemoteBrowserCookies(cookies = []) {
  const uniqueCookies = new Map();

  for (const cookie of cookies) {
    const key = [cookie.domain, cookie.path, cookie.name].join("\t");
    uniqueCookies.set(key, cookie);
  }

  return [...uniqueCookies.values()];
}

function isExpiredRemoteBrowserCookie(cookie = {}) {
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

function setRemoteBrowserCookies(cookies = [], source = null) {
  const normalizedCookies = dedupeRemoteBrowserCookies(
    cookies
      .map((cookie) => normalizeRemoteBrowserCookie(cookie))
      .filter(Boolean)
      .filter((cookie) => !isExpiredRemoteBrowserCookie(cookie))
      .filter((cookie) => isAllowedRemoteBrowserCookieDomain(cookie.domain))
  );

  remoteBrowserCookieState.cookies = normalizedCookies;
  remoteBrowserCookieState.cookieCount = normalizedCookies.length;
  remoteBrowserCookieState.source = source;
}

function summarizeDomainCookies(domain = "") {
  const normalizedDomain = normalizeCookieDomain(domain);
  const cookies = remoteBrowserCookieState.cookies.filter(
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

  return {
    store: {
      count: storeSummary.count,
      hasSessionId: storeCookieNames.has("sessionid"),
      hasSteamLoginSecure: storeCookieNames.has("steamLoginSecure"),
      hasBirthtime: storeCookieNames.has("birthtime"),
      hasLastAgeCheckAge: storeCookieNames.has("lastagecheckage"),
      hasMatureContentPrefs:
        storeCookieNames.has("wants_mature_content") ||
        storeCookieNames.has("wants_mature_content_sex") ||
        storeCookieNames.has("wants_mature_content_violence"),
    },
    community: {
      count: communitySummary.count,
      hasSessionId: new Set(communitySummary.names).has("sessionid"),
      hasSteamLoginSecure: new Set(communitySummary.names).has(
        "steamLoginSecure"
      ),
    },
  };
}

function getRemoteBrowserCookieStatus() {
  return {
    enabled: REMOTE_BROWSER_ENABLED,
    configured: isRemoteBrowserSyncConfigured(),
    cdpHttpUrl: REMOTE_BROWSER_CDP_HTTP_URL || null,
    cdpWsUrlConfigured: Boolean(REMOTE_BROWSER_CDP_WS_URL),
    syncIntervalMs: REMOTE_BROWSER_SYNC_INTERVAL_MS,
    cookieDomains: REMOTE_BROWSER_COOKIE_DOMAINS,
    cookieStorePath: REMOTE_BROWSER_COOKIE_STORE_PATH,
    source: remoteBrowserCookieState.source,
    cookieCount: remoteBrowserCookieState.cookieCount,
    hasCookies: remoteBrowserCookieState.cookieCount > 0,
    lastSyncAt: remoteBrowserCookieState.lastSyncAt,
    lastSyncOkAt: remoteBrowserCookieState.lastSyncOkAt,
    lastError: remoteBrowserCookieState.lastError,
    lastErrorAt: remoteBrowserCookieState.lastErrorAt,
    syncInProgress: remoteBrowserCookieState.syncInProgress,
    diagnostics: getStoredCookieDiagnostics(),
  };
}

function getRemoteBrowserCookieHealthSummary() {
  return {
    enabled: REMOTE_BROWSER_ENABLED,
    configured: isRemoteBrowserSyncConfigured(),
    cookieCount: remoteBrowserCookieState.cookieCount,
    hasCookies: remoteBrowserCookieState.cookieCount > 0,
    source: remoteBrowserCookieState.source,
    lastSyncOkAt: remoteBrowserCookieState.lastSyncOkAt,
    lastError: remoteBrowserCookieState.lastError,
    syncInProgress: remoteBrowserCookieState.syncInProgress,
  };
}

async function loadPersistedRemoteBrowserCookies() {
  try {
    const raw = await fs.readFile(REMOTE_BROWSER_COOKIE_STORE_PATH, "utf8");
    const payload = safeParseJson(raw);
    const cookies = Array.isArray(payload?.cookies) ? payload.cookies : [];

    setRemoteBrowserCookies(cookies, "persisted_file");

    if (payload?.updatedAt) {
      remoteBrowserCookieState.lastSyncAt = payload.updatedAt;
      remoteBrowserCookieState.lastSyncOkAt = payload.updatedAt;
    }
  } catch (err) {
    if (err?.code === "ENOENT") {
      return;
    }

    remoteBrowserCookieState.lastError = `读取持久化 Cookie 失败: ${err.message}`;
    remoteBrowserCookieState.lastErrorAt = new Date().toISOString();
  }
}

async function persistRemoteBrowserCookies(cookies = []) {
  await fs.mkdir(path.dirname(REMOTE_BROWSER_COOKIE_STORE_PATH), {
    recursive: true,
  });

  await fs.writeFile(
    REMOTE_BROWSER_COOKIE_STORE_PATH,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        cookieDomains: REMOTE_BROWSER_COOKIE_DOMAINS,
        cookies,
      },
      null,
      2
    ),
    "utf8"
  );
}

async function fetchRemoteBrowserJson(pathname) {
  if (!REMOTE_BROWSER_CDP_HTTP_URL) {
    throw new Error("未配置 REMOTE_BROWSER_CDP_HTTP_URL");
  }

  const response = await requestWithRetry(axios, {
    method: "GET",
    url: `${REMOTE_BROWSER_CDP_HTTP_URL}${pathname}`,
    timeout: REMOTE_BROWSER_CDP_TIMEOUT_MS,
    headers: {
      ...buildRequestHeaders("english"),
      Accept: "application/json",
    },
  });

  if (response.status >= 400) {
    throw new Error(`读取远程浏览器调试信息失败: HTTP ${response.status}`);
  }

  const payload = safeParseJson(response.data);

  if (!payload) {
    throw new Error(`远程浏览器返回了无效 JSON: ${pathname}`);
  }

  return payload;
}

async function resolveRemoteBrowserCdpWsUrl() {
  if (REMOTE_BROWSER_CDP_WS_URL) {
    return REMOTE_BROWSER_CDP_WS_URL;
  }

  if (!REMOTE_BROWSER_CDP_HTTP_URL) {
    throw new Error(
      "未配置 REMOTE_BROWSER_CDP_HTTP_URL 或 REMOTE_BROWSER_CDP_WS_URL"
    );
  }

  const payload = await fetchRemoteBrowserJson("/json/version");
  const wsUrl = String(payload?.webSocketDebuggerUrl || "").trim();

  if (!wsUrl) {
    throw new Error("远程浏览器未暴露 webSocketDebuggerUrl");
  }

  return wsUrl;
}

async function callCdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextCdpMessageId++;
    if (nextCdpMessageId > 1000000) {
      nextCdpMessageId = 1;
    }
    const socket = new WebSocket(wsUrl, {
      handshakeTimeout: REMOTE_BROWSER_CDP_TIMEOUT_MS,
    });
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }

      if (err) {
        reject(err);
        return;
      }

      resolve(result);
    };

    const timeout = setTimeout(() => {
      socket.terminate();
      finish(new Error(`CDP 请求超时: ${method}`));
    }, REMOTE_BROWSER_CDP_TIMEOUT_MS);

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
        })
      );
    });

    socket.on("message", (data) => {
      let message = null;

      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (message?.id !== id) {
        return;
      }

      if (message.error) {
        finish(new Error(message.error.message || `CDP 调用失败: ${method}`));
        return;
      }

      finish(null, message.result || {});
    });

    socket.on("error", (err) => {
      finish(err);
    });

    socket.on("close", (code) => {
      if (!settled) {
        finish(new Error(`CDP 连接已关闭: ${code}`));
      }
    });
  });
}

function pickRemoteBrowserPageTarget(targets = []) {
  const candidates = targets
    .filter((target) => target?.type === "page")
    .filter((target) => String(target?.webSocketDebuggerUrl || "").trim());

  if (!candidates.length) {
    return null;
  }

  const preferredTarget = candidates.find((target) => {
    const targetUrl = String(target?.url || "").trim();

    return REMOTE_BROWSER_COOKIE_DOMAINS.some((domain) =>
      targetUrl.includes(domain)
    );
  });

  return preferredTarget || candidates[0];
}

async function resolveRemoteBrowserPageTargetWsUrl() {
  if (!REMOTE_BROWSER_CDP_HTTP_URL) {
    return null;
  }

  const targets = await fetchRemoteBrowserJson("/json/list");
  const target = pickRemoteBrowserPageTarget(
    Array.isArray(targets) ? targets : []
  );

  return String(target?.webSocketDebuggerUrl || "").trim() || null;
}

async function fetchCookiesViaPageTarget(pageWsUrl) {
  const urls = REMOTE_BROWSER_COOKIE_DOMAINS.map(
    (domain) => `https://${domain}/`
  );
  const methods = [
    {
      name: "Network.getCookies(page_target)",
      execute: () => callCdp(pageWsUrl, "Network.getCookies", { urls }),
    },
    {
      name: "Storage.getCookies(page_target)",
      execute: () => callCdp(pageWsUrl, "Storage.getCookies", {}),
    },
  ];
  const errors = [];

  for (const method of methods) {
    try {
      const result = await method.execute();
      const cookies = Array.isArray(result?.cookies) ? result.cookies : [];

      return dedupeRemoteBrowserCookies(
        cookies
          .map((cookie) => normalizeRemoteBrowserCookie(cookie))
          .filter(Boolean)
          .filter((cookie) => !isExpiredRemoteBrowserCookie(cookie))
          .filter((cookie) => isAllowedRemoteBrowserCookieDomain(cookie.domain))
      );
    } catch (err) {
      errors.push(`${method.name}: ${err.message}`);
    }
  }

  throw new Error(errors.join("；"));
}

async function fetchRemoteBrowserCookiesFromCdp() {
  const errors = [];

  try {
    const pageWsUrl = await resolveRemoteBrowserPageTargetWsUrl();

    if (pageWsUrl) {
      return await fetchCookiesViaPageTarget(pageWsUrl);
    }
  } catch (err) {
    errors.push(`page_target: ${err.message}`);
  }

  try {
    const wsUrl = await resolveRemoteBrowserCdpWsUrl();
    const methods = ["Storage.getCookies", "Network.getAllCookies"];

    for (const method of methods) {
      try {
        const result = await callCdp(wsUrl, method, {});
        const cookies = Array.isArray(result?.cookies) ? result.cookies : [];

        return dedupeRemoteBrowserCookies(
          cookies
            .map((cookie) => normalizeRemoteBrowserCookie(cookie))
            .filter(Boolean)
            .filter((cookie) => !isExpiredRemoteBrowserCookie(cookie))
            .filter((cookie) => isAllowedRemoteBrowserCookieDomain(cookie.domain))
        );
      } catch (err) {
        errors.push(`${method}: ${err.message}`);
      }
    }
  } catch (err) {
    errors.push(`browser_target: ${err.message}`);
  }

  throw new Error(
    `读取远程浏览器 Cookie 失败。${errors.join("；") || "未拿到任何 Cookie"}`
  );
}

async function syncRemoteBrowserCookies() {
  if (remoteBrowserSyncPromise) {
    return remoteBrowserSyncPromise;
  }

  remoteBrowserSyncPromise = (async () => {
    if (!isRemoteBrowserSyncConfigured()) {
      throw new Error(
        "未配置远程浏览器调试地址，请设置 REMOTE_BROWSER_CDP_HTTP_URL 或 REMOTE_BROWSER_CDP_WS_URL"
      );
    }

    remoteBrowserCookieState.syncInProgress = true;
    remoteBrowserCookieState.lastSyncAt = new Date().toISOString();

    const cookies = await fetchRemoteBrowserCookiesFromCdp();
    setRemoteBrowserCookies(cookies, "remote_browser_cdp");
    remoteBrowserCookieState.lastSyncOkAt = new Date().toISOString();
    remoteBrowserCookieState.lastError = null;
    remoteBrowserCookieState.lastErrorAt = null;

    try {
      await persistRemoteBrowserCookies(remoteBrowserCookieState.cookies);
    } catch (err) {
      remoteBrowserCookieState.lastError = `Cookie 已同步，但写入持久化文件失败: ${err.message}`;
      remoteBrowserCookieState.lastErrorAt = new Date().toISOString();
    }

    return {
      cookieCount: remoteBrowserCookieState.cookieCount,
      syncedAt: remoteBrowserCookieState.lastSyncOkAt,
    };
  })();

  try {
    return await remoteBrowserSyncPromise;
  } catch (err) {
    remoteBrowserCookieState.lastError = err.message;
    remoteBrowserCookieState.lastErrorAt = new Date().toISOString();
    throw err;
  } finally {
    remoteBrowserCookieState.syncInProgress = false;
    remoteBrowserSyncPromise = null;
  }
}

async function initializeRemoteBrowserCookieSync() {
  await loadPersistedRemoteBrowserCookies();

  if (!isRemoteBrowserSyncConfigured()) {
    if (REMOTE_BROWSER_ENABLED) {
      remoteBrowserCookieState.lastError =
        "远程浏览器自动同步已开启，但未配置调试地址";
      remoteBrowserCookieState.lastErrorAt = new Date().toISOString();
    }
    return;
  }

  if (!REMOTE_BROWSER_ENABLED) {
    return;
  }

  try {
    await syncRemoteBrowserCookies();
  } catch (err) {
    console.error(`[remote-browser] 初次同步失败: ${err.message}`);
  }

  remoteBrowserSyncTimer = setInterval(() => {
    syncRemoteBrowserCookies().catch((err) => {
      console.error(`[remote-browser] 定时同步失败: ${err.message}`);
    });
  }, REMOTE_BROWSER_SYNC_INTERVAL_MS);

  if (typeof remoteBrowserSyncTimer.unref === "function") {
    remoteBrowserSyncTimer.unref();
  }
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
  return (
    url.includes("/agecheck/") ||
    /Please enter your birth date to continue/i.test(html) ||
    /By clicking the .?View Page.? button below you affirm that you are at least eighteen years old/i.test(
      html
    ) ||
    /This game may contain content not appropriate for all ages/i.test(html)
  );
}

function looksLikeLoginOrPreferenceRestricted(html = "") {
  const normalizedHtml = String(html || "");

  if (
    /sign in|login/i.test(normalizedHtml) &&
    /(mature content|store preferences|age assurance|view page|adult|sexual content)/i.test(
      normalizedHtml
    )
  ) {
    return true;
  }

  if (
    /登录|登入|偏好设置|商店偏好|成人内容|成人视频|仅限成年人|查看页面|年龄验证|内容警告/i.test(
      normalizedHtml
    )
  ) {
    return true;
  }

  const $ = cheerio.load(normalizedHtml);

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

function buildLoginRestrictionMessage() {
  const diagnostics = getStoredCookieDiagnostics();

  if (
    remoteBrowserCookieState.cookieCount > 0 &&
    diagnostics.community.hasSteamLoginSecure &&
    !diagnostics.store.hasSteamLoginSecure
  ) {
    return "当前已同步到 Steam Community 登录态，但看起来还没有 Store 侧登录态。请在远程浏览器里打开 https://store.steampowered.com/ 并确认右上角显示你的账号已登录，然后重新同步 Cookie。";
  }

  if (
    remoteBrowserCookieState.cookieCount > 0 &&
    diagnostics.store.hasSteamLoginSecure &&
    !diagnostics.store.hasMatureContentPrefs
  ) {
    return "当前已同步到 Steam Store 登录态，但缺少商店成人内容偏好 Cookie。请在远程浏览器里打开 Steam 商店偏好设置，勾选成人/仅限成年人内容后重新同步 Cookie。";
  }

  return "这个页面大概率需要登录后的 Steam 账号权限、成熟内容偏好设置，或受地区限制。请传入你自己的 Steam Cookie，或开启远程浏览器 Cookie 同步。";
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
        ($selected.attr("value") ||
          $selected.text() ||
          $first.attr("value") ||
          $first.text() ||
          "")
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
  const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(
    appid
  )}&l=${encodeURIComponent(lang)}`;

  const response = await requestWithRetry(client, {
    method: "GET",
    url,
    headers: buildRequestHeaders(lang),
  });

  const payload = safeParseJson(response.data);
  const entry = payload?.[String(appid)];

  if (!entry?.success || !entry.data) {
    return null;
  }

  return entry.data;
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

    // 再抓一次真正的 app 页面
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

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "steam-tags-api",
    remoteBrowserCookieSync: getRemoteBrowserCookieHealthSummary(),
  });
});

app.get("/api/steam-cookies/status", (_req, res) => {
  res.json({
    success: true,
    data: getRemoteBrowserCookieStatus(),
  });
});

app.post("/api/steam-cookies/sync", async (_req, res) => {
  if (!isRemoteBrowserSyncConfigured()) {
    return res.status(400).json({
      success: false,
      error: "REMOTE_BROWSER_NOT_CONFIGURED",
      message:
        "请先配置 REMOTE_BROWSER_CDP_HTTP_URL 或 REMOTE_BROWSER_CDP_WS_URL",
    });
  }

  try {
    const result = await syncRemoteBrowserCookies();

    return res.json({
      success: true,
      data: {
        ...getRemoteBrowserCookieStatus(),
        syncedAt: result.syncedAt,
      },
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: "REMOTE_BROWSER_SYNC_FAILED",
      message: err.message || "远程浏览器 Cookie 同步失败",
    });
  }
});

app.get("/api/app/:appid/tags", async (req, res) => {
  const { appid } = req.params;
  const lang = String(req.query.lang || DEFAULT_LANG).trim();
  const requestCookie = req.header("x-steam-cookie") || "";

  if (!/^\d+$/.test(appid)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_APPID",
      message: "appid 必须是纯数字",
    });
  }

  try {
    const requestHasExplicitCookie = Boolean(requestCookie);
    const anonymousResult = await fetchSteamTags(appid, lang, requestCookie, {
      useStoredAuthCookies: false,
    });
    let result = anonymousResult;

    const shouldRetryWithStoredAuth =
      !requestHasExplicitCookie &&
      hasStoredAuthCookies() &&
      (anonymousResult.tags.length === 0 ||
        anonymousResult.developers.length === 0 ||
        looksLikeLoginOrPreferenceRestricted(anonymousResult.rawHtml));

    if (shouldRetryWithStoredAuth) {
      const authenticatedResult = await fetchSteamTags(appid, lang, "", {
        useStoredAuthCookies: true,
      });

      if (
        scoreSteamResult(authenticatedResult) > scoreSteamResult(anonymousResult) ||
        (looksLikeLoginOrPreferenceRestricted(anonymousResult.rawHtml) &&
          !looksLikeLoginOrPreferenceRestricted(authenticatedResult.rawHtml))
      ) {
        result = authenticatedResult;
      }
    }

    // 明确判断：依然是年龄门
    if (isAgeGate(result.rawHtml, result.finalUrl)) {
      return res.status(403).json({
        success: false,
        error: "AGE_GATE_BLOCKED",
        message: "页面仍然停留在年龄验证，当前无法继续获取标签",
      });
    }

    // 可能是登录态 / 成熟内容偏好 / 地区限制
    if (result.tags.length === 0 && looksLikeLoginOrPreferenceRestricted(result.rawHtml)) {
      return res.status(403).json({
        success: false,
        error: "LOGIN_OR_PREFERENCE_REQUIRED",
        message: buildLoginRestrictionMessage(),
      });
    }

    return res.json({
      success: true,
      data: {
        appid: result.appid,
        name: result.name,
        aliases: result.aliases,
        releaseDate: result.releaseDate,
        tags: result.tags,
        developers: result.developers,
      },
      warning:
        result.tags.length === 0
          ? "未提取到标签。可能是页面结构变动，或该页面仍受登录态/偏好/地区限制。"
          : null,
    });
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

async function startServer() {
  await initializeRemoteBrowserCookieSync();

  app.listen(PORT, () => {
    console.log(`Steam tags API listening on http://127.0.0.1:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});
