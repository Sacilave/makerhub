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
  screenshot = pngBuffer(40, 40),
  fingerprint = null,
  one = () => null,
  many = () => [],
  click = async () => {},
  evaluate,
} = {}) {
  return {
    boundingBox: async () => box,
    evaluate: evaluate || (async (_callback, argument) => {
      if (argument === "read-value") return value;
      if (argument === "fingerprint") return fingerprint;
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
        pieceStates.push(action?.action || action);
        if (action === "hide") return { value: "collapse", priority: "important" };
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

test("slider geometry uses PNG pixels while dragging in CSS pixels", async () => {
  let visionPayload;
  const moves = [];
  const page = {
    mouse: {
      move: async (x, y) => { moves.push({ x, y }); },
      down: async () => {},
      up: async () => {},
    },
  };
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
        action === "hide" ? { value: "", priority: "" } : true
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

test("timed out slider vision never starts a late drag", async () => {
  let resolveVision;
  let mouseEvents = 0;
  const page = {
    mouse: {
      move: async () => { mouseEvents += 1; },
      down: async () => { mouseEvents += 1; },
      up: async () => { mouseEvents += 1; },
    },
  };
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120) }),
    piece: fakeHandle({
      evaluate: async (_callback, action) => (
        action === "hide" ? { value: "", priority: "" } : true
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
  const pieceStates = [];
  const page = { mouse: { move: async () => {}, down: async () => {}, up: async () => {} } };
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: () => new Promise(() => {}) }),
    piece: fakeHandle({
      evaluate: async (_callback, action) => {
        if (action === "hide") {
          pieceStates.push("hide");
          return { value: "collapse", priority: "important" };
        }
        pieceStates.push(action);
        return true;
      },
    }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-timeout",
    timeoutMs: 10,
  });

  assert.equal(result.reason, "timeout");
  assert.deepEqual(pieceStates, [
    "hide",
    { action: "restore", value: "collapse", priority: "important" },
  ]);
});

test("timeout during piece hide waits for the late hide and restores before returning", async () => {
  const pieceStates = [];
  const page = { mouse: { move: async () => {}, down: async () => {}, up: async () => {} } };
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120) }),
    piece: fakeHandle({
      evaluate: async (_callback, action) => {
        if (action === "hide") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          pieceStates.push("hide");
          return { value: "visible", priority: "important" };
        }
        pieceStates.push(action);
        return true;
      },
    }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-hide-timeout",
    timeoutMs: 5,
  });

  assert.equal(result.reason, "timeout");
  assert.deepEqual(pieceStates, [
    "hide",
    { action: "restore", value: "visible", priority: "important" },
  ]);
});

test("piece restoration failure returns a controlled result and never drags", async () => {
  let mouseEvents = 0;
  const page = {
    mouse: {
      move: async () => { mouseEvents += 1; },
      down: async () => { mouseEvents += 1; },
      up: async () => { mouseEvents += 1; },
    },
  };
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120) }),
    piece: fakeHandle({
      evaluate: async (_callback, action) => {
        if (action === "hide") return { value: "", priority: "" };
        throw new Error("detached");
      },
    }),
  };

  const result = await attemptAutomaticVerification(page, {
    detectChallenge: async () => challenge,
    fingerprintChallenge: async () => "slider-restore",
    visionRequest: async () => ({ ok: true, distance_css: 100, confidence: 0.9 }),
  });

  assert.equal(result.reason, "piece_restore_failed");
  assert.equal(mouseEvents, 0);
});

test("candidate selected styling does not trigger a second interaction", async () => {
  let clicks = 0;
  let selected = false;
  const challenge = clickChallenge(async () => {
    clicks += 1;
    selected = true;
  });
  challenge.candidates[1].screenshot = async () => pngBuffer(40, 40, selected ? 2 : 1);
  const result = await attemptAutomaticVerification({}, {
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
  const challengeA = clickChallenge(async () => {
    clicks += 1;
    active = "b";
  }, "challenge-a");
  const challengeB = clickChallenge(async () => { clicks += 1; }, "challenge-b");

  const result = await attemptAutomaticVerification({}, {
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
  const page = {
    mouse: {
      move: async () => {},
      down: async () => { drags += 1; },
      up: async () => { moved = true; },
    },
  };
  const challenge = {
    provider: "geetest4",
    challenge_type: "slider",
    handle: fakeHandle(),
    background: fakeHandle({ screenshot: pngBuffer(300, 120, 7) }),
    piece: fakeHandle({
      screenshot: () => pngBuffer(40, 40, moved ? 2 : 1),
      evaluate: async (_callback, action) => (
        action === "hide" ? { value: "", priority: "" } : true
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
