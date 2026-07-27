const PLATFORM_LOGIN_CONFIG = {
  cn: {
    bambuOrigin: "https://bambulab.cn",
    makerWorldOrigin: "https://makerworld.com.cn",
  },
  global: {
    bambuOrigin: "https://bambulab.com",
    makerWorldOrigin: "https://makerworld.com",
  },
};

export function normalizePlatform(platform) {
  return String(platform || "").trim().toLowerCase() === "global" ? "global" : "cn";
}

function hostnameMatchesCookieDomain(hostname, domain) {
  const cleanHostname = String(hostname || "").trim().toLowerCase();
  const cleanDomain = String(domain || "").trim().toLowerCase().replace(/^\.+/, "");
  return Boolean(cleanHostname && cleanDomain) && (
    cleanHostname === cleanDomain || cleanHostname.endsWith(`.${cleanDomain}`)
  );
}

function isAuthTokenCookie(cookie) {
  return ["token", "access_token", "accesstoken"].includes(
    String(cookie?.name || "").trim().toLowerCase(),
  );
}

export function browserAuthTokenForUrl(cookies, targetUrl) {
  let hostname = "";
  try {
    hostname = new URL(String(targetUrl || "")).hostname;
  } catch {
    return "";
  }
  const match = (Array.isArray(cookies) ? cookies : []).find((cookie) => (
    isAuthTokenCookie(cookie)
    && String(cookie?.value || "").trim()
    && hostnameMatchesCookieDomain(hostname, cookie?.domain)
  ));
  return String(match?.value || "").trim();
}

export function hasMakerWorldSessionCookie(cookies, platform) {
  const makerWorldHost = new URL(
    PLATFORM_LOGIN_CONFIG[normalizePlatform(platform)].makerWorldOrigin,
  ).hostname;
  return (Array.isArray(cookies) ? cookies : []).some((cookie) => (
    isAuthTokenCookie(cookie)
    && String(cookie?.value || "").trim()
    && hostnameMatchesCookieDomain(makerWorldHost, cookie?.domain)
  ));
}

export function makerWorldHomeUrl(platform) {
  return `${PLATFORM_LOGIN_CONFIG[normalizePlatform(platform)].makerWorldOrigin}/zh`;
}

export function isMakerWorldUrl(value, platform) {
  const config = PLATFORM_LOGIN_CONFIG[normalizePlatform(platform)];
  try {
    return new URL(String(value || "")).origin === config.makerWorldOrigin;
  } catch {
    return false;
  }
}

export function isBambuLoginConfirmationUrl(value, platform) {
  const config = PLATFORM_LOGIN_CONFIG[normalizePlatform(platform)];
  try {
    const parsed = new URL(String(value || ""));
    const target = new URL(parsed.searchParams.get("to") || "");
    return parsed.origin === config.bambuOrigin
      && /\/sign-in\/?$/i.test(parsed.pathname)
      && parsed.searchParams.get("ticket") === "1"
      && target.origin === config.makerWorldOrigin
      && target.pathname.replace(/\/$/, "") === "/api/sign-in/ticket";
  } catch {
    return false;
  }
}

export async function completeBambuLoginConfirmation(context, page, platform, timeoutMs = 30000) {
  if (!isBambuLoginConfirmationUrl(page.url(), platform)) return false;
  const timeout = Math.max(Math.min(Number(timeoutMs || 30000), 120000), 1000);
  const deadline = Date.now() + timeout;
  const actionDeadline = Math.min(deadline, Date.now() + 10000);
  let clicked = false;
  while (Date.now() < actionDeadline) {
    let actionState = "loading";
    try {
      actionState = await page.evaluate(() => {
        const visibleActions = [...document.querySelectorAll("button, a, [role='button']")].filter((element) => {
          const style = window.getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && bounds.width > 0
            && bounds.height > 0
            && !element.hasAttribute("disabled");
        });
        const actionText = (element) => String(element.innerText || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const signedIn = visibleActions.some((element) => (
          /^(?:登出|退出登录|sign out|log out)$/i.test(actionText(element))
        ));
        const continueAction = visibleActions.find((element) => (
          /^(?:继续|continue)$/i.test(actionText(element))
        ));
        if (signedIn && continueAction) {
          continueAction.click();
          return "clicked";
        }
        const loginInput = document.querySelector(
          "input:not([type]), input[type='text'], input[type='password'], input[type='email'], input[type='tel']",
        );
        if (loginInput) {
          return "signed_out";
        }
        return "loading";
      });
    } catch {
      actionState = "loading";
    }
    if (actionState === "clicked" || actionState === true) {
      clicked = true;
      break;
    }
    if (actionState === "signed_out") return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!clicked) return false;

  while (Date.now() < deadline) {
    try {
      const cookies = await context.cookies();
      if (isMakerWorldUrl(page.url(), platform) && hasMakerWorldSessionCookie(cookies, platform)) {
        return true;
      }
    } catch {
      // The page can briefly detach while the SSO redirect replaces the document.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
