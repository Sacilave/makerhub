const STATUS_LABELS = {
  synced: "浏览器已同步",
  syncing: "浏览器同步中",
  launching: "浏览器启动中",
  waiting: "等待浏览器登录",
  action_required: "需要浏览器确认",
  not_linked: "未关联浏览器",
  account_mismatch: "等待浏览器同步",
  not_configured: "浏览器未配置",
};

export function browserSessionStatusLabel(item = {}) {
  const status = String(item?.browser_status || "").trim();
  return STATUS_LABELS[status] || "浏览器未关联";
}

export function browserSessionStatusClass(item = {}) {
  const status = String(item?.browser_status || "").trim();
  if (status === "synced") return "";
  if (["action_required", "account_mismatch"].includes(status)) return "is-expired";
  return "is-warning";
}

export function browserSessionMessage(item = {}) {
  const message = String(item?.browser_message || "").trim();
  if (message) return message;
  return "关联后，以指纹浏览器中的登录态为准。";
}

export function browserSessionBusy(item = {}) {
  return ["syncing", "launching"].includes(String(item?.browser_status || "").trim());
}

export function shouldShowBrowserSession(item = {}, operational = {}) {
  const action = String(operational?.action || "").trim();
  const status = String(item?.browser_status || "").trim();
  return Boolean(String(item?.browser_profile_id || "").trim())
    || action === "browser"
    || ["not_linked", "syncing", "launching", "waiting", "action_required", "account_mismatch"].includes(status);
}

export function resolveCloakBrowserPublicUrl(configuredUrl = "", locationLike = {}) {
  const cleanUrl = String(configuredUrl || "").trim();
  if (cleanUrl) return cleanUrl;
  const protocol = String(locationLike?.protocol || "http:");
  const hostname = String(locationLike?.hostname || "localhost");
  return `${protocol}//${hostname}:9050/`;
}
