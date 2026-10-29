import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { CLAUDE_CODE_PATH_ENV, RESUME_NUDGE, claudeCodeEnv, planClaudeCodeRun, refreshClaudeCodeStatus, runFiles } from "../src/agent/claude-code-cli.ts";
import { claudeCodeModel, piEngineForSpec } from "../src/agent/models.ts";
import { subscriptionLabel } from "../src/core/prices.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const files = runFiles("/run");
let dir: string, log: string;
const saved = { path: process.env[CLAUDE_CODE_PATH_ENV], log: process.env.FAKE_CLAUDE_LOG, auth: process.env.FAKE_CLAUDE_AUTH };

before(() => {
	dir = mkdtempSync(join(tmpdir(), "lh-claude-code-test-"));
	chmodSync(FAKE, 0o755);
	process.env[CLAUDE_CODE_PATH_ENV] = FAKE;
});
beforeEach(() => {
	log = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(log, "");
	process.env.FAKE_CLAUDE_LOG = log;
});
after(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [[CLAUDE_CODE_PATH_ENV, saved.path], ["FAKE_CLAUDE_LOG", saved.log], ["FAKE_CLAUDE_AUTH", saved.auth]] as const) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

interface Invocation { args: string[]; history: { role: string; content: { type: string; name?: string }[] }[]; stdin: { content: unknown } }
const invocations = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Invocation);

// ─── request translation (pure) ──────────────────────────────────────────────

test("a first prompt runs without --resume; the prompt is the stdin turn", () => {
	const run = planClaudeCodeRun({ model: "claude-sonnet-5-5", system: [{ type: "text", text: "Teach.", cache_control: { type: "ephemeral" } } as never], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] }, files);
	assert.equal(run.system, "Teach.");
	assert.deepEqual(run.history, []);
	assert(!run.args.includes("--resume"));
	assert.deepEqual(JSON.parse(run.stdin), { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
	for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert(run.args.includes(flag), flag);
	assert.equal(run.args[run.args.indexOf("--tools") + 1], "");
	assert.equal(run.args[run.args.indexOf("--setting-sources") + 1], "");
});

test("prior turns become the resumed history, with tool names prefixed", () => {
	const run = planClaudeCodeRun({
		model: "claude-sonnet-5-5",
		messages: [
			{ role: "user", content: "add" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "add", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "5" }, { type: "text", text: "and now?" }] },
		],
		tools: [{ name: "add", description: "Add", input_schema: { type: "object", properties: {} } }],
	}, files);
	assert(run.args.includes("--resume"));
	assert.deepEqual(run.history.map((m) => m.role), ["user", "assistant", "user"]);
	assert.deepEqual(run.history[1]!.content, [{ type: "tool_use", id: "t1", name: "mcp__lh__add", input: {} }]);
	// The final message's tool results join history; its text is the turn.
	assert.deepEqual(run.history[2]!.content, [{ type: "tool_result", tool_use_id: "t1", content: "5" }]);
	assert.deepEqual(JSON.parse(run.stdin).message.content, [{ type: "text", text: "and now?" }]);
	assert.deepEqual(run.tools, [{ name: "add", description: "Add", inputSchema: { type: "object", properties: {} } }]);
});

test("tool results with no live process resume with the nudge turn", () => {
	const run = planClaudeCodeRun({ model: "m", messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "a", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] }, files);
	assert.equal(run.history.length, 3);
	assert.deepEqual(JSON.parse(run.stdin).message.content, [{ type: "text", text: RESUME_NUDGE }]);
});

test("thinking maps to effort, a token budget, or off", () => {
	const base = { model: "m", messages: [{ role: "user", content: "x" }] };
	const adaptive = planClaudeCodeRun({ ...base, thinking: { type: "adaptive" }, output_config: { effort: "high" } }, files);
	assert.equal(adaptive.args[adaptive.args.indexOf("--effort") + 1], "high");
	assert.equal(adaptive.env.MAX_THINKING_TOKENS, undefined);
	assert.equal(planClaudeCodeRun({ ...base, thinking: { type: "enabled", budget_tokens: 4096 } }, files).env.MAX_THINKING_TOKENS, "4096");
	assert.equal(planClaudeCodeRun(base, files).env.MAX_THINKING_TOKENS, "0");
});

test("the CLI never inherits another session's identity or an API key", () => {
	const env = claudeCodeEnv({ NODE_ENV: "test", PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_BASE_URL: "http://proxy", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CONFIG_DIR: "/cfg", OPENAI_API_KEY: "o" } as NodeJS.ProcessEnv);
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"]) assert.equal(env[key], undefined, key);
	assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg");
	assert.equal(env.PATH, "/bin");
	assert.equal(env.DISABLE_AUTO_COMPACT, "1");
});

test("Claude Code usage is labelled as a subscription, never priced in dollars", () => {
	assert.equal(subscriptionLabel("claude-code:claude-sonnet-5-5"), "Claude Code");
	assert.equal(subscriptionLabel("anthropic:claude-sonnet-5-5"), undefined);
	const model = claudeCodeModel("claude-sonnet-5-5")!;
	assert.equal(model.provider, "claude-code");
	assert.equal((model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages, false);
});

// ─── the bridge, end to end against the fake CLI ─────────────────────────────

const engine = () => piEngineForSpec({ provider: "claude-code", id: "claude-haiku-4-5", thinkingLevel: "off" });
const tools = [{ name: "add", description: "Add two integers", parameters: Type.Object({ a: Type.Integer(), b: Type.Integer() }) }];

async function step(messages: Message[]): Promise<AssistantMessage> {
	const { model, streamFn } = engine();
	const stream = await streamFn(model, normalizeContext({ systemPrompt: "Teach.", messages, tools }), {});
	return stream.result();
}
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const textOf = (message: AssistantMessage) => message.content.map((b) => b.type === "text" ? b.text : "").join("");

test("a prompt streams back as an ordinary assistant message", async () => {
	const reply = await step([user("hello")]);
	assert.equal(reply.stopReason, "stop", reply.errorMessage);
	assert.equal(textOf(reply), "echo: hello");
	assert.equal(reply.provider, "claude-code");
	const run = invocations()[0]!;
	assert.equal(run.args[run.args.indexOf("--model") + 1], "claude-haiku-4-5");
});

test("a tool loop runs on ONE process: the tool call is unprefixed, its result answers the waiting MCP call", async () => {
	const messages: Message[] = [user("call add")];
	const first = await step(messages);
	assert.equal(first.stopReason, "toolUse", first.errorMessage);
	const call = first.content.find((b) => b.type === "toolCall");
	assert(call && call.type === "toolCall");
	assert.equal(call.name, "add");
	assert.deepEqual(call.arguments, { a: 2, b: 3 });

	messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: "add", content: [{ type: "text", text: "5" }], isError: false, timestamp: 0 });
	const second = await step(messages);
	assert.equal(second.stopReason, "stop", second.errorMessage);
	assert.equal(textOf(second), "result: 5");
	assert.equal(invocations().length, 1);

	// The next prompt is a fresh process replaying the whole loop.
	messages.push(second, user("thanks"));
	const third = await step(messages);
	assert.equal(textOf(third), "echo: thanks");
	const runs = invocations();
	assert.equal(runs.length, 2);
	const history = runs[1]!.history;
	assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
	assert(history[1]!.content.some((b) => b.type === "tool_use" && b.name === "mcp__lh__add"));
	assert(history[2]!.content.some((b) => b.type === "tool_result"));
});

test("CLI failures surface as model errors", async () => {
	const reply = await step([user("auth fail")]);
	assert.equal(reply.stopReason, "error");
	assert.match(reply.errorMessage ?? "", /authenticate/i);
});

test("login status comes from `claude auth status`", async () => {
	process.env.FAKE_CLAUDE_AUTH = JSON.stringify({ loggedIn: true, email: "learner@example.invalid", subscriptionType: "max" });
	assert.deepEqual(await refreshClaudeCodeStatus(true), { state: "ready", path: FAKE, email: "learner@example.invalid", plan: "max" });
	process.env.FAKE_CLAUDE_AUTH = JSON.stringify({ loggedIn: false });
	assert.deepEqual(await refreshClaudeCodeStatus(true), { state: "logged-out", path: FAKE });
});
