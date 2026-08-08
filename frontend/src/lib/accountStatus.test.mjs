import assert from "node:assert/strict";
import { test } from "node:test";

import { accountOperationalView } from "./accountStatus.js";

test("cookie invalid remains a relogin state after source sync succeeds", () => {
  const view = accountOperationalView({
    state: "cookie_invalid",
    label: "需要重新登录",
    tone: "danger",
    message: "国内站 3MF 下载需要重新登录。",
    action: "login",
  });

  assert.deepEqual(view, {
    label: "需要重新登录",
    statusClass: "is-expired",
    message: "国内站 3MF 下载需要重新登录。",
    action: "login",
  });
});

test("archive-ready account remains a neutral operational state", () => {
  assert.deepEqual(accountOperationalView({
    label: "可归档",
    tone: "ok",
    message: "国际站 3MF 下载可用。",
    action: "none",
  }), {
    label: "可归档",
    statusClass: "",
    message: "国际站 3MF 下载可用。",
    action: "none",
  });
});

test("linked browser login requirement overrides stale archive-ready health", () => {
  assert.deepEqual(accountOperationalView({
    state: "ok",
    label: "可归档",
    tone: "ok",
    message: "国际站 3MF 下载可用。",
    action: "none",
  }, {
    browser_profile_id: "profile-global",
    browser_status: "action_required",
    browser_message: "请先在关联的指纹浏览器中完成 MakerWorld 登录。",
  }), {
    label: "需要重新登录",
    statusClass: "is-expired",
    message: "请先在关联的指纹浏览器中完成 MakerWorld 登录。",
    action: "browser",
  });
});

test("browser service failure does not masquerade as a login requirement", () => {
  assert.deepEqual(accountOperationalView({
    state: "ok",
    label: "可归档",
    tone: "ok",
    message: "国内站 3MF 下载可用。",
    action: "none",
  }, {
    browser_profile_id: "profile-cn",
    browser_status: "action_required",
    browser_message: "无法读取指纹浏览器登录态：Network.enable timed out.",
  }), {
    label: "需要浏览器确认",
    statusClass: "is-expired",
    message: "无法读取指纹浏览器登录态：Network.enable timed out.",
    action: "browser",
  });
});
