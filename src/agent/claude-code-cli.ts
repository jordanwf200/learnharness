/**
 * The Claude Code CLI as a model backend, the pure half: finding the
 * binary, its environment, its login status, and translating one Anthropic
 * Messages request into a `claude -p` run. The live process bridge (the
 * `fetch` pi-ai calls) is src/agent/claude-code-bridge.ts.
 *
 * A request maps onto the CLI like this:
 *   - prior turns are written as a CLI session file and loaded with
 *     `--resume <file>`, so earlier tool_use / tool_result / thinking blocks
 *     replay verbatim;
 *   - the request's tools are served by a stub stdio MCP server, so the model
 *     sees them as `mcp__lh__<name>` (prefixed in history, unprefixed in the
 *     reply). The stub executes nothing: it forwards each call to the bridge,
 *     which answers with the results pi-agent-core produced;
 *   - the final user turn goes over stdin.
 *
 * Built-in CLI tools, settings files, CLAUDE.md, skills, other MCP servers,
 * session persistence and auto-compaction are all off, and every inherited
 * CLAUDE_* / ANTHROPIC_* variable is dropped so the CLI always runs on its own
 * login (never an API key the app reflected into the environment).
 */

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeCodeConnectionStatus } from "../core/contracts/subscriptions.ts";

export const TOOL_PREFIX = "mcp__lh__";
const STATUS_TTL_MS = 15_000;
/** Sent only when a tool loop must be resumed in a NEW process (the live one
 *  is gone): the CLI drops a resumed session's trailing unanswered tool_use,
 *  so the results ride in history and the turn needs some user input. */
export const RESUME_NUDGE = "(Tool results are above. Continue.)";

/** Overrides binary discovery (also the test seam for a fake CLI). */
export const CLAUDE_CODE_PATH_ENV = "LH_CLAUDE_CODE_PATH";

// ─── binary + environment ────────────────────────────────────────────────────

/** Desktop apps launched from the Dock get a minimal PATH, so the usual
 *  install locations are searched after it. */
export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env[CLAUDE_CODE_PATH_ENV];
	if (override) return executable(override) ? override : undefined;
	const home = homedir();
	const dirs = [
		...(env.PATH ?? "").split(delimiter).filter(Boolean),
		join(home, ".local", "bin"),
		join(home, ".claude", "local"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	];
	const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (executable(candidate)) return candidate;
		}
	}
	return undefined;
}

function executable(path: string): boolean {
	try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** The CLI's environment: the app's, minus anything that would change which
 *  account or session the CLI acts as (CLAUDE_CONFIG_DIR is kept: it IS the
 *  user's choice of login). */
export function claudeCodeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const key of Object.keys(env)) {
		if (key !== "CLAUDE_CONFIG_DIR" && /^(CLAUDECODE$|CLAUDE_|ANTHROPIC_)/.test(key)) delete env[key];
	}
	env.DISABLE_AUTO_COMPACT = "1";
	env.DISABLE_AUTOUPDATER = "1";
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	// App tools can wait on the learner; their results must arrive whole.
	env.MCP_TOOL_TIMEOUT = String(24 * 60 * 60 * 1000);
	env.MAX_MCP_OUTPUT_TOKENS = "1000000";
	return env;
}

// ─── login status ────────────────────────────────────────────────────────────

let status: ClaudeCodeConnectionStatus = { state: "unknown" };
let checkedAt = 0;
let inflight: Promise<ClaudeCodeConnectionStatus> | undefined;

/** The last known status (sync: the catalog and key gates read this). */
export function claudeCodeStatus(): ClaudeCodeConnectionStatus { return status; }
export function claudeCodeReady(): boolean { return status.state === "ready"; }

/** Re-check `claude auth status` (cached for a few seconds unless forced). */
export function refreshClaudeCodeStatus(force = false): Promise<ClaudeCodeConnectionStatus> {
	if (!force && status.state !== "unknown" && Date.now() - checkedAt < STATUS_TTL_MS) return Promise.resolve(status);
	inflight ??= checkStatus().then((next) => {
		status = next; checkedAt = Date.now(); inflight = undefined;
		return next;
	});
	return inflight;
}

function checkStatus(): Promise<ClaudeCodeConnectionStatus> {
	const path = findClaudeBinary();
	if (!path) return Promise.resolve({ state: "missing" });
	return new Promise((resolve) => {
		execFile(path, ["auth", "status"], { env: claudeCodeEnv(), timeout: 20_000 }, (error, stdout) => {
			try {
				const parsed = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
				resolve(parsed.loggedIn
					? { state: "ready", path, ...(parsed.email ? { email: parsed.email } : {}), ...(parsed.subscriptionType ? { plan: parsed.subscriptionType } : {}) }
					: { state: "logged-out", path });
			} catch {
				resolve({ state: "error", path, message: error?.message ?? "`claude auth status` returned no status" });
			}
		});
	});
}

// ─── request translation ─────────────────────────────────────────────────────

export type WireBlock = Record<string, unknown> & { type: string };
export interface WireMessage { role: string; content: string | WireBlock[] }
export interface WireRequest {
	model: string;
	max_tokens?: number;
	system?: string | { type: string; text: string }[];
	messages: WireMessage[];
	tools?: { name: string; description?: string; input_schema?: unknown }[];
	thinking?: { type: string; budget_tokens?: number };
	output_config?: { effort?: string };
}

export interface McpTool { name: string; description: string; inputSchema: unknown }

/** Everything one CLI process needs, derived purely from the request. */
export interface ClaudeCodeRun {
	args: string[];
	env: Record<string, string>;
	system: string;
	tools: McpTool[];
	/** Session-file messages (tool names prefixed); empty = no `--resume`. */
	history: WireMessage[];
	/** The stream-json line for the final user turn. */
	stdin: string;
}

/** Files the run refers to, all inside the run's private directory. */
export function runFiles(dir: string) {
	return { system: join(dir, "system.md"), mcp: join(dir, "mcp.json"), tools: join(dir, "tools.json"), stub: join(dir, "tools-stub.mjs"), history: join(dir, "history.jsonl") };
}

/** Strip request-level cache markers; the CLI places its own breakpoints. */
export function stripCacheControl<T>(value: T): T {
	if (Array.isArray(value)) return value.map(stripCacheControl) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) if (key !== "cache_control") out[key] = stripCacheControl(inner);
		return out as T;
	}
	return value;
}

export function blocks(message: WireMessage): WireBlock[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/** A user message made only of tool results: the shape that continues a
 *  tool loop rather than starting a turn. */
export function isToolResultsOnly(message: WireMessage | undefined): boolean {
	if (message?.role !== "user") return false;
	const content = blocks(message);
	return content.length > 0 && content.every((b) => b.type === "tool_result");
}

function prefixToolUses(message: WireMessage): WireMessage {
	if (message.role !== "assistant" || typeof message.content === "string") return message;
	return { ...message, content: message.content.map((block) => block.type === "tool_use" ? { ...block, name: TOOL_PREFIX + String(block.name) } : block) };
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Translate one Anthropic Messages request into a fresh CLI process (pure).
 *  The final user message's tool results (if any) join the history; its
 *  remaining content is the stdin turn. */
export function planClaudeCodeRun(request: WireRequest, files: ReturnType<typeof runFiles>): ClaudeCodeRun {
	const messages = stripCacheControl(request.messages);
	if (messages.some((m) => m.role !== "user" && m.role !== "assistant")) throw new Error("Claude Code requests cannot carry mid-conversation system messages");
	const last = messages.at(-1);
	if (!last || last.role !== "user") throw new Error("Claude Code requests must end with a user message");

	const results = blocks(last).filter((b) => b.type === "tool_result");
	const rest = blocks(last).filter((b) => b.type !== "tool_result");
	const history = [...messages.slice(0, -1), ...(results.length ? [{ role: "user", content: results }] : [])].map(prefixToolUses);
	const turn = rest.length ? rest : [{ type: "text", text: RESUME_NUDGE }];

	const system = typeof request.system === "string" ? request.system : (request.system ?? []).map((b) => b.text).join("\n\n");
	const tools = (request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: stripCacheControl(tool.input_schema) ?? { type: "object", properties: {} } }));

	const args = [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--model", request.model,
		"--system-prompt-file", files.system,
		"--tools", "",
		"--mcp-config", files.mcp, "--strict-mcp-config",
		"--allowedTools", "mcp__lh",
		"--setting-sources", "",
		"--disable-slash-commands",
		"--permission-prompts", "none",
		"--no-session-persistence",
	];
	if (history.length) args.push("--resume", files.history);

	// Thinking: adaptive models take an effort; budget models take a token
	// budget; no thinking block means thinking off.
	const env: Record<string, string> = {};
	const effort = request.output_config?.effort;
	if (request.thinking?.type === "enabled" && request.thinking.budget_tokens) env.MAX_THINKING_TOKENS = String(request.thinking.budget_tokens);
	else if (!request.thinking || request.thinking.type === "disabled") env.MAX_THINKING_TOKENS = "0";
	if (effort && EFFORTS.has(effort)) args.push("--effort", effort);
	if (request.max_tokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.max_tokens);

	return { args, env, system, tools, history, stdin: JSON.stringify({ type: "user", message: { role: "user", content: turn } }) + "\n" };
}

/** Session-file records for `--resume`: a parent-linked chain of plain
 *  user/assistant messages, the minimum the CLI loads. */
export function sessionFile(messages: WireMessage[], model: string, cwd: string): string {
	const sessionId = randomUUID();
	const timestamp = new Date().toISOString();
	let parent: string | null = null;
	return messages.map((message) => {
		const uuid = randomUUID();
		const body = message.role === "assistant"
			? { id: `msg_${uuid.replaceAll("-", "")}`, type: "message", role: "assistant", model, content: message.content, stop_reason: blocks(message).some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
			: { role: "user", content: message.content };
		const record = { parentUuid: parent, isSidechain: false, type: message.role, message: body, uuid, timestamp, userType: "external", cwd, sessionId };
		parent = uuid;
		return JSON.stringify(record);
	}).join("\n") + "\n";
}

/** The stub MCP server (written next to each run, run with the app's own
 *  Node). It lists the request's tools and relays every call to the bridge
 *  over loopback TCP, answering the CLI with whatever the bridge returns. */
export const STUB_SERVER = `import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
const [toolsFile, port, token] = process.argv.slice(2);
const tools = JSON.parse(readFileSync(toolsFile, "utf8"));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const bridge = connect(Number(port), "127.0.0.1");
bridge.write(JSON.stringify({ token }) + "\\n");
createInterface({ input: bridge }).on("line", (line) => {
	const reply = JSON.parse(line);
	send({ jsonrpc: "2.0", id: reply.id, result: reply.result });
});
bridge.on("error", () => process.exit(1));
createInterface({ input: process.stdin }).on("line", (line) => {
	let msg; try { msg = JSON.parse(line); } catch { return; }
	if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lh", version: "1" } } });
	else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
	else if (msg.method === "tools/call") bridge.write(JSON.stringify({ id: msg.id, name: msg.params.name, arguments: msg.params.arguments ?? {} }) + "\\n");
	else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
}).on("close", () => process.exit(0));
`;

/** One Anthropic tool_result block as an MCP CallToolResult. */
export function toMcpResult(block: WireBlock): { content: unknown[]; isError: boolean } {
	const raw = block.content;
	const parts = typeof raw === "string" ? [{ type: "text", text: raw }] : Array.isArray(raw) ? raw as WireBlock[] : [];
	const content = parts.map((part) => {
		const source = part.source as { type?: string; media_type?: string; data?: string } | undefined;
		if (part.type === "image" && source?.type === "base64") return { type: "image", data: source.data, mimeType: source.media_type };
		return { type: "text", text: typeof part.text === "string" ? part.text : JSON.stringify(part) };
	});
	return { content: content.length ? content : [{ type: "text", text: "" }], isError: block.is_error === true };
}
