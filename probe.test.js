/**
 * Unit tests for smart-model-switch helpers.
 * Run: node probe.test.js
 */

import {
	isContextOverflowError,
	isRateLimitError,
	splitRef,
	pickModel,
	pickLargestContext,
} from "./index.js";

let passed = 0;
let failed = 0;

function assert(cond, label) {
	if (cond) {
		passed++;
	} else {
		failed++;
		console.error(`  FAIL: ${label}`);
	}
}

// ── isContextOverflowError ──────────────────────────────────

console.log("isContextOverflowError:");
assert(isContextOverflowError("context_overflow"), "context_overflow");
assert(isContextOverflowError("prompt is too long"), "prompt is too long");
assert(isContextOverflowError("上下文过长"), "上下文过长");
assert(!isContextOverflowError("rate limit exceeded"), "not rate limit");
assert(!isContextOverflowError(""), "empty");
assert(!isContextOverflowError(null), "null");

// ── isRateLimitError ────────────────────────────────────────

console.log("isRateLimitError:");
assert(isRateLimitError("rate limit exceeded"), "rate limit exceeded");
assert(isRateLimitError("Rate_Limit_Exceeded"), "Rate_Limit_Exceeded (case)");
assert(isRateLimitError("too many requests"), "too many requests");
assert(isRateLimitError("429 Too Many Requests"), "429");
assert(isRateLimitError("quota exceeded"), "quota exceeded");
assert(isRateLimitError("请求过于频繁"), "请求过于频繁");
assert(!isRateLimitError("context overflow"), "not context overflow");
assert(!isRateLimitError(""), "empty");
assert(!isRateLimitError(null), "null");

// ── splitRef ────────────────────────────────────────────────

console.log("splitRef:");
assert(
	splitRef("minimax/MiniMax-M2.5").provider === "minimax" &&
		splitRef("minimax/MiniMax-M2.5").modelId === "MiniMax-M2.5",
	"simple",
);
assert(
	splitRef("openrouter/qwen/qwen3-coder:free").provider === "openrouter" &&
		splitRef("openrouter/qwen/qwen3-coder:free").modelId ===
			"qwen/qwen3-coder:free",
	"nested slash",
);

// ── pickModel ───────────────────────────────────────────────

console.log("pickModel:");
const avail = [
	{ ref: "deepseek/deepseek-chat", contextWindow: 64000 },
	{ ref: "minimax/MiniMax-M2.5", contextWindow: 200000 },
	{ ref: "zai/glm-5", contextWindow: 128000 },
];

// Basic preference
assert(
	pickModel(avail, "minimax", new Set(), new Map()) === "minimax/MiniMax-M2.5",
	"prefers minimax",
);

// Skip excluded
assert(
	pickModel(avail, "minimax", new Set(["minimax/MiniMax-M2.5"]), new Map()) ===
		"deepseek/deepseek-chat",
	"skips excluded minimax → deepseek",
);

// Skip excluded + cooldown
const cdMap = new Map();
cdMap.set("deepseek/deepseek-chat", {
	failCount: 1,
	cooldownUntil: Date.now() + 600_000,
});
assert(
	pickModel(
		avail,
		"minimax",
		new Set(["minimax/MiniMax-M2.5"]),
		cdMap,
	) === "zai/glm-5",
	"skips excluded + cooldown → zai",
);

// All excluded → falls back to full list
assert(
	pickModel(
		avail,
		"minimax",
		new Set(["deepseek/deepseek-chat", "minimax/MiniMax-M2.5", "zai/glm-5"]),
		new Map(),
	) !== null,
	"all excluded → still returns something",
);

// Empty available
assert(pickModel([], "minimax", new Set(), new Map()) === null, "empty → null");

// ── pickLargestContext ──────────────────────────────────────

console.log("pickLargestContext:");
assert(
	pickLargestContext(avail, new Set()) === "minimax/MiniMax-M2.5",
	"picks largest (200k)",
);
assert(
	pickLargestContext(avail, new Set(["minimax/MiniMax-M2.5"])) ===
		"zai/glm-5",
	"excludes minimax → picks zai (128k)",
);
assert(pickLargestContext([], new Set()) === null, "empty → null");

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
