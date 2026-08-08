export function accountOperationalView(operational = {}, account = {}) {
  const browserProfileId = String(account?.browser_profile_id || "").trim();
  const browserStatus = String(account?.browser_status || "").trim();
  const browserMessage = String(account?.browser_message || "").trim();
  if (browserProfileId && browserStatus === "action_required") {
    const loginRequired = /(?:尚未登录|未登录|重新登录|完成[^。；]{0,24}登录|(?:log|sign)\s*in)/i.test(browserMessage);
    return {
      label: loginRequired ? "需要重新登录" : "需要浏览器确认",
      statusClass: "is-expired",
      message: browserMessage || "请在关联的指纹浏览器中完成确认。",
      action: "browser",
    };
  }
  const tone = String(operational?.tone || "neutral").trim();
  return {
    label: String(operational?.label || "状态待确认").trim(),
    statusClass: tone === "danger" ? "is-expired" : tone === "warning" ? "is-warning" : "",
    message: String(operational?.message || "账号下载状态待确认，请测试。").trim(),
    action: String(operational?.action || "test").trim(),
  };
}
