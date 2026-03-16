/**
 * Smart Model Switch plugin (Option A) — with context-aware model selection.
 *
 * Core features:
 * - On gateway start: probe all configured models, build and persist "available" list.
 * - before_model_resolve: pick from available list (prefer configured preferProvider).
 * - agent_end failure: remove that model from available list immediately.
 * - Periodic re-probe (default 1 hour) refreshes the available list.
 *
 * Context-aware enhancement:
 * - Available list stores contextWindow size per model.
 * - agent_end detects context overflow errors and marks the session.
 * - before_model_resolve for marked sessions picks the model with the
 *   LARGEST context window from the available list, ignoring preferProvider.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ID = "smart-model-switch";
const AVAILABLE_LIST_FILENAME = "available-models.json";
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_BATCH_SIZE = 3;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [smart-model-switch] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [smart-model-switch] ${msg}`);
}

// ── Path helpers ─────────────────────────────────────────────

function getStateDir() {
  const override =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.join(os.homedir(), override);
  }
  return path.join(os.homedir(), ".openclaw");
}

function getConfigPath() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.join(os.homedir(), explicit);
  }
  return path.join(getStateDir(), "openclaw.json");
}

function getPluginStateDir() {
  return path.join(getStateDir(), "plugins", PLUGIN_ID);
}

function getAvailableListPath() {
  return path.join(getPluginStateDir(), AVAILABLE_LIST_FILENAME);
}

// ── Context overflow detection ───────────────────────────────
// Mirrors the patterns in OpenClaw's isLikelyContextOverflowError

function isContextOverflowError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("context_overflow") ||
    lower.includes("compaction_failure") ||
    lower.includes("request_too_large") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("exceeds model context window") ||
    lower.includes("model token limit") ||
    lower.includes("context window exceeded") ||
    lower.includes("context_window_exceeded") ||
    lower.includes("model_context_window_exceeded") ||
    lower.includes("context overflow") ||
    /context.*(?:too large|exceed|over|limit)/.test(lower) ||
    /prompt.*(?:too large|too long|exceed)/.test(lower) ||
    errorMessage.includes("上下文过长") ||
    errorMessage.includes("上下文超出") ||
    errorMessage.includes("上下文长度超") ||
    errorMessage.includes("超出最大上下文") ||
    errorMessage.includes("请压缩上下文")
  );
}

// ── Probe URL construction ───────────────────────────────────

function getOpenAiProbeUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function getAnthropicProbeUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/messages`;
}

// ── Probing ──────────────────────────────────────────────────

function isProbeSuccess(status) {
  return (status >= 200 && status < 300) || status === 429;
}

async function probeOpenAi(baseUrl, apiKey, modelId) {
  const url = getOpenAiProbeUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (isProbeSuccess(res.status)) return true;
    const text = await res.text().catch(() => "");
    log(`  probe FAIL ${res.status} for ${modelId} at ${url}: ${text.slice(0, 120)}`);
    return false;
  } catch (e) {
    clearTimeout(timer);
    log(`  probe ERROR for ${modelId} at ${url}: ${e?.message ?? e}`);
    return false;
  }
}

async function probeAnthropic(baseUrl, apiKey, modelId) {
  const url = getAnthropicProbeUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (isProbeSuccess(res.status)) return true;
    const text = await res.text().catch(() => "");
    log(`  probe FAIL ${res.status} for ${modelId} at ${url}: ${text.slice(0, 120)}`);
    return false;
  } catch (e) {
    clearTimeout(timer);
    log(`  probe ERROR for ${modelId} at ${url}: ${e?.message ?? e}`);
    return false;
  }
}

async function probeModel(candidate) {
  const { baseUrl, apiKey, modelId, apiFormat } = candidate;
  if (apiFormat === "anthropic-messages") {
    return probeAnthropic(baseUrl, apiKey, modelId);
  }
  return probeOpenAi(baseUrl, apiKey, modelId);
}

// ── Candidate collection ─────────────────────────────────────

function getCandidateModelsFromPluginConfig(pluginConfig) {
  const providers = pluginConfig?.providers ?? {};
  const out = [];
  for (const [provider, entry] of Object.entries(providers)) {
    if (!entry?.baseUrl || !entry?.apiKey || !Array.isArray(entry.models))
      continue;
    const apiFormat = entry.api || "openai-completions";
    for (const m of entry.models) {
      const id = typeof m === "string" ? m : m?.id;
      const contextWindow =
        typeof m === "object" ? m?.contextWindow ?? 0 : 0;
      if (id)
        out.push({
          provider,
          modelId: id,
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          apiFormat,
          contextWindow,
        });
    }
  }
  return out;
}

function getCandidateModelsFromOpenClawConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    const config = JSON.parse(raw);
    const providers = config?.models?.providers ?? {};
    const out = [];
    for (const [provider, entry] of Object.entries(providers)) {
      const baseUrl = entry?.baseUrl?.trim();
      const apiKey =
        typeof entry?.apiKey === "string" ? entry.apiKey.trim() : "";
      if (!baseUrl || !apiKey) continue;
      const apiFormat = entry?.api || "openai-completions";
      const models = Array.isArray(entry.models) ? entry.models : [];
      for (const m of models) {
        const id = typeof m === "string" ? m : m?.id;
        const contextWindow =
          typeof m === "object" ? m?.contextWindow ?? 0 : 0;
        if (id)
          out.push({
            provider,
            modelId: id,
            baseUrl,
            apiKey,
            apiFormat,
            contextWindow,
          });
      }
    }
    return out;
  } catch (e) {
    logError(`Failed to read openclaw.json: ${e?.message}`);
    return [];
  }
}

function getCandidateModels(pluginConfig) {
  const fromPlugin = getCandidateModelsFromPluginConfig(pluginConfig);
  if (fromPlugin.length > 0) return fromPlugin;
  return getCandidateModelsFromOpenClawConfig();
}

// ── Build contextWindow lookup from candidates ───────────────

function buildContextWindowMap(pluginConfig) {
  const candidates = getCandidateModels(pluginConfig);
  const map = {};
  for (const c of candidates) {
    const ref = `${c.provider}/${c.modelId}`;
    map[ref] = c.contextWindow || 0;
  }
  return map;
}

// ── Probe all ────────────────────────────────────────────────

async function probeAll(pluginConfig) {
  const candidates = getCandidateModels(pluginConfig);
  log(
    `Probing ${candidates.length} candidate models (batch size ${PROBE_BATCH_SIZE})...`,
  );
  const available = [];
  for (let i = 0; i < candidates.length; i += PROBE_BATCH_SIZE) {
    const batch = candidates.slice(i, i + PROBE_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (c) => {
        const ok = await probeModel(c);
        return {
          ref: `${c.provider}/${c.modelId}`,
          contextWindow: c.contextWindow || 0,
          ok,
        };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.ok) {
        available.push({
          ref: r.value.ref,
          contextWindow: r.value.contextWindow,
        });
        log(`  OK: ${r.value.ref} (ctx=${r.value.contextWindow})`);
      } else if (r.status === "fulfilled") {
        log(`  UNAVAILABLE: ${r.value.ref}`);
      } else {
        log(`  ERROR: ${r.reason}`);
      }
    }
  }
  log(
    `Probe complete. ${available.length}/${candidates.length} models available.`,
  );
  return available;
}

// ── Persistence ──────────────────────────────────────────────
// available is now Array<{ ref: string, contextWindow: number }>

function loadAvailableList() {
  try {
    const raw = fs.readFileSync(getAvailableListPath(), "utf8");
    const data = JSON.parse(raw);
    let available = Array.isArray(data.available) ? data.available : [];
    // Migrate from old string[] format
    available = available.map((entry) =>
      typeof entry === "string" ? { ref: entry, contextWindow: 0 } : entry,
    );
    return {
      available,
      lastProbeAt:
        typeof data.lastProbeAt === "number" ? data.lastProbeAt : undefined,
    };
  } catch {
    return { available: [], lastProbeAt: undefined };
  }
}

function saveAvailableList(available, lastProbeAt = Date.now()) {
  const dir = getPluginStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getAvailableListPath(),
    JSON.stringify({ available, lastProbeAt }, null, 2),
    "utf8",
  );
}

// ── Config sync (Option A) ──────────────────────────────────

function syncProvidersToOpenClawConfig(pluginConfig) {
  const providers = pluginConfig?.providers ?? {};
  if (Object.keys(providers).length === 0) return;

  const configPath = getConfigPath();
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return;
  }

  if (!config.models) config.models = {};
  if (!config.models.providers) config.models.providers = {};

  for (const [providerId, entry] of Object.entries(providers)) {
    if (!entry?.baseUrl || !entry?.apiKey || !Array.isArray(entry.models))
      continue;
    const existing = config.models.providers[providerId] ?? {};
    config.models.providers[providerId] = {
      ...existing,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      models: entry.models.map((m) =>
        typeof m === "string"
          ? { id: m, name: m }
          : { id: m.id, name: m.name ?? m.id },
      ),
    };
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    log("Synced plugin providers to openclaw.json");
  } catch (e) {
    logError(`Failed to write openclaw.json: ${e?.message}`);
  }
}

// ── Model list helpers ───────────────────────────────────────

function removeFromAvailableList(ref) {
  const { available } = loadAvailableList();
  const next = available.filter((e) => e.ref !== ref);
  if (next.length !== available.length) {
    saveAvailableList(next);
    log(`Removed ${ref} from available list. Remaining: ${next.length}`);
  }
}

/**
 * Normal selection: prefer preferProvider, then first available.
 */
function pickNormal(available, preferProvider = "minimax") {
  if (available.length === 0) return null;
  const preferred = available.find((e) =>
    e.ref.startsWith(`${preferProvider}/`),
  );
  if (preferred) return preferred.ref;
  return available[0].ref;
}

/**
 * Context-overflow selection: pick the model with the LARGEST
 * context window from the available list.
 */
function pickLargestContext(available) {
  if (available.length === 0) return null;
  const sorted = [...available].sort(
    (a, b) => (b.contextWindow || 0) - (a.contextWindow || 0),
  );
  return sorted[0].ref;
}

/**
 * Split a "provider/modelId" ref. modelId may contain slashes.
 */
function splitRef(ref) {
  const idx = ref.indexOf("/");
  if (idx < 0) return { provider: ref, modelId: ref };
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

// ── Plugin entry ─────────────────────────────────────────────

export default function smartModelSwitchPlugin(api) {
  if (!api?.on) return;

  const pluginConfig = api?.pluginConfig ?? {};
  let probeTimer = null;
  // session → model ref used for that run
  const sessionToModel = new Map();
  // session keys that experienced context overflow — need large context next time
  const sessionsNeedLargeContext = new Set();

  log(
    "Plugin loaded. preferProvider=" +
      (pluginConfig.preferProvider ?? "minimax"),
  );

  api.on("gateway_start", async () => {
    log("gateway_start: beginning initial probe...");
    syncProvidersToOpenClawConfig(pluginConfig);
    const available = await probeAll(pluginConfig);
    saveAvailableList(available);

    const intervalHours = Number(pluginConfig?.probeIntervalHours) || 1;
    const intervalMs = intervalHours * 60 * 60 * 1000;
    log(`Scheduling re-probe every ${intervalHours}h (${intervalMs}ms)`);
    probeTimer = setInterval(async () => {
      log("Periodic re-probe starting...");
      const next = await probeAll(pluginConfig);
      saveAvailableList(next);
    }, intervalMs);
  });

  api.on("gateway_stop", () => {
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    log("gateway_stop: cleaned up probe timer");
  });

  api.on("before_model_resolve", (_event, ctx) => {
    const { available } = loadAvailableList();
    if (available.length === 0) {
      log("before_model_resolve: available list empty, not overriding");
      return undefined;
    }

    const sessionKey = ctx?.sessionKey;
    const needsLargeCtx =
      sessionKey && sessionsNeedLargeContext.has(sessionKey);

    let ref;
    if (needsLargeCtx) {
      ref = pickLargestContext(available);
      log(
        `before_model_resolve: session ${sessionKey} needs LARGE context → ${ref}`,
      );
    } else {
      const prefer = pluginConfig?.preferProvider || "minimax";
      ref = pickNormal(available, prefer);
      log(
        `before_model_resolve: selected ${ref} (session=${sessionKey ?? "?"})`,
      );
    }

    if (!ref) return undefined;

    const { provider, modelId } = splitRef(ref);
    if (sessionKey) sessionToModel.set(sessionKey, ref);
    return { providerOverride: provider, modelOverride: modelId };
  });

  api.on("agent_end", (event, ctx) => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;
    const ref = sessionToModel.get(sessionKey);
    sessionToModel.delete(sessionKey);

    if (event?.success === false) {
      const errorMsg = event.error ?? "";
      const isOverflow = isContextOverflowError(errorMsg);

      if (isOverflow) {
        sessionsNeedLargeContext.add(sessionKey);
        log(
          `agent_end: session ${sessionKey} hit CONTEXT OVERFLOW → marked for large context. error: ${errorMsg.slice(0, 100)}`,
        );
        // Don't remove the model from available list for context overflow
        // — the model itself works fine, it's the session that's too big.
      } else if (ref) {
        log(
          `agent_end: session ${sessionKey} FAILED with ${ref}, error: ${errorMsg.slice(0, 100)}`,
        );
        removeFromAvailableList(ref);
      }
    } else if (event?.success) {
      // On success, clear the large-context flag if it was set
      if (sessionsNeedLargeContext.has(sessionKey)) {
        sessionsNeedLargeContext.delete(sessionKey);
        log(
          `agent_end: session ${sessionKey} succeeded → cleared large-context flag`,
        );
      }
    }
  });

  return {};
}
