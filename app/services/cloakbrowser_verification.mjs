import { createHash } from "node:crypto";
import { spawn } from "node:child_process";


export const MAX_PROVIDER_ATTEMPTS = 2;
export const AUTO_VERIFY_TIMEOUT_MS = 50_000;
export const VISION_TIMEOUT_MS = 8_000;

const MAX_VISION_OUTPUT_BYTES = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 1_000;
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
  "[class*='slider'][class*='handle']",
  "[role='slider']",
  "[role='button'][class*='slider']",
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

class VerificationError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new VerificationError("aborted");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function cleanupOperation(promise, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining <= 0) return Promise.reject(new VerificationError("cleanup_failed"));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new VerificationError("cleanup_failed")), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createStageSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const cleanupBudget = Math.min(
    CLEANUP_TIMEOUT_MS,
    Math.max(1, Math.floor(timeoutMs * 0.25)),
  );
  const actionDeadline = startedAt + Math.max(1, timeoutMs - cleanupBudget);
  const hardDeadline = startedAt + timeoutMs;
  const onExternalAbort = () => controller.abort(externalSignal.reason || new VerificationError("aborted"));
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new VerificationError("timeout"));
  }, Math.max(0, actionDeadline - Date.now()));
  return {
    signal: controller.signal,
    actionDeadline,
    hardDeadline,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
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
  const signal = options.signal;
  const requestedTimeout = Number(options.timeoutMs || VISION_TIMEOUT_MS);
  const timeoutMs = Math.max(1, Math.min(
    Number.isFinite(requestedTimeout) ? requestedTimeout : VISION_TIMEOUT_MS,
    VISION_TIMEOUT_MS,
  ));

  if (signal?.aborted) return Promise.reject(abortError(signal));
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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const onAbort = () => fail("vision process aborted", true);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message, kill = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kill && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      reject(new Error(message));
    };
    const collect = (stream, chunks, chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stdout") stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (stdoutBytes > MAX_VISION_OUTPUT_BYTES || stderrBytes > MAX_VISION_OUTPUT_BYTES) {
        fail("vision process output limit exceeded", true);
        return;
      }
      if (chunks) chunks.push(buffer);
    };
    timer = setTimeout(() => fail("vision process timed out", true), timeoutMs);

    child.stdout.on("data", (chunk) => collect("stdout", stdout, chunk));
    child.stderr.on("data", (chunk) => collect("stderr", null, chunk));
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

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child.stdin.end(JSON.stringify(cleanVisionPayload(payload)));
    } catch {
      fail("vision process input failed", true);
    }
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

async function isPlausibleSliderHandle(handle, background) {
  try {
    const [handleBox, backgroundBox] = await Promise.all([
      handle.boundingBox(),
      background.boundingBox(),
    ]);
    if (!handleBox || !backgroundBox) return false;
    const handleCenterY = handleBox.y + (handleBox.height / 2);
    const maximumWidth = Math.min(96, backgroundBox.width * 0.4);
    return handleBox.width <= maximumWidth
      && handleBox.height <= Math.max(80, backgroundBox.height)
      && handleBox.x <= backgroundBox.x + (backgroundBox.width * 0.35)
      && handleBox.x + handleBox.width >= backgroundBox.x - (backgroundBox.width * 0.1)
      && handleCenterY >= backgroundBox.y - (backgroundBox.height * 0.25)
      && handleCenterY <= backgroundBox.y + (backgroundBox.height * 1.25);
  } catch {
    return false;
  }
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
      const background = await firstVisible(container, SLIDER_BACKGROUND_SELECTORS);
      const piece = await firstVisible(container, SLIDER_PIECE_SELECTORS);
      const handle = background ? await firstVisible(container, SLIDER_HANDLE_SELECTORS) : null;
      if (handle && background && piece && await isPlausibleSliderHandle(handle, background)) {
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

async function screenshotBuffer(handle, signal) {
  throwIfAborted(signal);
  const output = await abortable(handle.screenshot({ type: "png" }), signal);
  throwIfAborted(signal);
  const buffer = Buffer.isBuffer(output)
    ? output
    : output instanceof Uint8Array
      ? Buffer.from(output)
      : null;
  if (!buffer?.length) throw new VerificationError("empty_screenshot");
  return buffer;
}

function pngPixelWidth(buffer) {
  const signature = "89504e470d0a1a0a";
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < 24
    || buffer.subarray(0, 8).toString("hex") !== signature
    || buffer.readUInt32BE(8) !== 13
    || buffer.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new VerificationError("image_format_invalid");
  }
  const width = buffer.readUInt32BE(16);
  if (width < 1 || width > 32768) throw new VerificationError("image_width_invalid");
  return width;
}

async function stableElementIdentity(handle, signal) {
  throwIfAborted(signal);
  let identity;
  try {
    identity = await abortable(handle.evaluate((element, action) => {
      if (action !== "fingerprint") return null;
      const media = element.matches?.("img, canvas, svg")
        ? element
        : element.querySelector?.("img, canvas, svg");
      if (!media) {
        const background = window.getComputedStyle(element).backgroundImage;
        const fallback = {
          kind: "element",
          challenge: element.getAttribute?.("data-challenge") || "",
          source: element.getAttribute?.("data-src") || element.getAttribute?.("data-original") || "",
          background: background === "none" ? "" : background,
          text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
        };
        return fallback.challenge || fallback.source || fallback.background || fallback.text
          ? fallback
          : null;
      }
      const tag = String(media.tagName || "").toLowerCase();
      if (tag === "img") {
        return {
          kind: "img",
          source: media.currentSrc || media.getAttribute("src") || "",
          sourceSet: media.getAttribute("srcset") || "",
          width: Number(media.naturalWidth || 0),
          height: Number(media.naturalHeight || 0),
        };
      }
      if (tag === "canvas") {
        return {
          kind: "canvas",
          content: media.toDataURL("image/png"),
          width: Number(media.width || 0),
          height: Number(media.height || 0),
        };
      }
      const clone = media.cloneNode(true);
      for (const node of [clone, ...clone.querySelectorAll("*")]) {
        node.removeAttribute("class");
        node.removeAttribute("style");
        node.removeAttribute("aria-selected");
        node.removeAttribute("aria-checked");
      }
      return { kind: "svg", content: clone.outerHTML };
    }, "fingerprint"), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  throwIfAborted(signal);
  return identity;
}

async function hidePieceAndCaptureBackground(challenge, stage) {
  const { signal, actionDeadline, hardDeadline } = stage;
  const stateId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let pieceState;
  try {
    throwIfAborted(signal);
    pieceState = await abortable(challenge.piece.evaluate((element, state) => {
      if (state?.action !== "hide" || Date.now() >= state.deadline) {
        return { applied: false };
      }
      const previous = element.__makerHubVerificationPieceState;
      if (previous) {
        clearTimeout(previous.timer);
        if (previous.value) {
          element.style.setProperty("visibility", previous.value, previous.priority);
        } else {
          element.style.removeProperty("visibility");
        }
      }
      const original = {
        id: state.id,
        value: element.style.getPropertyValue("visibility"),
        priority: element.style.getPropertyPriority("visibility"),
      };
      const restore = () => {
        const current = element.__makerHubVerificationPieceState;
        if (!current || current.id !== state.id) return;
        if (current.value) {
          element.style.setProperty("visibility", current.value, current.priority);
        } else {
          element.style.removeProperty("visibility");
        }
        delete element.__makerHubVerificationPieceState;
      };
      element.style.setProperty("visibility", "hidden", "important");
      element.__makerHubVerificationPieceState = {
        ...original,
        timer: setTimeout(restore, Math.max(0, state.restoreAt - Date.now())),
      };
      return { applied: true, ...original };
    }, {
      action: "hide",
      id: stateId,
      deadline: actionDeadline,
      restoreAt: actionDeadline,
    }), signal);
    if (!pieceState?.applied) {
      throwIfAborted(signal);
      throw new VerificationError("piece_hide_expired");
    }
    return await screenshotBuffer(challenge.background, signal);
  } finally {
    if (pieceState?.applied) {
      const restore = {
        action: "restore",
        id: pieceState.id,
        value: String(pieceState.value || ""),
        priority: String(pieceState.priority || ""),
      };
      try {
        const restored = await cleanupOperation(challenge.piece.evaluate((element, state) => {
          if (state?.action !== "restore") return false;
          const current = element.__makerHubVerificationPieceState;
          if (current?.id === state.id) {
            clearTimeout(current.timer);
            if (state.value) {
              element.style.setProperty("visibility", state.value, state.priority);
            } else {
              element.style.removeProperty("visibility");
            }
            delete element.__makerHubVerificationPieceState;
          }
          return true;
        }, restore), hardDeadline);
        if (restored !== true) throw new Error("piece restore rejected");
      } catch {
        throw new VerificationError("piece_restore_failed");
      }
    }
  }
}

async function defaultFingerprintChallenge(challenge, stage = {}) {
  const { signal } = stage;
  const hash = createHash("sha256");
  hash.update(`${challenge?.provider || "unknown"}:${challenge?.challenge_type || "unknown"}:`);
  if (challenge?.challenge_type === "slider") {
    hash.update(await hidePieceAndCaptureBackground(challenge, stage));
  } else {
    const handles = challenge?.challenge_type === "icon_click"
      ? [challenge.target, ...(challenge.candidates || [])]
      : [challenge?.checkbox, challenge?.iframe].filter(Boolean);
    for (const handle of handles) {
      const identity = await stableElementIdentity(handle, signal);
      if (identity) hash.update(JSON.stringify(identity));
      else hash.update(await screenshotBuffer(handle, signal));
    }
  }
  if (challenge?.response) {
    hash.update(await abortable(elementValue(challenge.response), signal));
  }
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

async function guardedElementClick(handle, stage) {
  const { signal, actionDeadline } = stage;
  throwIfAborted(signal);
  const clicked = await abortable(handle.evaluate((element, state) => {
    if (state?.action !== "click" || Date.now() >= state.deadline) return false;
    element.click();
    return true;
  }, { action: "click", deadline: actionDeadline }), signal);
  throwIfAborted(signal);
  if (clicked !== true) throw new VerificationError("click_expired");
}

async function solveClickChallenge(challenge, visionRequest, stage) {
  const { signal } = stage;
  const targetPng = await screenshotBuffer(challenge.target, signal);
  const candidatePngs = await Promise.all(
    challenge.candidates.map((candidate) => screenshotBuffer(candidate, signal)),
  );
  const result = await abortable(visionRequest({
    mode: "click",
    target_png: targetPng.toString("base64"),
    candidate_pngs: candidatePngs.map((buffer) => buffer.toString("base64")),
  }, { signal }), signal);
  const candidateIndex = Number(result?.candidate_index);
  if (!result?.ok || !Number.isInteger(candidateIndex) || !challenge.candidates[candidateIndex]) {
    return { acted: false, reason: String(result?.reason || "vision_rejected"), confidence: result?.confidence };
  }
  await guardedElementClick(challenge.candidates[candidateIndex], stage);
  return { acted: true, confidence: result.confidence };
}

async function captureSliderImages(challenge, stage) {
  const { signal } = stage;
  const backgroundBuffer = await hidePieceAndCaptureBackground(challenge, stage);
  const pieceBuffer = await screenshotBuffer(challenge.piece, signal);
  return {
    backgroundBuffer,
    pieceBuffer,
  };
}

async function createMouseDriver(page, stage) {
  const { signal, actionDeadline, hardDeadline } = stage;
  const sessionPromise = page.createCDPSession();
  void sessionPromise.then((lateSession) => {
    if (signal.aborted) return lateSession.detach().catch(() => undefined);
    return undefined;
  }, () => undefined);
  const session = await abortable(sessionPromise, signal);
  let x = 0;
  let y = 0;
  let mouseDown = false;

  const send = async (params, cleanup = false) => {
    const deadline = cleanup ? hardDeadline : actionDeadline;
    if (Date.now() >= deadline) throw new VerificationError(cleanup ? "cleanup_failed" : "timeout");
    const command = session.send(
      "Input.dispatchMouseEvent",
      params,
      { timeout: Math.max(1, deadline - Date.now()) },
    );
    return cleanup
      ? await cleanupOperation(command, deadline)
      : await abortable(command, signal);
  };

  return {
    async move(nextX, nextY) {
      throwIfAborted(signal);
      x = nextX;
      y = nextY;
      await send({
        type: "mouseMoved",
        x,
        y,
        buttons: mouseDown ? 1 : 0,
        button: mouseDown ? "left" : "none",
      });
    },
    async down() {
      throwIfAborted(signal);
      mouseDown = true;
      await send({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    },
    async up(cleanup = false) {
      if (!mouseDown) return;
      await send({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, cleanup);
      mouseDown = false;
    },
    async close() {
      if (mouseDown) await this.up(true).catch(() => undefined);
      await cleanupOperation(session.detach(), hardDeadline).catch(() => undefined);
    },
  };
}

async function solveSliderChallenge(page, challenge, options, visionRequest, stage) {
  const { signal } = stage;
  const settled = await Promise.allSettled([
    abortable(challenge.handle.boundingBox(), signal),
    abortable(challenge.background.boundingBox(), signal),
    captureSliderImages(challenge, stage),
  ]);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const [handleBox, backgroundBox, images] = settled.map((result) => result.value);
  if (!handleBox || !backgroundBox) return { acted: false, reason: "slider_geometry_invalid" };
  const result = await abortable(visionRequest({
    mode: "slider",
    background_png: images.backgroundBuffer.toString("base64"),
    piece_png: images.pieceBuffer.toString("base64"),
    geometry: {
      image_width: pngPixelWidth(images.backgroundBuffer),
      track_width: backgroundBox.width,
      handle_width: handleBox.width,
    },
  }, { signal }), signal);
  const distance = Number(result?.distance_css);
  if (!result?.ok || !Number.isFinite(distance) || distance < 0) {
    return { acted: false, reason: String(result?.reason || "vision_rejected"), confidence: result?.confidence };
  }

  const random = options.random || Math.random;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const startX = handleBox.x + (handleBox.width / 2);
  const startY = handleBox.y + (handleBox.height / 2);
  const mouse = await createMouseDriver(page, stage);
  try {
    await mouse.move(startX, startY);
    await mouse.down();
    for (const point of buildDragTrajectory(distance, random)) {
      throwIfAborted(signal);
      await mouse.move(startX + point.x, startY + point.y);
      await abortable(sleep(Math.round(10 + (clampRandom(random) * 25))), signal);
    }
  } finally {
    await mouse.up(signal.aborted).catch(() => undefined);
    await mouse.close();
  }
  return { acted: true, confidence: result.confidence };
}

async function turnstileResponseReady(page, challenge, options, signal) {
  const complete = options.isChallengeComplete || defaultChallengeComplete;
  const waitMs = Math.max(0, Math.min(
    Number(options.turnstileResponseWaitMs ?? DEFAULT_TURNSTILE_WAIT_MS) || 0,
    AUTO_VERIFY_TIMEOUT_MS,
  ));
  const waitDeadline = Date.now() + waitMs;
  do {
    if (await abortable(complete(page, challenge), signal)) return true;
    if (Date.now() >= waitDeadline) break;
    await abortable(
      (options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(
        Math.min(POLL_INTERVAL_MS, waitDeadline - Date.now()),
      ),
      signal,
    );
  } while (Date.now() <= waitDeadline);
  return false;
}

async function waitForOutcome(page, challenge, fingerprint, options, stage) {
  const { signal } = stage;
  const detect = options.detectChallenge || detectVerificationChallenge;
  const complete = options.isChallengeComplete || defaultChallengeComplete;
  const fingerprintChallenge = options.fingerprintChallenge || defaultFingerprintChallenge;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const requestedWait = Number(options.postInteractionTimeoutMs ?? DEFAULT_OUTCOME_WAIT_MS);
  const waitDeadline = Date.now() + Math.max(0, requestedWait || 0);

  do {
    if (await abortable(complete(page, challenge), signal)) {
      return { completed: true, changed: false, challenge };
    }
    const current = await abortable(detect(page), signal);
    if (!current) return { completed: false, changed: false, challenge: null };
    if (await abortable(complete(page, current), signal)) {
      return { completed: true, changed: false, challenge: current };
    }
    const currentFingerprint = await abortable(fingerprintChallenge(current, stage), signal);
    if (currentFingerprint !== fingerprint) {
      return { completed: false, changed: true, challenge: current };
    }
    if (Date.now() >= waitDeadline) break;
    await abortable(sleep(Math.min(POLL_INTERVAL_MS, waitDeadline - Date.now())), signal);
  } while (Date.now() <= waitDeadline);
  return { completed: false, changed: false, challenge };
}

function failureReason(error, signal, fallback) {
  if (signal.aborted) return String(signal.reason?.reason || "aborted");
  return String(error?.reason || fallback);
}

async function attemptWithinStage(page, options, stage) {
  const { signal } = stage;
  const detect = options.detectChallenge || detectVerificationChallenge;
  const fingerprintChallenge = options.fingerprintChallenge || defaultFingerprintChallenge;
  const visionRequest = options.visionRequest
    || ((payload, requestOptions) => runVisionRequest(payload, requestOptions));
  let challenge;
  try {
    challenge = await abortable(detect(page), signal);
  } catch (error) {
    return sanitizeVerificationResult({
      reason: failureReason(error, signal, "discovery_failed"),
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
    if (signal.aborted) {
      summary.reason = failureReason(null, signal, "aborted");
      break;
    }
    let fingerprint;
    let interaction;
    try {
      if (challenge.provider === "turnstile") {
        if (await turnstileResponseReady(page, challenge, options, signal)) {
          summary.completed = true;
          summary.reason = "completed";
          break;
        }
        fingerprint = await abortable(fingerprintChallenge(challenge, stage), signal);
        if (!challenge.checkbox || !await abortable(isVisible(challenge.checkbox), signal)) {
          summary.reason = "checkbox_unavailable";
          break;
        }
        summary.attempted = true;
        summary.attempts = attempt;
        await guardedElementClick(challenge.checkbox, stage);
        interaction = { acted: true };
      } else if (challenge.challenge_type === "icon_click") {
        fingerprint = await abortable(fingerprintChallenge(challenge, stage), signal);
        summary.attempted = true;
        summary.attempts = attempt;
        interaction = await solveClickChallenge(challenge, visionRequest, stage);
      } else if (challenge.challenge_type === "slider") {
        fingerprint = await abortable(fingerprintChallenge(challenge, stage), signal);
        summary.attempted = true;
        summary.attempts = attempt;
        interaction = await solveSliderChallenge(page, challenge, options, visionRequest, stage);
      } else {
        interaction = { acted: false, reason: "challenge_unsupported" };
      }
    } catch (error) {
      summary.reason = failureReason(error, signal, "interaction_failed");
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
      outcome = await waitForOutcome(page, challenge, fingerprint, options, stage);
    } catch (error) {
      summary.reason = failureReason(error, signal, "outcome_failed");
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

export async function attemptAutomaticVerification(page, options = {}) {
  const requestedTimeout = Number(options.timeoutMs ?? AUTO_VERIFY_TIMEOUT_MS);
  const timeoutMs = Math.max(1, Math.min(
    Number.isFinite(requestedTimeout) ? requestedTimeout : AUTO_VERIFY_TIMEOUT_MS,
    AUTO_VERIFY_TIMEOUT_MS,
  ));
  const stage = createStageSignal(timeoutMs, options.signal);
  try {
    return await attemptWithinStage(page, options, stage);
  } finally {
    stage.cleanup();
  }
}
