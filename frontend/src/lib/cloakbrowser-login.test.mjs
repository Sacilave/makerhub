import assert from "node:assert/strict";
import test from "node:test";


const loginHelpers = await import("../../../app/services/cloakbrowser_login.mjs").catch(() => ({}));

function requireHelper(name) {
  assert.equal(typeof loginHelpers[name], "function", `${name} must be exported`);
  return loginHelpers[name];
}

test("MakerWorld session requires a non-empty MakerWorld token", () => {
  const hasMakerWorldSessionCookie = requireHelper("hasMakerWorldSessionCookie");
  const cookies = [
    { name: "token", value: "bambu-token", domain: "bambulab.cn" },
    { name: "token", value: "", domain: ".makerworld.com.cn" },
  ];

  assert.equal(hasMakerWorldSessionCookie(cookies, "cn"), false);
  assert.equal(
    hasMakerWorldSessionCookie(
      [...cookies, { name: "token", value: "makerworld-token", domain: ".makerworld.com.cn" }],
      "cn",
    ),
    true,
  );
});

test("browser auth selects the token matching the requested platform host", () => {
  const browserAuthTokenForUrl = requireHelper("browserAuthTokenForUrl");
  const cookies = [
    { name: "token", value: "bambu-token", domain: "bambulab.cn" },
    { name: "token", value: "", domain: ".makerworld.com.cn" },
  ];

  assert.equal(
    browserAuthTokenForUrl(cookies, "https://api.bambulab.cn/v1/user-service/user/ticket"),
    "bambu-token",
  );
  assert.equal(
    browserAuthTokenForUrl(cookies, "https://makerworld.com.cn/api/models"),
    "",
  );
});

test("authenticated Bambu confirmation automatically continues to MakerWorld", async () => {
  const completeBambuLoginConfirmation = requireHelper("completeBambuLoginConfirmation");
  let clicked = false;
  const page = {
    url: () => clicked
      ? "https://makerworld.com.cn/zh"
      : "https://bambulab.cn/zh-cn/sign-in?ticket=1&to=https%3A%2F%2Fmakerworld.com.cn%2Fapi%2Fsign-in%2Fticket",
    evaluate: async () => {
      clicked = true;
      return true;
    },
  };
  const context = {
    cookies: async () => clicked
      ? [{ name: "token", value: "makerworld-token", domain: ".makerworld.com.cn" }]
      : [],
  };

  assert.equal(await completeBambuLoginConfirmation(context, page, "cn", 25), true);
  assert.equal(clicked, true);
});

test("Bambu confirmation waits for asynchronously rendered actions", async () => {
  const completeBambuLoginConfirmation = requireHelper("completeBambuLoginConfirmation");
  let checks = 0;
  let clicked = false;
  const page = {
    url: () => clicked
      ? "https://makerworld.com.cn/zh"
      : "https://bambulab.cn/zh-cn/sign-in?ticket=1&to=https%3A%2F%2Fmakerworld.com.cn%2Fapi%2Fsign-in%2Fticket",
    evaluate: async () => {
      checks += 1;
      if (checks === 1) return "loading";
      clicked = true;
      return "clicked";
    },
  };
  const context = {
    cookies: async () => clicked
      ? [{ name: "token", value: "makerworld-token", domain: ".makerworld.com.cn" }]
      : [],
  };

  assert.equal(await completeBambuLoginConfirmation(context, page, "cn", 1000), true);
  assert.equal(checks, 2);
});

test("ordinary sign-in form is not submitted as a confirmation", async () => {
  const completeBambuLoginConfirmation = requireHelper("completeBambuLoginConfirmation");
  const page = {
    url: () => "https://bambulab.cn/zh-cn/sign-in?ticket=1&to=https%3A%2F%2Fmakerworld.com.cn%2Fapi%2Fsign-in%2Fticket",
    evaluate: async () => "signed_out",
  };
  const context = { cookies: async () => [] };

  assert.equal(await completeBambuLoginConfirmation(context, page, "cn", 25), false);
});
