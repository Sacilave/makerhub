import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  browserAuthTokenForUrl,
  completeBambuLoginConfirmation,
  hasMakerWorldSessionCookie,
  isBambuLoginConfirmationUrl,
  isMakerWorldUrl,
  makerWorldHomeUrl,
  normalizePlatform,
} from "./cloakbrowser_login.mjs";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const requireFromFrontend = createRequire(path.join(ROOT_DIR, "frontend", "node_modules", "package.json"));
const puppeteer = requireFromFrontend("puppeteer-core");

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function authHeaders(token) {
  if (!token) throw new Error("auth_token is required");
  return { Authorization: `Bearer ${token}` };
}

async function resolveWebSocketEndpoint(cdpUrl, headers) {
  const response = await fetch(`${String(cdpUrl || "").replace(/\/$/, "")}/json/version`, { headers });
  if (!response.ok) {
    throw new Error(`CDP endpoint returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.webSocketDebuggerUrl) {
    throw new Error("CDP endpoint did not return webSocketDebuggerUrl");
  }
  return payload.webSocketDebuggerUrl;
}

function cleanCookie(item) {
  if (!item || typeof item !== "object") return null;
  const name = String(item.name || "").trim();
  const value = String(item.value ?? "");
  if (!name || value === "") return null;
  const cookie = {
    name,
    value,
    path: String(item.path || "/") || "/",
    secure: item.secure !== false,
  };
  if (item.domain) cookie.domain = String(item.domain);
  else if (item.url) cookie.url = String(item.url);
  else return null;
  if (typeof item.httpOnly === "boolean") cookie.httpOnly = item.httpOnly;
  if (typeof item.expires === "number" && Number.isFinite(item.expires)) cookie.expires = item.expires;
  if (["Strict", "Lax", "None"].includes(item.sameSite)) cookie.sameSite = item.sameSite;
  return cookie;
}

async function storageSnapshot(page) {
  const url = page.url();
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return await page.evaluate(() => {
      const select = (storage) => {
        const result = {};
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (!key || !/token|auth|session/i.test(key)) continue;
          const value = storage.getItem(key);
          if (typeof value === "string" && value.length <= 16384) result[key] = value;
        }
        return result;
      };
      return {
        origin: window.location.origin,
        local: select(window.localStorage),
        session: select(window.sessionStorage),
      };
    });
  } catch {
    return null;
  }
}

function isMakerWorldModelUrl(value, platform) {
  try {
    const parsed = new URL(String(value || ""));
    const hostname = parsed.hostname.toLowerCase();
    const domain = platform === "global" ? "makerworld.com" : "makerworld.com.cn";
    return parsed.protocol === "https:"
      && (hostname === domain || hostname.endsWith(`.${domain}`))
      && /\/models\/\d+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function platformDomains(platform) {
  return platform === "global"
    ? ["makerworld.com", "bambulab.com"]
    : ["makerworld.com.cn", "bambulab.cn"];
}

function hostnameMatchesDomains(hostname, domains) {
  const cleanHostname = String(hostname || "").trim().toLowerCase().replace(/^\.+/, "");
  return domains.some((domain) => cleanHostname === domain || cleanHostname.endsWith(`.${domain}`));
}

function isAllowedBrowserFetchUrl(value, platform) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && (!parsed.port || parsed.port === "443")
      && hostnameMatchesDomains(parsed.hostname, platformDomains(platform));
  } catch {
    return false;
  }
}

const ALLOWED_FETCH_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "origin",
  "referer",
  "token",
  "x-access-token",
  "x-app-name",
  "x-app-version",
  "x-bbl-app-source",
  "x-bbl-client-type",
  "x-bbl-client-name",
  "x-bbl-client-version",
  "x-bbl-captcha-result",
  "x-token",
]);

function cleanFetchHeaders(headers) {
  const source = headers && typeof headers === "object" ? headers : {};
  const result = {};
  for (const [name, value] of Object.entries(source)) {
    const cleanName = String(name || "").trim();
    if (!cleanName || !ALLOWED_FETCH_HEADERS.has(cleanName.toLowerCase()) || value == null) continue;
    result[cleanName.toLowerCase()] = String(value);
  }
  return result;
}

function headerExists(headers, targetName) {
  const normalizedTarget = String(targetName || "").toLowerCase();
  return Object.keys(headers).some((name) => name.toLowerCase() === normalizedTarget);
}

function isControlApiUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.hostname.toLowerCase().startsWith("api.bambulab.")
      || parsed.pathname.startsWith("/api/")
      || parsed.pathname.startsWith("/v1/");
  } catch {
    return false;
  }
}

function headersWithBrowserAuth(headers, cookies, targetUrl) {
  const result = { ...headers };
  if (!isControlApiUrl(targetUrl)) return result;
  const token = browserAuthTokenForUrl(cookies, targetUrl);
  if (!token) return result;
  if (!headerExists(result, "authorization")) result.authorization = `Bearer ${token}`;
  if (!headerExists(result, "token")) result.token = token;
  if (!headerExists(result, "x-token")) result["x-token"] = token;
  if (!headerExists(result, "x-access-token")) result["x-access-token"] = token;
  return result;
}

async function fetchBrowserResponse(context, platform, targetUrl, headers, cookies, timeoutMs) {
  if (!isAllowedBrowserFetchUrl(targetUrl, platform)) throw new Error("invalid browser fetch URL");
  const cleanCookies = (Array.isArray(cookies) ? cookies : []).map(cleanCookie).filter(Boolean);
  if (cleanCookies.length) await context.setCookie(...cleanCookies);
  const page = await context.newPage();
  try {
    const profileCookies = (await context.cookies()).filter((item) => (
      hostnameMatchesDomains(String(item?.domain || ""), platformDomains(platform))
    ));
    const cleanHeaders = headersWithBrowserAuth(cleanFetchHeaders(headers), profileCookies, targetUrl);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (!isAllowedBrowserFetchUrl(request.url(), platform)) {
        void request.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      void request.continue({
        headers: { ...request.headers(), ...cleanHeaders },
      }).catch(() => undefined);
    });
    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(Number(timeoutMs || 30000), 15000),
    });
    if (!response) throw new Error("browser fetch did not return a response");
    const finalUrl = page.url();
    if (!isAllowedBrowserFetchUrl(finalUrl, platform)) throw new Error("browser fetch redirected outside allowed domains");
    const responseHeaders = response.headers();
    const safeHeaders = {};
    for (const name of ["content-type", "retry-after", "location"]) {
      if (responseHeaders[name]) safeHeaders[name] = String(responseHeaders[name]);
    }
    return {
      status_code: Number(response.status() || 0),
      url: finalUrl,
      content_type: String(responseHeaders["content-type"] || ""),
      headers: safeHeaders,
      text: await response.text(),
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function isThreeMfAuthorizationUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const allowedHosts = new Set([
      "api.bambulab.com",
      "api.bambulab.cn",
      "makerworld.com",
      "makerworld.com.cn",
    ]);
    return (
      parsed.protocol === "https:"
      && allowedHosts.has(parsed.hostname.toLowerCase())
      && /^\/(?:api\/)?v1\/design-service\/instance\/\d+\/f3mf\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function sanitizedAuthorizationPayload(payload, text) {
  const body = payload && typeof payload === "object" ? payload : {};
  const data = body.data && typeof body.data === "object"
    ? body.data
    : body.result && typeof body.result === "object"
      ? body.result
      : body;
  const name = String(data.name || data.fileName || data.filename || data.file_name || "").trim();
  const url = String(data.url || data.downloadUrl || data.download_url || data.downloadURL || "").trim();
  if (url) return { name, url };
  return {
    message: String(body.message || body.error || body.msg || text || "").slice(0, 1024),
    code: String(body.code || "").slice(0, 80),
    captchaId: String(body.captchaId || body.captcha_id || "").slice(0, 160),
  };
}

function authorizationResponseMatches(response, instanceId) {
  if (!isThreeMfAuthorizationUrl(response.url())) return false;
  const matched = response.url().match(/\/instance\/(\d+)\/f3mf/i);
  return !instanceId || matched?.[1] === String(instanceId);
}

async function findThreeMfDownloadButton(page, timeoutMs) {
  const deadline = Date.now() + Math.max(Number(timeoutMs || 30000), 15000);
  while (Date.now() < deadline) {
    // MakerWorld renders the primary 3MF action as a span, not a semantic button.
    const handles = await page.$$("button, a, [role='button'], .primaryButton");
    for (const handle of handles) {
      const matches = await handle.evaluate((element) => {
        const style = window.getComputedStyle(element);
        const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && element.getBoundingClientRect().width > 0
          && element.getBoundingClientRect().height > 0
          && !element.hasAttribute("disabled")
          && /(?:下载|download)\s*3mf/i.test(text);
      });
      if (matches) return handle;
      await handle.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("model page did not expose an enabled 3MF download action");
}

async function clickAuthorization(
  context,
  platform,
  targetUrl,
  modelUrl,
  instanceId,
  navigationTimeoutMs,
  authorizationTimeoutMs,
) {
  if (!isThreeMfAuthorizationUrl(targetUrl)) throw new Error("invalid 3MF authorization URL");
  if (!isMakerWorldModelUrl(modelUrl, platform)) throw new Error("invalid MakerWorld model page URL");
  const navigationTimeout = Math.max(Number(navigationTimeoutMs || 30000), 15000);
  const authorizationTimeout = Math.max(Number(authorizationTimeoutMs || 90000), navigationTimeout);
  const page = await context.newPage();
  try {
    let navigationTimedOut = false;
    try {
      await page.goto(modelUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeout });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      navigationTimedOut = true;
    }
    const responsePromise = page.waitForResponse(
      (response) => authorizationResponseMatches(response, instanceId),
      { timeout: authorizationTimeout },
    );
    const button = await findThreeMfDownloadButton(page, navigationTimeout);
    await button.click({ delay: 20 });
    await button.dispose();
    const response = await responsePromise;
    const text = (await response.text()).slice(0, 16384);
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {
      status_code: Number(response.status() || 0),
      payload: sanitizedAuthorizationPayload(payload, text),
      text: payload ? "" : text.slice(0, 1024),
      navigation_timed_out: navigationTimedOut,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main() {
  const input = await readInput();
  const cdpUrl = String(input.cdp_url || "").trim();
  if (!cdpUrl) throw new Error("cdp_url is required");
  const headers = authHeaders(String(input.auth_token || "").trim());
  const browserWSEndpoint = await resolveWebSocketEndpoint(cdpUrl, headers);
  const browser = await puppeteer.connect({
    browserWSEndpoint,
    headers,
    defaultViewport: null,
    protocolTimeout: Math.max(
      Number(input.navigation_timeout_ms || 30000),
      input.action === "click" ? Number(input.authorization_timeout_ms || 90000) : 15000,
    ),
  });
  let navigationError = "";
  try {
    const contexts = browser.browserContexts();
    const context = contexts[0] || browser.defaultBrowserContext();
    if (input.action === "fetch") {
      const fetched = await fetchBrowserResponse(
        context,
        String(input.platform || "cn"),
        String(input.target_url || ""),
        input.headers,
        input.cookies,
        input.navigation_timeout_ms,
      );
      process.stdout.write(JSON.stringify({ ok: true, ...fetched }));
      return;
    }
    if (input.action === "click") {
      const authorization = await clickAuthorization(
        context,
        String(input.platform || "cn"),
        String(input.target_url || ""),
        String(input.model_url || ""),
        String(input.instance_id || ""),
        input.navigation_timeout_ms,
        input.authorization_timeout_ms,
      );
      process.stdout.write(JSON.stringify({ ok: true, ...authorization }));
      return;
    }
    if (input.action === "seed") {
      const cookies = (Array.isArray(input.cookies) ? input.cookies : []).map(cleanCookie).filter(Boolean);
      if (cookies.length) await context.setCookie(...cookies);
    }
    const pages = await context.pages();
    const page = pages[0] || await context.newPage();
    const platform = normalizePlatform(input.platform);
    const isLoginAction = input.action === "login" || input.action === "sync";
    const makerWorldSessionReady = isLoginAction
      && hasMakerWorldSessionCookie(await context.cookies(), platform);
    const targetUrl = makerWorldSessionReady
      ? makerWorldHomeUrl(platform)
      : String(input.target_url || "");
    const currentUrl = page.url();
    const shouldNavigate = targetUrl && (
      input.action === "seed"
      || input.action === "login"
      || !/^https?:\/\//i.test(currentUrl)
      || (makerWorldSessionReady && !isMakerWorldUrl(currentUrl, platform))
    );
    if (shouldNavigate) {
      try {
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(Number(input.navigation_timeout_ms || 30000), 15000),
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        navigationError = error instanceof Error ? error.message : String(error || "navigation failed");
      }
    }
    if (isLoginAction && isBambuLoginConfirmationUrl(page.url(), platform)) {
      await completeBambuLoginConfirmation(
        context,
        page,
        platform,
        input.navigation_timeout_ms,
      );
    }
    const currentPages = await context.pages();
    const storage = [];
    for (const currentPage of currentPages) {
      const item = await storageSnapshot(currentPage);
      if (item) storage.push(item);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      current_url: page.url(),
      cookies: await context.cookies(),
      storage,
      navigation_error: navigationError,
    }));
  } finally {
    await browser.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error || "CDP bridge failed")) + "\n");
  process.exit(1);
});
