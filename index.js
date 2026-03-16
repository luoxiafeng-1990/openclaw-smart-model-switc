/**
 * Smart Model Switch plugin — proactive probing + intelligent rotation.
 *
 * Key behavior:
 * - On gateway start: probe all models, build persisted "available" list.
 * - First 30 min: re-probe every 1 minute (fast stabilization).
 * - After 30 min: re-probe every N hours (default 1h).
 * - before_model_resolve fires for EACH fallback retry attempt.
 *   The plugin tracks per-session retries and picks a DIFFERENT model each time.
 * - Models that fail during actual use get an escalating cooldown (1→5→15 min).
 * - Context overflow → session marked for largest-context model.
 * - After each probe, syncs the available list into agents.defaults.model.fallbacks
 *   so OpenClaw's native fallback chain has enough retry slots.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ID = "smart-model-switch";
const AVAILABLE_LIST_FILENAME = "available-models.json";
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_BATCH_SIZE = 3;

const FAST_PROBE_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const FAST_PROBE_INTERVAL_MS = 60 * 1000; // 1 minute

// Cooldown escalation: 1st fail → 1min, 2nd → 5min, 3rd+ → 15min
const COOLDOWN_STEPS_MS = [60_000, 300_000, 900_000];

// How long before we consider a before_model_resolve call a "new message"
// vs a retry within the same fallback chain
const SESSION_RETRY_WINDOW_MS = 120_000;

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

function isRateLimitError(errorMessage) {
	if (!errorMessage) return false;
	const lower = errorMessage.toLowerCase();
	return (
		lower.includes("rate limit") ||
		lower.includes("rate_limit") ||
		lower.includes("ratelimit") ||
		lower.includes("too many requests") ||
		lower.includes("429") ||
		lower.includes("quota exceeded") ||
		lower.includes("请求过于频繁") ||
		lower.includes("频率限制")
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
		log(`  probe FAIL ${res.status} ${modelId}: ${text.slice(0, 120)}`);
		return false;
	} catch (e) {
		clearTimeout(timer);
		log(`  probe ERROR ${modelId}: ${e?.message ?? e}`);
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
		log(`  probe FAIL ${res.status} ${modelId}: ${text.slice(0, 120)}`);
		return false;
	} catch (e) {
		clearTimeout(timer);
		log(`  probe ERROR ${modelId}: ${e?.message ?? e}`);
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
				typeof m === "object" ? (m?.contextWindow ?? 0) : 0;
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
					typeof m === "object" ? (m?.contextWindow ?? 0) : 0;
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

// ── Probe all ────────────────────────────────────────────────

async function probeAll(pluginConfig) {
	const candidates = getCandidateModels(pluginConfig);
	log(
		`Probing ${candidates.length} models (batch=${PROBE_BATCH_SIZE})...`,
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
				log(`  ✓ ${r.value.ref} (ctx=${r.value.contextWindow})`);
			} else if (r.status === "fulfilled") {
				log(`  ✗ ${r.value.ref}`);
			}
		}
	}
	log(
		`Probe done: ${available.length}/${candidates.length} available.`,
	);
	return available;
}

// ── Persistence ──────────────────────────────────────────────

function loadAvailableList() {
	try {
		const raw = fs.readFileSync(getAvailableListPath(), "utf8");
		const data = JSON.parse(raw);
		let available = Array.isArray(data.available) ? data.available : [];
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

// ── Sync fallback chain to openclaw.json ─────────────────────
// Ensures OpenClaw's native fallback has enough retry slots for all
// available models, so before_model_resolve fires enough times.

function syncFallbackChain(available) {
	if (available.length === 0) return;
	const configPath = getConfigPath();
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const config = JSON.parse(raw);

		let changed = false;

		// Sync agents.defaults.model.fallbacks
		const defaults = config?.agents?.defaults?.model;
		if (defaults) {
			const primary = defaults.primary || "";
			const refs = available.map((e) => e.ref).filter((r) => r !== primary);
			const cur = defaults.fallbacks || [];
			if (refs.length !== cur.length || !refs.every((r, i) => r === cur[i])) {
				defaults.fallbacks = refs;
				changed = true;
				log(`Synced defaults fallbacks: ${refs.length} models (primary: ${primary})`);
			}
		}

		// Sync each agent in agents.list[*].model.fallbacks
		const agentList = config?.agents?.list;
		if (Array.isArray(agentList)) {
			for (const agent of agentList) {
				const model = agent?.model;
				if (!model) continue;
				const primary = model.primary || defaults?.primary || "";
				const refs = available.map((e) => e.ref).filter((r) => r !== primary);
				const cur = model.fallbacks || [];
				if (refs.length !== cur.length || !refs.every((r, i) => r === cur[i])) {
					model.fallbacks = refs;
					changed = true;
					log(`Synced agent "${agent.id}" fallbacks: ${refs.length} models`);
				}
			}
		}

		if (changed) {
			fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
		}
	} catch (e) {
		logError(`Failed to sync fallback chain: ${e?.message}`);
	}
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

// ── Model selection helpers ──────────────────────────────────

function splitRef(ref) {
	const idx = ref.indexOf("/");
	if (idx < 0) return { provider: ref, modelId: ref };
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/**
 * Pick model with preference, excluding cooldown/tried models.
 * Returns null only if no usable candidates exist at all.
 */
function pickModel(available, preferProvider, excludeRefs, cooldownMap) {
	const now = Date.now();

	// Tier 1: not excluded, not in cooldown
	let candidates = available.filter((e) => {
		if (excludeRefs.has(e.ref)) return false;
		const cd = cooldownMap.get(e.ref);
		if (cd && cd.cooldownUntil > now) return false;
		return true;
	});

	// Tier 2: not excluded (ignore cooldown) — better than retrying same model
	if (candidates.length === 0) {
		candidates = available.filter((e) => !excludeRefs.has(e.ref));
	}

	// Tier 3: everything (last resort)
	if (candidates.length === 0) {
		candidates = [...available];
	}

	if (candidates.length === 0) return null;

	// Prefer the configured provider
	const preferred = candidates.find((e) =>
		e.ref.startsWith(`${preferProvider}/`),
	);
	if (preferred) return preferred.ref;
	return candidates[0].ref;
}

/**
 * Pick the model with the LARGEST context window, excluding tried models.
 */
function pickLargestContext(available, excludeRefs) {
	let candidates = available.filter((e) => !excludeRefs.has(e.ref));
	if (candidates.length === 0) candidates = [...available];
	if (candidates.length === 0) return null;
	const sorted = [...candidates].sort(
		(a, b) => (b.contextWindow || 0) - (a.contextWindow || 0),
	);
	return sorted[0].ref;
}

// ── Plugin entry ─────────────────────────────────────────────

export default function smartModelSwitchPlugin(api) {
	if (!api?.on) return;

	const pluginConfig = api?.pluginConfig ?? {};
	const preferProvider = pluginConfig?.preferProvider || "minimax";
	let fastTimer = null;
	let slowTimer = null;

	// Cooldown tracking: ref → { failCount, cooldownUntil }
	const cooldownMap = new Map();

	// Per-session retry tracking: sessionKey → { tried: Set<ref>, lastCallAt }
	const sessionAttempts = new Map();

	// Sessions that hit context overflow → need large-context model
	const sessionsNeedLargeContext = new Set();

	// Track which model was picked for each in-flight attempt
	const sessionToModel = new Map();

	log(`Plugin loaded. prefer=${preferProvider}`);

	// ── Probe + schedule ────────────────────────────────────────

	async function runProbeAndSave() {
		const available = await probeAll(pluginConfig);
		saveAvailableList(available);
		// Reset cooldowns for models that passed re-probe
		for (const entry of available) {
			cooldownMap.delete(entry.ref);
		}
		syncFallbackChain(available);
		return available;
	}

	api.on("gateway_start", async () => {
		log("gateway_start: initial probe...");
		syncProvidersToOpenClawConfig(pluginConfig);
		await runProbeAndSave();

		const startedAt = Date.now();
		const slowIntervalMs =
			(Number(pluginConfig?.probeIntervalHours) || 1) * 3600_000;

		// Fast phase: probe every 1 minute for first 30 minutes
		log(
			`Fast-probe phase: every ${FAST_PROBE_INTERVAL_MS / 1000}s for ${FAST_PROBE_DURATION_MS / 60000} min`,
		);
		fastTimer = setInterval(async () => {
			const elapsed = Date.now() - startedAt;
			if (elapsed >= FAST_PROBE_DURATION_MS) {
				clearInterval(fastTimer);
				fastTimer = null;
				log(
					`Fast-probe phase ended. Switching to slow probe every ${slowIntervalMs / 60000} min`,
				);
				slowTimer = setInterval(() => runProbeAndSave(), slowIntervalMs);
				return;
			}
			log(`Fast re-probe (${Math.round(elapsed / 1000)}s since start)...`);
			await runProbeAndSave();
		}, FAST_PROBE_INTERVAL_MS);
	});

	api.on("gateway_stop", () => {
		if (fastTimer) {
			clearInterval(fastTimer);
			fastTimer = null;
		}
		if (slowTimer) {
			clearInterval(slowTimer);
			slowTimer = null;
		}
		log("gateway_stop: cleaned up timers");
	});

	// ── Model selection ─────────────────────────────────────────

	api.on("before_model_resolve", (_event, ctx) => {
		const { available } = loadAvailableList();
		if (available.length === 0) {
			log("before_model_resolve: no available models, skipping override");
			return undefined;
		}

		const sessionKey = ctx?.sessionKey || "__unknown__";
		const now = Date.now();

		// Manage per-session retry tracking
		let attempt = sessionAttempts.get(sessionKey);
		if (!attempt || now - attempt.lastCallAt > SESSION_RETRY_WINDOW_MS) {
			// New message (not a retry) — reset tried list
			attempt = { tried: new Set(), lastCallAt: now };
		}
		attempt.lastCallAt = now;

		const needsLargeCtx = sessionsNeedLargeContext.has(sessionKey);

		let ref;
		if (needsLargeCtx) {
			ref = pickLargestContext(available, attempt.tried);
			log(
				`before_model_resolve: [LARGE-CTX] → ${ref} (session=${sessionKey}, retry #${attempt.tried.size})`,
			);
		} else {
			ref = pickModel(
				available,
				preferProvider,
				attempt.tried,
				cooldownMap,
			);
			log(
				`before_model_resolve: → ${ref} (session=${sessionKey}, retry #${attempt.tried.size})`,
			);
		}

		if (!ref) return undefined;

		attempt.tried.add(ref);
		sessionAttempts.set(sessionKey, attempt);

		const { provider, modelId } = splitRef(ref);
		sessionToModel.set(sessionKey, ref);
		return { providerOverride: provider, modelOverride: modelId };
	});

	// ── Failure / success tracking ─────────────────────────────

	api.on("agent_end", (event, ctx) => {
		const sessionKey = ctx?.sessionKey;
		if (!sessionKey) return;
		const ref = sessionToModel.get(sessionKey);
		// Don't delete sessionToModel here — it's per-attempt, and the fallback
		// chain may call before_model_resolve again for the same session.

		if (event?.success === false) {
			const errorMsg = event.error ?? "";
			const isOverflow = isContextOverflowError(errorMsg);
			const isRateLimit = isRateLimitError(errorMsg);

			if (isOverflow) {
				sessionsNeedLargeContext.add(sessionKey);
				log(
					`agent_end: CONTEXT OVERFLOW (session=${sessionKey}) → will pick large-ctx next`,
				);
			} else if (ref) {
				// Apply escalating cooldown
				const existing = cooldownMap.get(ref) || {
					failCount: 0,
					cooldownUntil: 0,
				};
				existing.failCount += 1;
				const stepIdx = Math.min(
					existing.failCount - 1,
					COOLDOWN_STEPS_MS.length - 1,
				);
				existing.cooldownUntil = Date.now() + COOLDOWN_STEPS_MS[stepIdx];
				cooldownMap.set(ref, existing);

				const cdSec = Math.round(COOLDOWN_STEPS_MS[stepIdx] / 1000);
				const reason = isRateLimit ? "RATE-LIMIT" : "ERROR";
				log(
					`agent_end: ${reason} ${ref} (session=${sessionKey}, fail #${existing.failCount}, cooldown ${cdSec}s) error: ${errorMsg.slice(0, 120)}`,
				);
			}
		} else if (event?.success) {
			// Clear session state on success
			sessionToModel.delete(sessionKey);
			sessionAttempts.delete(sessionKey);
			if (sessionsNeedLargeContext.has(sessionKey)) {
				sessionsNeedLargeContext.delete(sessionKey);
				log(
					`agent_end: SUCCESS (session=${sessionKey}) → cleared large-ctx flag`,
				);
			}
			// Reset cooldown for the model that succeeded
			if (ref) {
				cooldownMap.delete(ref);
			}
		}
	});

	return {};
}

export {
	isContextOverflowError,
	isRateLimitError,
	splitRef,
	pickModel,
	pickLargestContext,
};
