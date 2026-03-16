import assert from "node:assert";

// ── Inline test functions ──

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

function pickNormal(available, preferProvider = "minimax") {
  if (available.length === 0) return null;
  const preferred = available.find((e) => e.ref.startsWith(`${preferProvider}/`));
  if (preferred) return preferred.ref;
  return available[0].ref;
}

function pickLargestContext(available) {
  if (available.length === 0) return null;
  const sorted = [...available].sort((a, b) => (b.contextWindow || 0) - (a.contextWindow || 0));
  return sorted[0].ref;
}

function splitRef(ref) {
  const idx = ref.indexOf("/");
  if (idx < 0) return { provider: ref, modelId: ref };
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

// ── Tests ──

console.log("Testing isContextOverflowError...");
assert.strictEqual(isContextOverflowError(null), false);
assert.strictEqual(isContextOverflowError(""), false);
assert.strictEqual(isContextOverflowError("rate limit"), false);
assert.strictEqual(isContextOverflowError("auth failed"), false);
assert.strictEqual(isContextOverflowError("Context overflow: prompt too large for the model"), true);
assert.strictEqual(isContextOverflowError("context_overflow"), true);
assert.strictEqual(isContextOverflowError("compaction_failure"), true);
assert.strictEqual(isContextOverflowError("request_too_large"), true);
assert.strictEqual(isContextOverflowError("This model's maximum context length is 200000 tokens"), true);
assert.strictEqual(isContextOverflowError("prompt is too long: 250000 tokens > 200000 maximum"), true);
assert.strictEqual(isContextOverflowError("Request size exceeds model context window"), true);
assert.strictEqual(isContextOverflowError("Unhandled stop reason: model_context_window_exceeded"), true);
assert.strictEqual(isContextOverflowError("上下文过长，请压缩后重试"), true);
assert.strictEqual(isContextOverflowError("超出最大上下文限制"), true);
assert.strictEqual(isContextOverflowError("⚠️ API rate limit reached"), false);
console.log("  All isContextOverflowError tests passed.");

console.log("Testing pickNormal...");
const models = [
  { ref: "volcengine/doubao", contextWindow: 256000 },
  { ref: "minimax/MiniMax-M2.5", contextWindow: 200000 },
  { ref: "openrouter/qwen/qwen3-coder:free", contextWindow: 262000 },
];
assert.strictEqual(pickNormal(models, "minimax"), "minimax/MiniMax-M2.5");
assert.strictEqual(pickNormal(models, "volcengine"), "volcengine/doubao");
assert.strictEqual(pickNormal(models, "nonexistent"), "volcengine/doubao");
assert.strictEqual(pickNormal([], "minimax"), null);
console.log("  All pickNormal tests passed.");

console.log("Testing pickLargestContext...");
assert.strictEqual(pickLargestContext(models), "openrouter/qwen/qwen3-coder:free");
assert.strictEqual(pickLargestContext([models[1]]), "minimax/MiniMax-M2.5");
assert.strictEqual(pickLargestContext([]), null);
// With mixed context windows, largest wins
const mixed = [
  { ref: "a/small", contextWindow: 128000 },
  { ref: "b/huge", contextWindow: 262000 },
  { ref: "c/medium", contextWindow: 200000 },
];
assert.strictEqual(pickLargestContext(mixed), "b/huge");
console.log("  All pickLargestContext tests passed.");

console.log("Testing splitRef...");
assert.deepStrictEqual(splitRef("minimax/MiniMax-M2.5"), { provider: "minimax", modelId: "MiniMax-M2.5" });
assert.deepStrictEqual(splitRef("openrouter/qwen/qwen3-coder:free"), { provider: "openrouter", modelId: "qwen/qwen3-coder:free" });
console.log("  All splitRef tests passed.");

console.log("\nAll tests passed!");
