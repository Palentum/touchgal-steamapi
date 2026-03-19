const express = require("express");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const cheerio = require("cheerio");

const app = express();

const PORT = Number(process.env.PORT || 8765);
const DEFAULT_LANG = process.env.DEFAULT_LANG || "schinese";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 800);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        timeout: REQUEST_TIMEOUT_MS,
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

async function seedJar(jar, rawCookieHeader = "") {
  const baseUrl = "https://store.steampowered.com/";

  // 全局登录态
  for (const pair of splitCookieHeader(GLOBAL_STEAM_COOKIE)) {
    await jar.setCookie(pair, baseUrl);
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
  return (
    /sign in/i.test(html) &&
    /(mature content|store preferences|age assurance|view page|adult|sexual content)/i.test(
      html
    )
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

async function fetchSteamTags(appid, lang, rawCookieHeader = "") {
  const jar = new CookieJar();
  await seedJar(jar, rawCookieHeader);

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

  const usedAuthenticatedCookie = Boolean(rawCookieHeader || GLOBAL_STEAM_COOKIE);

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
  });
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
    const result = await fetchSteamTags(appid, lang, requestCookie);

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
        message:
          "这个页面大概率需要登录后的 Steam 账号权限、成熟内容偏好设置，或受地区限制。请传入你自己的 Steam Cookie。",
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

app.listen(PORT, () => {
  console.log(`Steam tags API listening on http://127.0.0.1:${PORT}`);
});
