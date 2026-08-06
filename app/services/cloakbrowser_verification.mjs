import { createHash } from "node:crypto";
import { spawn } from "node:child_process";


export const MAX_PROVIDER_ATTEMPTS = 2;
export const AUTO_VERIFY_TIMEOUT_MS = 50_000;
export const VISION_TIMEOUT_MS = 8_000;

const MAX_VISION_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_OUTCOME_WAIT_MS = 4_000;
const DEFAULT_TURNSTILE_WAIT_MS = 500;
const POLL_INTERVAL_MS = 100;

const GEETEST_CONTAINERS = ".geetest_box, .geetest_panel, [class*='geetest']";
const CLICK_TARGET_SELECTORS = [
  ".geetest_ques_tips img",
  ".geetest_tip_img",
  ".geetest_ques_back img",
  ".geetest_question img",
  "[class*='geetest'][class*='target'] img",
];
const CLICK_CANDIDATE_SELECTORS = [
  ".geetest_item img",
  ".geetest_item",
  ".geetest_image_item",
  ".geetest_icon_item",
  "[class*='geetest_item']",
  "[class*='candidate']",
];
const SLIDER_HANDLE_SELECTORS = [
  ".geetest_slider_button",
  ".geetest_btn",
  "[class*='slider_button']",
  "[class*='slider']",
];
const SLIDER_BACKGROUND_SELECTORS = [
  ".geetest_bg",
  ".geetest_canvas_bg",
  "[class*='geetest_bg']",
  "[class*='slider_bg']",
];
const SLIDER_PIECE_SELECTORS = [
  ".geetest_slice",
  ".geetest_canvas_slice",
  "[class*='geetest_slice']",
  "[class*='slider_piece']",
];
const TURNSTILE_RESPONSE_SELECTOR = "input[name='cf-turnstile-response']";
const TURNSTILE_IFRAME_SELECTOR = "iframe[src*='challenges.cloudflare.com']";
const TURNSTILE_CHECKBOX_SELECTORS = [
  "input[type='checkbox']",
  "[role='checkbox']",
  ".ctp-checkbox-label",
];

function clampRandom(random) {
  const value = Number(random());
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0.5;
}

function withinDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("automatic verification timed out"));
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("automatic verification timed out")), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function buildDragTrajectory(distance, random = Math.random) {
  const target = Math.max(0, Number(distance) || 0);
  if (target === 0) return [{ x: 0, y: 0 }];

  const points = [];
  const approachPoints = 16;
  for (let index = 1; index <= approachPoints; index += 1) {
    const progress = index / (approachPoints + 2);
    const eased = progress * progress * (3 - (2 * progress));
    points.push({
      x: Math.min(target * 0.96, target * eased),
      y: Math.round((clampRandom(random) * 6) - 3),
    });
  }
  const overshoot = Math.min(6, Math.max(1, target * 0.02));
  points.push({ x: target + overshoot, y: Math.round((clampRandom(random) * 4) - 2) });
  points.push({ x: target + (overshoot * 0.35), y: Math.round((clampRandom(random) * 2) - 1) });
  points.push({ x: target, y: 0 });
  return points;
}

export function sanitizeVerificationResult(value = {}) {
  const provider = ["geetest4", "turnstile"].includes(value.provider) ? value.provider : "unknown";
  const challengeType = ["icon_click", "slider", "checkbox"].includes(value.challenge_type)
    ? value.challenge_type
    : "unknown";
  const rawAttempts = Number(value.attempts || 0);
  const attempts = Number.isFinite(rawAttempts)
    ? Math.max(0, Math.min(rawAttempts, MAX_PROVIDER_ATTEMPTS))
    : 0;
  return {
    attempted: Boolean(value.attempted),
    completed: Boolean(value.completed),
    provider,
    challenge_type: challengeType,
    attempts,
    reason: String(value.reason || "").slice(0, 80),
    ...(Number.isFinite(Number(value.confidence)) ? { confidence: Number(value.confidence) } : {}),
  };
}

function cleanVisionPayload(payload) {
  if (String(payload?.mode || "").trim().toLowerCase() === "click") {
    return {
      mode: "click",
      target_png: payload?.target_png,
      candidate_pngs: Array.isArray(payload?.candidate_pngs) ? payload.candidate_pngs : [],
    };
  }
  if (String(payload?.mode || "").trim().toLowerCase() === "slider") {
    const geometry = payload?.geometry && typeof payload.geometry === "object" ? payload.geometry : {};
    return {
      mode: "slider",
      background_png: payload?.background_png,
      piece_png: payload?.piece_png,
      geometry: {
        image_width: geometry.image_width,
        track_width: geometry.track_width,
        handle_width: geometry.handle_width,
      },
    };
  }
  return { mode: "" };
}

export function runVisionRequest(payload, options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const requestedTimeout = Number(options.timeoutMs || VISION_TIMEOUT_MS);
  const timeoutMs = Math.max(1, Math.min(
    Number.isFinite(requestedTimeout) ? requestedTimeout : VISION_TIMEOUT_MS,
    VISION_TIMEOUT_MS,
  ));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(
        process.env.PYTHON || "python",
        ["-m", "app.services.makerworld_captcha_vision"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      reject(new Error("vision process unavailable"));
      return;
    }

    const stdout = [];
    let outputBytes = 0;
    let settled = false;
    const cleanup = () => clearTimeout(timer);
    const fail = (message, kill = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kill && !child.killed) child.kill("SIGKILL");
      reject(new Error(message));
    };
    const collect = (chunks, chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_VISION_OUTPUT_BYTES) {
        fail("vision process output limit exceeded", true);
        return;
      }
      if (chunks) chunks.push(buffer);
    };
    const timer = setTimeout(() => fail("vision process timed out", true), timeoutMs);

    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(null, chunk));
    child.on("error", () => fail("vision process unavailable"));
    child.stdin.on("error", () => fail("vision process input failed", true));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail("vision process failed");
        return;
      }
      let result;
      try {
        result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        fail("vision process returned invalid JSON");
        return;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        fail("vision process returned invalid JSON");
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    });

    child.stdin.end(JSON.stringify(cleanVisionPayload(payload)));
  });
}

async function safeQuery(root, selector) {
  try {
    return await root?.$(selector);
  } catch {
    return null;
  }
}

async function safeQueryAll(root, selector) {
  try {
    return await root?.$$(selector) || [];
  } catch {
    return [];
  }
}

async function isVisible(handle) {
  if (!handle) return false;
  try {
    const bounds = await handle.boundingBox();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
    return await handle.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return element.isConnected
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) > 0;
    });
  } catch {
    return false;
  }
}

async function elementValue(handle) {
  if (!handle) return "";
  try {
    return String(await handle.evaluate((element, action) => (
      action === "read-value" ? element.value || "" : ""
    ), "read-value") || "").trim();
  } catch {
    return "";
  }
}

async function firstVisible(root, selectors) {
  for (const selector of selectors) {
    const handle = await safeQuery(root, selector);
    if (await isVisible(handle)) return handle;
  }
  return null;
}

async function visibleCandidates(root) {
  for (const selector of CLICK_CANDIDATE_SELECTORS) {
    const handles = await safeQueryAll(root, selector);
    const visible = [];
    for (const handle of handles) {
      if (await isVisible(handle)) visible.push(handle);
      if (visible.length === 6) break;
    }
    if (visible.length >= 2) return visible;
  }
  return [];
}

async function geetestContainers(frame) {
  const handles = await safeQueryAll(frame, GEETEST_CONTAINERS);
  if (handles.length) return handles;
  const handle = await safeQuery(frame, GEETEST_CONTAINERS);
  return handle ? [handle] : [];
}

async function findTurnstileCheckbox(frames, iframe = null) {
  const challengeFrames = [];
  try {
    const contentFrame = await iframe?.contentFrame?.();
    if (contentFrame) challengeFrames.push(contentFrame);
  } catch {}
  for (const frame of frames) {
    let frameUrl = "";
    try {
      frameUrl = String(frame.url?.() || "");
    } catch {
      frameUrl = "";
    }
    if (frameUrl.includes("challenges.cloudflare.com") && !challengeFrames.includes(frame)) {
      challengeFrames.push(frame);
    }
  }
  for (const frame of challengeFrames) {
    const checkbox = await firstVisible(frame, TURNSTILE_CHECKBOX_SELECTORS);
    if (checkbox) return checkbox;
  }
  return null;
}

export async function detectVerificationChallenge(page) {
  const mainFrame = page.mainFrame();
  const frames = [];
  for (const frame of [mainFrame, ...(page.frames() || [])]) {
    if (frame && !frames.includes(frame)) frames.push(frame);
  }

  for (const frame of frames) {
    const response = await safeQuery(frame, TURNSTILE_RESPONSE_SELECTOR);
    if (response && await elementValue(response)) {
      return {
        provider: "turnstile",
        challenge_type: "checkbox",
        frame,
        response,
        checkbox: await findTurnstileCheckbox(frames),
      };
    }

    const containers = await geetestContainers(frame);
    for (const container of containers) {
      if (!await isVisible(container)) continue;
      const handle = await firstVisible(container, SLIDER_HANDLE_SELECTORS);
      const background = await firstVisible(container, SLIDER_BACKGROUND_SELECTORS);
      const piece = await firstVisible(container, SLIDER_PIECE_SELECTORS);
      if (handle && background && piece) {
        return {
          provider: "geetest4",
          challenge_type: "slider",
          frame,
          container,
          handle,
          background,
          piece,
        };
      }

      const target = await firstVisible(container, CLICK_TARGET_SELECTORS);
      const candidates = await visibleCandidates(container);
      if (target && candidates.length >= 2) {
        return {
          provider: "geetest4",
          challenge_type: "icon_click",
          frame,
          container,
          target,
          candidates,
        };
      }
    }

    const iframe = await safeQuery(frame, TURNSTILE_IFRAME_SELECTOR);
    if (await isVisible(iframe)) {
      return {
        provider: "turnstile",
        challenge_type: "checkbox",
        frame,
        iframe,
        response,
        checkbox: await findTurnstileCheckbox(frames, iframe),
      };
    }
  }
  return null;
}

async function screenshotBase64(handle) {
  const buffer = await handle.screenshot({ type: "png" });
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("empty challenge screenshot");
  return buffer.toString("base64");
}

async function defaultFingerprintChallenge(challenge) {
  const hash = createHash("sha256");
  hash.update(`${challenge?.provider || "unknown"}:${challenge?.challenge_type || "unknown"}:`);
  const handles = challenge?.challenge_type === "icon_click"
    ? [challenge.target, ...(challenge.candidates || [])]
    : challenge?.challenge_type === "slider"
      ? [challenge.background, challenge.piece]
      : [challenge?.checkbox, challenge?.iframe].filter(Boolean);
  for (const handle of handles) {
    try {
      const buffer = await handle.screenshot({ type: "png" });
      if (Buffer.isBuffer(buffer)) hash.update(buffer);
    } catch {
      const bounds = await handle?.boundingBox?.().catch(() => null);
      hash.update(JSON.stringify(bounds || null));
    }
  }
  if (challenge?.response) hash.update(await elementValue(challenge.response));
  return hash.digest("hex");
}

async function defaultChallengeComplete(_page, challenge) {
  if (challenge?.provider === "turnstile" && await elementValue(challenge.response)) return true;
  if (challenge?.provider !== "geetest4" || !challenge.frame) return false;
  return Boolean(await firstVisible(challenge.frame, [
    ".geetest_success_radar_tip",
    ".geetest_success",
    "[class*='geetest'][class*='success']",
  ]));
}

async function solveClickChallenge(challenge, visionRequest) {
  const result = await visionRequest({
    mode: "click",
    target_png: await screenshotBase64(challenge.target),
    candidate_pngs: await Promise.all(challenge.candidates.map(screenshotBase64)),
  });
  const candidateIndex = Number(result?.candidate_index);
  if (!result?.ok || !Number.isInteger(candidateIndex) || !challenge.candidates[candidateIndex]) {
    return { acted: false, reason: String(result?.reason || "vision_rejected"), confidence: result?.confidence };
  }
  await challenge.candidates[candidateIndex].click();
  return { acted: true, confidence: result.confidence };
}

async function captureSliderImages(challenge) {
  let backgroundPng;
  try {
    await challenge.piece.evaluate((element, action) => {
      if (action !== "hide") return;
      element.__makerHubPreviousVisibility = element.style.visibility;
      element.style.visibility = "hidden";
    }, "hide");
    backgroundPng = await screenshotBase64(challenge.background);
  } finally {
    await challenge.piece.evaluate((element, action) => {
      if (action !== "restore") return;
      element.style.visibility = element.__makerHubPreviousVisibility || "";
      delete element.__makerHubPreviousVisibility;
    }, "restore").catch(() => undefined);
  }
  return {
    backgroundPng,
    piecePng: await screenshotBase64(challenge.piece),
  };
}

async function solveSliderChallenge(page, challenge, options, visionRequest, deadline) {
  const [handleBox, backgroundBox, images] = await withinDeadline(Promise.all([
    challenge.handle.boundingBox(),
    challenge.background.boundingBox(),
    captureSliderImages(challenge),
  ]), deadline);
  if (!handleBox || !backgroundBox) return { acted: false, reason: "slider_geometry_invalid" };
  const result = await withinDeadline(visionRequest({
    mode: "slider",
    background_png: images.backgroundPng,
    piece_png: images.piecePng,
    geometry: {
      image_width: backgroundBox.width,
      track_width: backgroundBox.width,
      handle_width: handleBox.width,
    },
  }), deadline);
  const distance = Number(result?.distance_css);
  if (!result?.ok || !Number.isFinite(distance) || distance < 0) {
    return { acted: false, reason: String(result?.reason || "vision_rejected"), confidence: result?.confidence };
  }

  const random = options.random || Math.random;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const startX = handleBox.x + (handleBox.width / 2);
  const startY = handleBox.y + (handleBox.height / 2);
  try {
    await withinDeadline(page.mouse.move(startX, startY), deadline);
    await withinDeadline(page.mouse.down(), deadline);
    for (const point of buildDragTrajectory(distance, random)) {
      await withinDeadline(page.mouse.move(startX + point.x, startY + point.y), deadline);
      await withinDeadline(sleep(Math.round(10 + (clampRandom(random) * 25))), deadline);
    }
  } finally {
    await withinDeadline(page.mouse.up(), deadline).catch(() => undefined);
  }
  return { acted: true, confidence: result.confidence };
}

async function turnstileResponseReady(page, challenge, options, deadline) {
  const complete = options.isChallengeComplete || defaultChallengeComplete;
  const waitMs = Math.max(0, Math.min(
    Number(options.turnstileResponseWaitMs ?? DEFAULT_TURNSTILE_WAIT_MS) || 0,
    Math.max(0, deadline - Date.now()),
  ));
  const waitDeadline = Date.now() + waitMs;
  do {
    if (await withinDeadline(complete(page, challenge), deadline)) return true;
    if (Date.now() >= waitDeadline) break;
    await withinDeadline(
      (options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(
        Math.min(POLL_INTERVAL_MS, waitDeadline - Date.now()),
      ),
      deadline,
    );
  } while (Date.now() <= waitDeadline);
  return false;
}

async function waitForOutcome(page, challenge, fingerprint, options, deadline) {
  const detect = options.detectChallenge || detectVerificationChallenge;
  const complete = options.isChallengeComplete || defaultChallengeComplete;
  const fingerprintChallenge = options.fingerprintChallenge || defaultFingerprintChallenge;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const requestedWait = Number(options.postInteractionTimeoutMs ?? DEFAULT_OUTCOME_WAIT_MS);
  const waitDeadline = Math.min(deadline, Date.now() + Math.max(0, requestedWait || 0));

  do {
    if (await withinDeadline(complete(page, challenge), deadline)) {
      return { completed: true, changed: false, challenge };
    }
    const current = await withinDeadline(detect(page), deadline);
    if (!current) return { completed: false, changed: false, challenge: null };
    if (await withinDeadline(complete(page, current), deadline)) {
      return { completed: true, changed: false, challenge: current };
    }
    const currentFingerprint = await withinDeadline(fingerprintChallenge(current), deadline);
    if (currentFingerprint !== fingerprint) {
      return { completed: false, changed: true, challenge: current };
    }
    if (Date.now() >= waitDeadline) break;
    await withinDeadline(sleep(Math.min(POLL_INTERVAL_MS, waitDeadline - Date.now())), deadline);
  } while (Date.now() <= waitDeadline);
  return { completed: false, changed: false, challenge };
}

export async function attemptAutomaticVerification(page, options = {}) {
  const requestedTimeout = Number(options.timeoutMs ?? AUTO_VERIFY_TIMEOUT_MS);
  const timeoutMs = Math.max(1, Math.min(
    Number.isFinite(requestedTimeout) ? requestedTimeout : AUTO_VERIFY_TIMEOUT_MS,
    AUTO_VERIFY_TIMEOUT_MS,
  ));
  const deadline = Date.now() + timeoutMs;
  const detect = options.detectChallenge || detectVerificationChallenge;
  const fingerprintChallenge = options.fingerprintChallenge || defaultFingerprintChallenge;
  const visionRequest = options.visionRequest || ((payload) => runVisionRequest(payload));
  let challenge;
  try {
    challenge = await withinDeadline(detect(page), deadline);
  } catch {
    return sanitizeVerificationResult({
      reason: Date.now() >= deadline ? "timeout" : "discovery_failed",
    });
  }
  if (!challenge) {
    return sanitizeVerificationResult({ completed: true, reason: "no_challenge" });
  }

  const summary = {
    attempted: false,
    completed: false,
    provider: challenge.provider,
    challenge_type: challenge.challenge_type,
    attempts: 0,
    reason: "",
  };
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    if (Date.now() >= deadline) {
      summary.reason = "timeout";
      break;
    }
    let fingerprint;
    try {
      fingerprint = await withinDeadline(fingerprintChallenge(challenge), deadline);
    } catch {
      summary.reason = Date.now() >= deadline ? "timeout" : "fingerprint_failed";
      break;
    }
    summary.attempted = true;
    summary.attempts = attempt;
    let interaction;
    try {
      if (challenge.provider === "turnstile") {
        if (await turnstileResponseReady(page, challenge, options, deadline)) {
          summary.completed = true;
          summary.reason = "completed";
          break;
        }
        if (!challenge.checkbox || !await withinDeadline(isVisible(challenge.checkbox), deadline)) {
          summary.reason = "checkbox_unavailable";
          break;
        }
        await withinDeadline(challenge.checkbox.click(), deadline);
        interaction = { acted: true };
      } else if (challenge.challenge_type === "icon_click") {
        interaction = await withinDeadline(solveClickChallenge(challenge, visionRequest), deadline);
      } else if (challenge.challenge_type === "slider") {
        interaction = await solveSliderChallenge(page, challenge, options, visionRequest, deadline);
      } else {
        interaction = { acted: false, reason: "challenge_unsupported" };
      }
    } catch {
      summary.reason = Date.now() >= deadline ? "timeout" : "interaction_failed";
      break;
    }
    if (Number.isFinite(Number(interaction?.confidence))) {
      summary.confidence = Number(interaction.confidence);
    }
    if (!interaction?.acted) {
      summary.reason = interaction?.reason || "interaction_failed";
      break;
    }

    let outcome;
    try {
      outcome = await waitForOutcome(page, challenge, fingerprint, options, deadline);
    } catch {
      summary.reason = Date.now() >= deadline ? "timeout" : "outcome_failed";
      break;
    }
    if (outcome.completed) {
      summary.completed = true;
      summary.reason = "completed";
      break;
    }
    if (!outcome.changed || !outcome.challenge) {
      summary.reason = "challenge_unchanged";
      break;
    }
    if (attempt === MAX_PROVIDER_ATTEMPTS) {
      summary.reason = "attempts_exhausted";
      break;
    }
    challenge = outcome.challenge;
    summary.provider = challenge.provider;
    summary.challenge_type = challenge.challenge_type;
  }
  return sanitizeVerificationResult(summary);
}
