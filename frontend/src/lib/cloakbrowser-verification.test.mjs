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


function fakeHandle({
  box = { x: 10, y: 20, width: 40, height: 40 },
  visible = true,
  value = "",
  screenshot = Buffer.from("png"),
  one = () => null,
  many = () => [],
  click = async () => {},
  evaluate,
} = {}) {
  return {
    boundingBox: async () => box,
    evaluate: evaluate || (async (_callback, argument) => {
      if (argument === "read-value") return value;
      return visible;
    }),
    screenshot: async () => screenshot,
    $: async (selector) => one(selector),
    $$: async (selector) => many(selector),
    click,
  };
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

function clickChallenge(click) {
  return {
    provider: "geetest4",
    challenge_type: "icon_click",
    target: fakeHandle(),
    candidates: [fakeHandle(), fakeHandle({ click }), fakeHandle()],
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

test("vision request caps output and does not expose stderr", async () => {
  let overflowChild;
  await assert.rejects(
    runVisionRequest({ mode: "click", target_png: "a", candidate_pngs: ["b", "c"] }, {
      spawnFn: () => {
        overflowChild = fakeChild((child) => child.stdout.write(Buffer.alloc(64 * 1024 + 1)));
        return overflowChild;
      },
    }),
    /output limit/,
  );
  assert.equal(overflowChild.killed, true);

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
      if (selector.includes("[class*='slider']")) return sliderHandle;
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
  const clicks = [0, 0, 0];
  const challenge = clickChallenge(async () => { clicks[1] += 1; });
  challenge.candidates[0].click = async () => { clicks[0] += 1; };
  challenge.candidates[2].click = async () => { clicks[2] += 1; };

  const result = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "fingerprint-a",
    isChallengeComplete: async () => true,
    visionRequest: async () => ({ ok: true, candidate_index: 1, confidence: 0.91 }),
  });

  assert.deepEqual(clicks, [0, 1, 0]);
  assert.equal(result.completed, true);
  assert.equal(result.attempts, 1);
});

test("slider always releases the mouse and restores the piece after movement errors", async () => {
  const mouseEvents = [];
  const pieceStates = [];
  const page = {
    mouse: {
      move: async () => {
        mouseEvents.push("move");
        if (mouseEvents.filter((event) => event === "move").length > 1) throw new Error("move failed");
      },
      down: async () => { mouseEvents.push("down"); },
      up: async () => { mouseEvents.push("up"); },
    },
  };
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle({ box: { x: 10, y: 30, width: 40, height: 40 } }),
    background: fakeHandle({ box: { x: 20, y: 10, width: 300, height: 120 } }),
    piece: fakeHandle({
      box: { x: 50, y: 20, width: 30, height: 30 },
      evaluate: async (_callback, action) => {
        pieceStates.push(action);
        return true;
      },
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
  assert.deepEqual(pieceStates, ["hide", "restore"]);
});

test("provider attempts stop at two and require a changed fingerprint", async () => {
  let clicks = 0;
  const challenge = clickChallenge(async () => { clicks += 1; });
  const result = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => `fingerprint-${clicks}`,
    isChallengeComplete: async () => false,
    visionRequest: async () => ({ ok: true, candidate_index: 1, confidence: 0.9 }),
    sleep: async () => {},
    postInteractionTimeoutMs: 5,
  });

  assert.equal(clicks, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.completed, false);

  clicks = 0;
  const unchanged = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "same-fingerprint",
    isChallengeComplete: async () => false,
    visionRequest: async () => ({ ok: true, candidate_index: 1, confidence: 0.9 }),
    sleep: async () => {},
    postInteractionTimeoutMs: 5,
  });
  assert.equal(clicks, 1);
  assert.equal(unchanged.attempts, 1);
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
  let clicks = 0;
  let visionCalls = 0;
  const challenge = {
    provider: "turnstile",
    challenge_type: "checkbox",
    checkbox: fakeHandle({ click: async () => { clicks += 1; } }),
    response: fakeHandle({ value: "" }),
  };

  const result = await attemptAutomaticVerification({}, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => `turnstile-${clicks}`,
    isChallengeComplete: async () => clicks > 0,
    visionRequest: async () => { visionCalls += 1; },
    turnstileResponseWaitMs: 0,
  });

  assert.equal(result.completed, true);
  assert.equal(clicks, 1);
  assert.equal(visionCalls, 0);
});
