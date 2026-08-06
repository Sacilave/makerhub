import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  attemptAutomaticVerification,
  buildDragTrajectory,
  detectVerificationChallenge,
  runVisionRequest,
  sanitizeVerificationResult,
} from "../../../app/services/cloakbrowser_verification.mjs";
import {
  coordinateThreeMfAuthorization,
  readAuthorizationResponse,
} from "../../../app/services/cloakbrowser_bridge.mjs";


function fakeHandle({
  box = { x: 10, y: 20, width: 40, height: 40 },
  visible = true,
  value = "",
  screenshot = pngBuffer(40, 40),
  fingerprint = null,
  one = () => null,
  many = () => [],
  click = async () => {},
  backendNodeId = 1,
  evaluate,
} = {}) {
  return {
    boundingBox: async () => box,
    backendNodeId: async () => backendNodeId,
    evaluate: evaluate || (async (_callback, argument) => {
      if (argument === "read-value") return value;
      if (argument === "fingerprint") return fingerprint;
      if (argument?.action === "click") {
        if (Date.now() >= argument.deadline) return false;
        await click();
        return true;
      }
      if (argument?.action === "hide") {
        return { applied: true, id: argument.id, value: "", priority: "" };
      }
      if (argument?.action === "restore") return true;
      return visible;
    }),
    screenshot: async () => (typeof screenshot === "function" ? screenshot() : screenshot),
    $: async (selector) => one(selector),
    $$: async (selector) => many(selector),
    click,
  };
}

function pngBuffer(width, height = 40, marker = 0) {
  const buffer = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt32BE(marker, 24);
  return buffer;
}

function fakeFrame({ one = () => null, many = () => [], label = "frame" } = {}) {
  return {
    label,
    $: async (selector) => one(selector),
    $$: async (selector) => many(selector),
  };
}

function fakeChild(onInput) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const input = [];
  child.stdin.on("data", (chunk) => input.push(chunk));
  child.stdin.on("finish", () => onInput(child, Buffer.concat(input).toString("utf8")));
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  };
  return child;
}

function fakeAuthorizationResponse({
  status = 200,
  payload = { name: "part.3mf", url: "https://download.example.test/part.3mf" },
  rawText,
  textError,
  url = "https://api.bambulab.cn/v1/design-service/instance/123/f3mf",
} = {}) {
  return {
    status: () => status,
    text: async () => {
      if (textError) throw textError;
      return rawText ?? JSON.stringify(payload);
    },
    url: () => url,
  };
}

function fakeAuthorizationPage(responses, lifecycle = []) {
  const queue = [...responses];
  const forbidden = (name) => async () => {
    throw new Error(`${name} must not be called`);
  };
  return {
    fetch: forbidden("fetch"),
    goto: forbidden("goto"),
    reload: forbidden("reload"),
    waitForResponse: (matcher, options = {}) => {
      lifecycle.push("waiter");
      const response = queue.shift();
      assert.equal(typeof matcher, "function");
      if (!response) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("response timeout")), 5);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(options.signal.reason);
          }, { once: true });
        });
      }
      assert.equal(matcher(response), true);
      return Promise.resolve(response);
    },
  };
}

async function runAuthorizationCoordinator({
  first = fakeAuthorizationResponse(),
  second,
  inputAutoVerify = true,
  lifecycle = [],
  verificationAdapter = async () => ({
    attempted: true,
    completed: true,
    provider: "geetest4",
    challenge_type: "slider",
    attempts: 1,
    reason: "completed",
  }),
} = {}) {
  let clicks = 0;
  let disposals = 0;
  const page = fakeAuthorizationPage([first, second].filter(Boolean), lifecycle);
  const result = await coordinateThreeMfAuthorization(page, {
    instanceId: "123",
    authorizationTimeout: 100,
    inputAutoVerify,
    findButton: async () => {
      lifecycle.push("find-button");
      return {
        click: async () => {
          clicks += 1;
          lifecycle.push("click");
        },
        dispose: async () => {
          disposals += 1;
          lifecycle.push("dispose");
        },
      };
    },
    verificationAdapter: async (...args) => {
      lifecycle.push("verification-input");
      return verificationAdapter(...args);
    },
  });
  return { result, clicks, disposals };
}

test("3MF coordinator returns a signed HTTP 200 response without verification", async () => {
  let verificationCalls = 0;
  const { result, clicks, disposals } = await runAuthorizationCoordinator({
    verificationAdapter: async () => {
      verificationCalls += 1;
      return { completed: true };
    },
  });

  assert.equal(result.status_code, 200);
  assert.equal(result.payload.url, "https://download.example.test/part.3mf");
  assert.equal(verificationCalls, 0);
  assert.equal(clicks, 1);
  assert.equal(disposals, 1);
});

test("3MF coordinator installs the second waiter before verifying an HTTP 418 response", async () => {
  const lifecycle = [];
  const first = fakeAuthorizationResponse({
    status: 418,
    payload: { captchaId: "captcha-123", message: "verify" },
  });
  const second = fakeAuthorizationResponse({
    payload: { name: "verified.3mf", url: "https://download.example.test/verified.3mf" },
  });

  const { result, clicks } = await runAuthorizationCoordinator({ first, second, lifecycle });

  assert.equal(clicks, 1);
  assert.deepEqual(lifecycle, [
    "waiter",
    "find-button",
    "click",
    "dispose",
    "waiter",
    "verification-input",
  ]);
  assert.equal(result.status_code, 200);
  assert.equal(result.payload.url, "https://download.example.test/verified.3mf");
  assert.equal(result.verification.completed, true);
});

test("3MF coordinator verifies a captcha payload even when its status is not 418", async () => {
  let verificationCalls = 0;
  const first = fakeAuthorizationResponse({
    status: 400,
    payload: { captchaId: "captcha-from-payload" },
  });
  const second = fakeAuthorizationResponse();

  await runAuthorizationCoordinator({
    first,
    second,
    verificationAdapter: async () => {
      verificationCalls += 1;
      return { attempted: true, completed: true, provider: "geetest4" };
    },
  });

  assert.equal(verificationCalls, 1);
});

test("3MF coordinator settles an unused waiter and sanitizes adapter failure", async () => {
  const first = fakeAuthorizationResponse({ status: 418, payload: { captchaId: "captcha-123" } });
  const { result, clicks } = await runAuthorizationCoordinator({
    first,
    verificationAdapter: async () => {
      throw new Error("secret-cookie-and-token");
    },
  });

  assert.equal(clicks, 1);
  assert.equal(result.status_code, 418);
  assert.equal(result.payload.captchaId, "captcha-123");
  assert.deepEqual(result.verification, {
    attempted: true,
    completed: false,
    provider: "unknown",
    challenge_type: "unknown",
    attempts: 0,
    reason: "verification_failed",
  });
});

test("3MF coordinator returns the original response when verification times out", async () => {
  const first = fakeAuthorizationResponse({ status: 418, payload: { captchaId: "captcha-123" } });
  const { result } = await runAuthorizationCoordinator({
    first,
    verificationAdapter: async () => ({
      attempted: true,
      completed: false,
      provider: "geetest4",
      challenge_type: "slider",
      attempts: 1,
      reason: "timeout",
      confidence: 0.4,
      token: "must-not-leak",
    }),
  });

  assert.equal(result.status_code, 418);
  assert.equal(result.payload.captchaId, "captcha-123");
  assert.deepEqual(result.verification, {
    attempted: true,
    completed: false,
    provider: "geetest4",
    challenge_type: "slider",
    attempts: 1,
    reason: "timeout",
    confidence: 0.4,
  });
});

test("3MF coordinator settles the first waiter when button lookup outlives its timeout", async () => {
  let waiterSignal;
  let waiterSettled = false;
  const page = {
    waitForResponse: (_matcher, options = {}) => {
      waiterSignal = options.signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiterSettled = true;
          reject(new Error("first response timeout"));
        }, 5);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          waiterSettled = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    },
  };

  await assert.rejects(
    coordinateThreeMfAuthorization(page, {
      instanceId: "123",
      authorizationTimeout: 5,
      findButton: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("button lookup failed");
      },
    }),
    /button lookup failed/,
  );
  assert.equal(waiterSignal?.aborted, true);
  assert.equal(waiterSettled, true);
});

test("3MF coordinator preserves a click failure when dispose also fails", async () => {
  const first = fakeAuthorizationResponse();
  const page = fakeAuthorizationPage([first]);
  let clicks = 0;
  let disposals = 0;

  await assert.rejects(
    coordinateThreeMfAuthorization(page, {
      instanceId: "123",
      findButton: async () => ({
        click: async () => {
          clicks += 1;
          throw new Error("click failed");
        },
        dispose: async () => {
          disposals += 1;
          throw new Error("dispose failed");
        },
      }),
    }),
    /click failed/,
  );
  assert.equal(clicks, 1);
  assert.equal(disposals, 1);
});

test("3MF coordinator ignores dispose failure after a successful click", async () => {
  const first = fakeAuthorizationResponse();
  const page = fakeAuthorizationPage([first]);

  const result = await coordinateThreeMfAuthorization(page, {
    instanceId: "123",
    findButton: async () => ({
      click: async () => {},
      dispose: async () => {
        throw new Error("dispose failed with secret-token");
      },
    }),
  });

  assert.equal(result.status_code, 200);
  assert.equal(result.payload.url, "https://download.example.test/part.3mf");
});

test("3MF coordinator returns the first response when a completed verification has no second response", async () => {
  const first = fakeAuthorizationResponse({ status: 418, payload: { captchaId: "captcha-123" } });

  const { result } = await runAuthorizationCoordinator({ first });

  assert.equal(result.status_code, 418);
  assert.equal(result.payload.captchaId, "captcha-123");
  assert.equal(result.verification.completed, true);
});

test("authorization response parsing bounds invalid JSON", async () => {
  const result = await readAuthorizationResponse(fakeAuthorizationResponse({
    status: 502,
    rawText: `<html>${"x".repeat(2000)}`,
  }));

  assert.equal(result.status_code, 502);
  assert.equal(result.text.length, 1024);
  assert.equal(result.payload.message.length, 1024);
  assert.equal(result.payload.code, "");
  assert.equal(result.payload.captchaId, "");
});

test("authorization response parsing does not expose text rejection details", async () => {
  await assert.rejects(
    readAuthorizationResponse(fakeAuthorizationResponse({
      textError: new Error("secret-cookie-from-response"),
    })),
    (error) => error.message === "authorization response body unavailable",
  );
});

test("3MF coordinator falls back when the second response cannot be parsed", async () => {
  const first = fakeAuthorizationResponse({ status: 418, payload: { captchaId: "captcha-123" } });
  const second = fakeAuthorizationResponse({
    textError: new Error("second-response-secret"),
  });

  const { result } = await runAuthorizationCoordinator({ first, second });

  assert.equal(result.status_code, 418);
  assert.equal(result.payload.captchaId, "captcha-123");
  assert.equal(result.verification.completed, true);
});

function fakeInputPage({
  dispatch = async () => {},
  protocol,
  detach = async () => {},
} = {}) {
  let style = null;
  let nextSessionId = 0;
  const sendProtocol = protocol || (async (method, params) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: [1] };
    if (method === "DOM.getAttributes") {
      return { attributes: style === null ? [] : ["style", style] };
    }
    if (method === "DOM.setAttributeValue") {
      style = params.value;
      return {};
    }
    if (method === "DOM.removeAttribute") {
      style = null;
      return {};
    }
    throw new Error(`unexpected protocol method: ${method}`);
  });
  return {
    mouse: {
      move: async (x, y) => dispatch({ type: "mouseMoved", x, y }),
      down: async () => dispatch({ type: "mousePressed" }),
      up: async () => dispatch({ type: "mouseReleased" }),
    },
    createCDPSession: async () => {
      const sessionId = nextSessionId;
      nextSessionId += 1;
      return {
        send: async (method, params, options) => {
          if (method === "Input.dispatchMouseEvent") return dispatch(params, options);
          return sendProtocol(method, params, options);
        },
        detach: () => detach(sessionId),
      };
    },
  };
}

function clickChallenge(click, id = "challenge-a") {
  return {
    provider: "geetest4",
    challenge_type: "icon_click",
    target: fakeHandle({ fingerprint: `${id}:target` }),
    candidates: [
      fakeHandle({ fingerprint: `${id}:candidate-0` }),
      fakeHandle({ click, fingerprint: `${id}:candidate-1` }),
      fakeHandle({ fingerprint: `${id}:candidate-2` }),
    ],
  };
}

test("drag trajectory reaches the target with bounded overshoot", () => {
  const points = buildDragTrajectory(180, () => 0.5);

  assert.ok(points.length >= 12);
  assert.equal(points.at(-1).x, 180);
  assert.ok(Math.max(...points.map((point) => point.x)) <= 186);
  assert.ok(points.every((point) => Math.abs(point.y) <= 3));
  assert.ok(points.slice(0, -3).every((point, index, values) => (
    index === 0 || point.x >= values[index - 1].x
  )));
});

test("verification diagnostics keep only bounded fields", () => {
  assert.deepEqual(
    sanitizeVerificationResult({
      attempted: true,
      completed: false,
      provider: "geetest4",
      challenge_type: "slider",
      attempts: 9,
      reason: "low_confidence".repeat(20),
      confidence: 0.61,
      token: "secret",
      screenshot: "secret-image",
    }),
    {
      attempted: true,
      completed: false,
      provider: "geetest4",
      challenge_type: "slider",
      attempts: 2,
      reason: "low_confidencelow_confidencelow_confidencelow_confidencelow_confidencelow_confid",
      confidence: 0.61,
    },
  );
});

test("vision request passes only the strict mode payload to Python", async () => {
  let spawnCall;
  let inputPayload;
  const spawnFn = (...args) => {
    spawnCall = args;
    return fakeChild((child, input) => {
      inputPayload = JSON.parse(input);
      child.stdout.end('{"ok":true,"candidate_index":1,"confidence":0.9}');
      child.emit("close", 0, null);
    });
  };

  const result = await runVisionRequest({
    mode: "click",
    target_png: "target",
    candidate_pngs: ["left", "right"],
    url: "https://example.com/private",
    cookie: "secret-cookie",
    token: "secret-token",
    browser_credentials: "secret-browser",
  }, { spawnFn });

  assert.equal(spawnCall[0], process.env.PYTHON || "python");
  assert.deepEqual(spawnCall[1], ["-m", "app.services.makerworld_captcha_vision"]);
  assert.deepEqual(spawnCall[2], { stdio: ["pipe", "pipe", "pipe"] });
  assert.deepEqual(inputPayload, {
    mode: "click",
    target_png: "target",
    candidate_pngs: ["left", "right"],
  });
  assert.equal(result.candidate_index, 1);
});

test("vision request kills a timed out child", async () => {
  let child;
  const spawnFn = () => {
    child = fakeChild(() => {});
    return child;
  };

  await assert.rejects(
    runVisionRequest({ mode: "click", target_png: "a", candidate_pngs: ["b", "c"] }, {
      spawnFn,
      timeoutMs: 5,
    }),
    /timed out/,
  );
  assert.equal(child.killed, true);
});

test("vision request caps stdout and stderr independently", async () => {
  let stdoutOverflowChild;
  await assert.rejects(
    runVisionRequest({ mode: "click", target_png: "a", candidate_pngs: ["b", "c"] }, {
      spawnFn: () => {
        stdoutOverflowChild = fakeChild((child) => child.stdout.write(Buffer.alloc(64 * 1024 + 1)));
        return stdoutOverflowChild;
      },
    }),
    /output limit/,
  );
  assert.equal(stdoutOverflowChild.killed, true);

  let stderrOverflowChild;
  await assert.rejects(
    runVisionRequest({ mode: "click", target_png: "a", candidate_pngs: ["b", "c"] }, {
      spawnFn: () => {
        stderrOverflowChild = fakeChild((child) => child.stderr.write(Buffer.alloc(64 * 1024 + 1)));
        return stderrOverflowChild;
      },
    }),
    /output limit/,
  );
  assert.equal(stderrOverflowChild.killed, true);

  const result = await runVisionRequest(
    { mode: "click", target_png: "a", candidate_pngs: ["b", "c"] },
    {
      spawnFn: () => fakeChild((child) => {
        child.stderr.write(Buffer.alloc(64 * 1024));
        child.stdout.end('{"ok":true}');
        child.emit("close", 0, null);
      }),
    },
  );
  assert.equal(result.ok, true);
});

test("vision request does not expose stderr", async () => {

  await assert.rejects(
    runVisionRequest({ mode: "click", target_png: "a", candidate_pngs: ["b", "c"] }, {
      spawnFn: () => fakeChild((child) => {
        child.stderr.end("secret-cookie-from-python");
        child.emit("close", 1, null);
      }),
    }),
    (error) => error.message === "vision process failed",
  );
});

test("vision request rejects non-JSON output", async () => {
  await assert.rejects(
    runVisionRequest({ mode: "click", target_png: "a", candidate_pngs: ["b", "c"] }, {
      spawnFn: () => fakeChild((child) => {
        child.stdout.end("not json");
        child.emit("close", 0, null);
      }),
    }),
    /invalid JSON/,
  );
});

test("challenge discovery checks main frame first, deduplicates frames, and finds GeeTest clicks", async () => {
  const visited = [];
  const seen = new Set();
  const hiddenContainer = fakeHandle({ box: { x: 0, y: 0, width: 0, height: 0 } });
  const target = fakeHandle();
  const candidates = [fakeHandle(), fakeHandle(), fakeHandle()];
  const visibleContainer = fakeHandle({
    one: (selector) => (/ques|tip|target/i.test(selector) ? target : null),
    many: (selector) => (/item|icon|candidate/i.test(selector) ? candidates : []),
  });
  const main = fakeFrame({
    label: "main",
    one: (selector) => {
      if (!seen.has("main")) visited.push("main");
      seen.add("main");
      return selector.includes("geetest") ? hiddenContainer : null;
    },
  });
  const child = fakeFrame({
    label: "child",
    one: (selector) => {
      if (!seen.has("child")) visited.push("child");
      seen.add("child");
      return selector.includes("geetest") ? visibleContainer : null;
    },
  });
  const page = { mainFrame: () => main, frames: () => [main, child, main] };

  const challenge = await detectVerificationChallenge(page);

  assert.equal(challenge.provider, "geetest4");
  assert.equal(challenge.challenge_type, "icon_click");
  assert.equal(challenge.frame, child);
  assert.equal(challenge.target, target);
  assert.deepEqual(challenge.candidates, candidates);
  assert.deepEqual(visited, ["main", "child"]);
});

test("challenge discovery finds bounded slider fallbacks and ignores hidden controls", async () => {
  const hiddenHandle = fakeHandle({ visible: false });
  const sliderHandle = fakeHandle();
  const sliderBackground = fakeHandle({ box: { x: 20, y: 20, width: 300, height: 120 } });
  const sliderPiece = fakeHandle();
  const container = fakeHandle({
    one: (selector) => {
      if (selector.includes("slider_button") || selector.includes("geetest_btn")) return hiddenHandle;
      if (selector.includes("[class*='slider'][class*='handle']")) return sliderHandle;
      if (selector.includes("geetest_bg")) return sliderBackground;
      if (selector.includes("geetest_slice")) return sliderPiece;
      return null;
    },
  });
  const frame = fakeFrame({ one: (selector) => (selector.includes("geetest") ? container : null) });

  const challenge = await detectVerificationChallenge({ mainFrame: () => frame, frames: () => [frame] });

  assert.equal(challenge.challenge_type, "slider");
  assert.equal(challenge.handle, sliderHandle);
  assert.equal(challenge.background, sliderBackground);
  assert.equal(challenge.piece, sliderPiece);
});

test("challenge discovery rejects a generic slider container as the drag handle", async () => {
  const sliderContainer = fakeHandle({ box: { x: 10, y: 10, width: 300, height: 120 } });
  const sliderBackground = fakeHandle({ box: { x: 10, y: 10, width: 300, height: 120 } });
  const sliderPiece = fakeHandle();
  const container = fakeHandle({
    one: (selector) => {
      if (selector === "[class*='slider']") return sliderContainer;
      if (selector.includes("geetest_bg")) return sliderBackground;
      if (selector.includes("geetest_slice")) return sliderPiece;
      return null;
    },
  });
  const frame = fakeFrame({ one: (selector) => (selector.includes("geetest") ? container : null) });

  const challenge = await detectVerificationChallenge({ mainFrame: () => frame, frames: () => [frame] });

  assert.equal(challenge, null);
});

test("challenge discovery recognizes visible Cloudflare iframe or a populated response", async () => {
  const iframe = fakeHandle();
  const iframeFrame = fakeFrame({
    one: (selector) => (selector.includes("challenges.cloudflare.com") ? iframe : null),
  });
  const iframeChallenge = await detectVerificationChallenge({
    mainFrame: () => iframeFrame,
    frames: () => [iframeFrame],
  });
  assert.equal(iframeChallenge.provider, "turnstile");
  assert.equal(iframeChallenge.challenge_type, "checkbox");

  const response = fakeHandle({ value: "completed-token", box: null });
  const responseFrame = fakeFrame({
    one: (selector) => (selector.includes("cf-turnstile-response") ? response : null),
  });
  const responseChallenge = await detectVerificationChallenge({
    mainFrame: () => responseFrame,
    frames: () => [responseFrame],
  });
  assert.equal(responseChallenge.provider, "turnstile");
  assert.equal(responseChallenge.response, response);
});

test("Turnstile discovery does not select an unrelated page checkbox", async () => {
  const iframe = fakeHandle();
  const unrelatedCheckbox = fakeHandle();
  const turnstileCheckbox = fakeHandle();
  const main = fakeFrame({
    one: (selector) => {
      if (selector.includes("challenges.cloudflare.com")) return iframe;
      if (selector.includes("checkbox")) return unrelatedCheckbox;
      return null;
    },
  });
  main.url = () => "https://makerworld.com/zh";
  const child = fakeFrame({
    one: (selector) => (selector.includes("checkbox") ? turnstileCheckbox : null),
  });
  child.url = () => "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile";

  const challenge = await detectVerificationChallenge({
    mainFrame: () => main,
    frames: () => [main, child],
  });

  assert.equal(challenge.checkbox, turnstileCheckbox);
});

test("click verification clicks only the candidate selected by vision", async () => {
  let syntheticClicks = 0;
  const inputEvents = [];
  const page = fakeInputPage({ dispatch: async (event) => { inputEvents.push(event); } });
  const challenge = clickChallenge(async () => { syntheticClicks += 1; });

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "fingerprint-a",
    isChallengeComplete: async () => true,
    visionRequest: async () => ({ ok: true, candidate_index: 1, confidence: 0.91 }),
  });

  assert.equal(syntheticClicks, 0);
  assert.deepEqual(inputEvents.map(({ type }) => type), [
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);
  assert.equal(inputEvents.every(({ pointerType }) => pointerType === "mouse"), true);
  assert.equal(result.completed, true);
  assert.equal(result.attempts, 1);
});

test("slider always releases the mouse and restores the piece after movement errors", async () => {
  const mouseEvents = [];
  const page = fakeInputPage({
    dispatch: async ({ type }) => {
      if (type === "mouseMoved") {
        mouseEvents.push("move");
        if (mouseEvents.filter((event) => event === "move").length > 1) throw new Error("move failed");
      } else if (type === "mousePressed") mouseEvents.push("down");
      else if (type === "mouseReleased") mouseEvents.push("up");
    },
  });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle({ box: { x: 10, y: 30, width: 40, height: 40 } }),
    background: fakeHandle({ box: { x: 20, y: 10, width: 300, height: 120 } }),
    piece: fakeHandle({
      box: { x: 50, y: 20, width: 30, height: 30 },
      evaluate: async () => { throw new Error("page callback must not run"); },
    }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-a",
    visionRequest: async () => ({ ok: true, distance_css: 120, confidence: 0.92 }),
    random: () => 0.5,
    sleep: async () => {},
  });

  assert.equal(result.completed, false);
  assert.equal(mouseEvents.includes("down"), true);
  assert.equal(mouseEvents.at(-1), "up");
});

test("slider geometry uses PNG pixels while dragging in CSS pixels", async () => {
  let visionPayload;
  const moves = [];
  const page = fakeInputPage({
    dispatch: async ({ type, x, y }) => {
      if (type === "mouseMoved") moves.push({ x, y });
    },
  });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle({ box: { x: 10, y: 30, width: 40, height: 40 } }),
    background: fakeHandle({
      box: { x: 20, y: 10, width: 300, height: 120 },
      screenshot: pngBuffer(600, 240),
    }),
    piece: fakeHandle({
      screenshot: pngBuffer(60, 60),
      evaluate: async (_callback, action) => (
        action?.action === "hide"
          ? { applied: true, id: action.id, value: "", priority: "" }
          : true
      ),
    }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-dpr",
    isChallengeComplete: async () => true,
    visionRequest: async (payload) => {
      visionPayload = payload;
      return { ok: true, distance_css: 120, confidence: 0.92 };
    },
    random: () => 0.5,
    sleep: async () => {},
  });

  assert.equal(result.completed, true);
  assert.deepEqual(visionPayload.geometry, {
    image_width: 600,
    track_width: 300,
    handle_width: 40,
  });
  assert.equal(moves.at(-1).x, 150);
});

test("timed out vision results never trigger a late click", async () => {
  let resolveVision;
  let clicks = 0;
  const challenge = clickChallenge(async () => { clicks += 1; });
  const verification = attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    visionRequest: async () => new Promise((resolve) => { resolveVision = resolve; }),
    timeoutMs: 10,
  });

  const result = await verification;
  resolveVision({ ok: true, candidate_index: 1, confidence: 0.9 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.reason, "timeout");
  assert.equal(clicks, 0);
});

test("a timed out trusted candidate click queues only release before detach", async () => {
  const lifecycle = [];
  const page = fakeInputPage({
    dispatch: async ({ type }) => {
      lifecycle.push(type);
      if (type === "mousePressed") return new Promise(() => {});
      return undefined;
    },
    detach: async () => { lifecycle.push("detach"); },
  });
  const challenge = clickChallenge(async () => {
    throw new Error("synthetic click must not run");
  });
  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "candidate-timeout",
    visionRequest: async () => ({ ok: true, candidate_index: 1, confidence: 0.9 }),
    timeoutMs: 20,
  });

  assert.equal(result.reason, "timeout");
  assert.deepEqual(lifecycle, ["mouseMoved", "mousePressed", "mouseReleased", "detach"]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(lifecycle, ["mouseMoved", "mousePressed", "mouseReleased", "detach"]);
});

test("a hanging screenshot cannot start vision or click after return", async () => {
  let screenshots = 0;
  let visionCalls = 0;
  let clicks = 0;
  const challenge = clickChallenge(async () => { clicks += 1; });
  challenge.target.screenshot = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    screenshots += 1;
    return pngBuffer(40, 40);
  };
  const result = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    visionRequest: async () => {
      visionCalls += 1;
      return { ok: true, candidate_index: 1, confidence: 0.9 };
    },
    timeoutMs: 10,
  });

  assert.equal(result.reason, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(screenshots, 1);
  assert.equal(visionCalls, 0);
  assert.equal(clicks, 0);
});

test("timed out slider vision never starts a late drag", async () => {
  let resolveVision;
  let mouseEvents = 0;
  const page = fakeInputPage({ dispatch: async () => { mouseEvents += 1; } });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120) }),
    piece: fakeHandle({
      evaluate: async (_callback, action) => (
        action?.action === "hide"
          ? { applied: true, id: action.id, value: "", priority: "" }
          : true
      ),
    }),
  };
  const verification = attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-late",
    visionRequest: async () => new Promise((resolve) => { resolveVision = resolve; }),
    timeoutMs: 10,
  });

  const result = await verification;
  resolveVision({ ok: true, distance_css: 100, confidence: 0.9 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.reason, "timeout");
  assert.equal(mouseEvents, 0);
});

test("mouse cleanup uses a monotonic hard deadline when wall time moves backwards", async () => {
  const originalDateNow = Date.now;
  let wallClockOffset = 0;
  const lifecycle = [];
  const page = fakeInputPage({
    dispatch: async ({ type }) => {
      lifecycle.push(type);
      if (type === "mousePressed") {
        wallClockOffset = -100;
        return new Promise(() => {});
      }
      if (type === "mouseReleased") return new Promise(() => {});
      return undefined;
    },
    detach: async (sessionId) => { lifecycle.push(`detach-${sessionId}`); },
  });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120) }),
    piece: fakeHandle({
      evaluate: async (_callback, action) => (
        action?.action === "hide"
          ? { applied: true, id: action.id, value: "", priority: "" }
          : true
      ),
    }),
  };
  const startedAt = performance.now();
  Date.now = () => originalDateNow() + wallClockOffset;
  let result;
  try {
    result = await attemptAutomaticVerification(page, {
      detectChallenge: async () => challenge,
      fingerprintChallenge: async () => "slider-cdp-hang",
      visionRequest: async () => ({ ok: true, distance_css: 100, confidence: 0.9 }),
      timeoutMs: 20,
    });
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(result.reason, "timeout");
  assert.ok(performance.now() - startedAt < 80);
  assert.deepEqual(lifecycle, [
    "detach-0",
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
    "detach-1",
  ]);
});

test("total timeout aborts and kills the active Python child", async () => {
  let child;
  const challenge = clickChallenge(async () => {});
  const result = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    visionRequest: (payload, { signal }) => runVisionRequest(payload, {
      signal,
      spawnFn: () => {
        child = fakeChild(() => {});
        return child;
      },
    }),
    timeoutMs: 10,
  });

  assert.equal(result.reason, "timeout");
  assert.equal(child.killed, true);
});

test("slider timeout restores the exact piece visibility before returning", async () => {
  const originalStyle = "visibility:collapse!important";
  let style = originalStyle;
  const page = fakeInputPage({
    protocol: async (method, params) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: [1] };
      if (method === "DOM.getAttributes") return { attributes: ["style", style] };
      if (method === "DOM.setAttributeValue") {
        style = params.value;
        return {};
      }
      throw new Error(`unexpected protocol method: ${method}`);
    },
  });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: () => new Promise(() => {}) }),
    piece: fakeHandle({ evaluate: async () => { throw new Error("page callback must not run"); } }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-timeout",
    timeoutMs: 10,
  });

  assert.equal(result.reason, "timeout");
  assert.equal(style, originalStyle);
});

test("piece visibility is restored through ordered CDP DOM commands without page callbacks", async () => {
  const originalStyle = "visibility:collapse!important;color:red";
  let style = originalStyle;
  const lifecycle = [];
  const page = fakeInputPage({
    protocol: async (method, params) => {
      lifecycle.push(method);
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: [7] };
      if (method === "DOM.getAttributes") return { attributes: ["class", "piece", "style", style] };
      if (method === "DOM.setAttributeValue") {
        assert.equal(params.nodeId, 7);
        assert.equal(params.name, "style");
        style = params.value;
        return {};
      }
      if (method === "DOM.removeAttribute") {
        style = null;
        return {};
      }
      throw new Error(`unexpected protocol method: ${method}`);
    },
    detach: async () => { lifecycle.push("detach"); },
  });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: () => new Promise(() => {}) }),
    piece: fakeHandle({
      backendNodeId: 42,
      evaluate: async () => { throw new Error("page callback must not run"); },
    }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-hide-timeout",
    timeoutMs: 20,
  });

  assert.equal(result.reason, "timeout");
  assert.equal(style, originalStyle);
  assert.deepEqual(lifecycle, [
    "DOM.getDocument",
    "DOM.pushNodesByBackendIdsToFrontend",
    "DOM.getAttributes",
    "DOM.setAttributeValue",
    "DOM.setAttributeValue",
    "detach",
  ]);
});

test("piece restoration failure returns a controlled result and never drags", async () => {
  let mouseEvents = 0;
  let detached = false;
  const page = fakeInputPage({
    dispatch: async () => { mouseEvents += 1; },
    protocol: async (method) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: [1] };
      if (method === "DOM.getAttributes") return { attributes: [] };
      if (method === "DOM.setAttributeValue") return {};
      if (method === "DOM.removeAttribute") throw new Error("detached");
      throw new Error(`unexpected protocol method: ${method}`);
    },
    detach: async () => { detached = true; },
  });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120) }),
    piece: fakeHandle({ evaluate: async () => { throw new Error("page callback must not run"); } }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-restore",
    visionRequest: async () => ({ ok: true, distance_css: 100, confidence: 0.9 }),
  });

  assert.equal(result.reason, "piece_restore_failed");
  assert.equal(mouseEvents, 0);
  assert.equal(detached, true);
});

test("piece session detaches when backend node lookup fails", async () => {
  let detached = false;
  const page = fakeInputPage({ detach: async () => { detached = true; } });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120) }),
    piece: fakeHandle(),
  };
  challenge.piece.backendNodeId = async () => { throw new Error("detached node"); };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-node-failure",
  });

  assert.equal(result.reason, "interaction_failed");
  assert.equal(detached, true);
});

test("candidate selected styling does not trigger a second interaction", async () => {
  let clicks = 0;
  let selected = false;
  const page = fakeInputPage({
    dispatch: async ({ type }) => {
      if (type === "mouseReleased") {
        clicks += 1;
        selected = true;
      }
    },
  });
  const challenge = clickChallenge(async () => { throw new Error("synthetic click must not run"); });
  challenge.candidates[1].screenshot = async () => pngBuffer(40, 40, selected ? 2 : 1);
  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    isChallengeComplete: async () => false,
    visionRequest: async () => ({ ok: true, candidate_index: 1, confidence: 0.9 }),
    sleep: async () => {},
    postInteractionTimeoutMs: 5,
  });

  assert.equal(clicks, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.completed, false);
});

test("a genuinely new click challenge permits exactly one second interaction", async () => {
  let active = "a";
  let clicks = 0;
  const page = fakeInputPage({
    dispatch: async ({ type }) => {
      if (type !== "mouseReleased") return;
      clicks += 1;
      if (clicks === 1) active = "b";
    },
  });
  const challengeA = clickChallenge(async () => { throw new Error("synthetic click must not run"); }, "challenge-a");
  const challengeB = clickChallenge(async () => { throw new Error("synthetic click must not run"); }, "challenge-b");

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => (active === "a" ? challengeA : challengeB),
    isChallengeComplete: async () => false,
    visionRequest: async () => ({ ok: true, candidate_index: 1, confidence: 0.9 }),
    sleep: async () => {},
    postInteractionTimeoutMs: 5,
  });

  assert.equal(clicks, 2);
  assert.equal(result.attempts, 2);
});

test("slider piece movement does not trigger a second drag", async () => {
  let drags = 0;
  let moved = false;
  const page = fakeInputPage({
    dispatch: async ({ type }) => {
      if (type === "mousePressed") drags += 1;
      if (type === "mouseReleased") moved = true;
    },
  });
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120, 7) }),
    piece: fakeHandle({
      screenshot: () => pngBuffer(40, 40, moved ? 2 : 1),
      evaluate: async (_callback, action) => (
        action?.action === "hide"
          ? { applied: true, id: action.id, value: "", priority: "" }
          : true
      ),
    }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    isChallengeComplete: async () => false,
    visionRequest: async () => ({ ok: true, distance_css: 100, confidence: 0.9 }),
    random: () => 0.5,
    sleep: async () => {},
    postInteractionTimeoutMs: 5,
  });

  assert.equal(drags, 1);
  assert.equal(result.attempts, 1);
});

test("automatic verification reports the total-stage timeout", async () => {
  const challenge = clickChallenge(async () => {});
  const startedAt = Date.now();

  const result = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => new Promise(() => {}),
    timeoutMs: 5,
  });

  assert.equal(result.reason, "timeout");
  assert.ok(Date.now() - startedAt < 100);
});

test("Turnstile clicks at most once per attempt without calling vision", async () => {
  let syntheticClicks = 0;
  let visionCalls = 0;
  const inputEvents = [];
  const page = fakeInputPage({ dispatch: async (event) => { inputEvents.push(event); } });
  const challenge = {
    provider: "turnstile",
    challenge_type: "checkbox",
    checkbox: fakeHandle({ click: async () => { syntheticClicks += 1; } }),
    response: fakeHandle({ value: "" }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "turnstile-checkbox",
    isChallengeComplete: async () => inputEvents.some(({ type }) => type === "mouseReleased"),
    visionRequest: async () => { visionCalls += 1; },
    turnstileResponseWaitMs: 0,
  });

  assert.equal(result.completed, true);
  assert.equal(syntheticClicks, 0);
  assert.deepEqual(inputEvents.map(({ type }) => type), [
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);
  assert.equal(inputEvents.every(({ pointerType }) => pointerType === "mouse"), true);
  assert.equal(visionCalls, 0);
});

test("Turnstile cutoff sends no new press after a hanging pointer move", async () => {
  const lifecycle = [];
  const page = fakeInputPage({
    dispatch: async ({ type }) => {
      lifecycle.push(type);
      if (type === "mouseMoved") return new Promise(() => {});
      return undefined;
    },
    detach: async () => { lifecycle.push("detach"); },
  });
  const challenge = {
    provider: "turnstile",
    challenge_type: "checkbox",
    checkbox: fakeHandle({
      fingerprint: "turnstile-checkbox",
      click: async () => { throw new Error("synthetic click must not run"); },
    }),
    response: fakeHandle({ value: "" }),
  };
  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    turnstileResponseWaitMs: 0,
    timeoutMs: 10,
  });

  assert.equal(result.reason, "timeout");
  assert.deepEqual(lifecycle, ["mouseMoved", "detach"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(lifecycle, ["mouseMoved", "detach"]);
});

test("Turnstile passive token completion does not count as an interaction", async () => {
  let clicks = 0;
  const challenge = {
    provider: "turnstile",
    challenge_type: "checkbox",
    checkbox: fakeHandle({ click: async () => { clicks += 1; } }),
    response: fakeHandle({ value: "completed-token", box: null }),
  };

  const result = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
  });

  assert.equal(result.completed, true);
  assert.equal(result.attempted, false);
  assert.equal(result.attempts, 0);
  assert.equal(clicks, 0);
});
