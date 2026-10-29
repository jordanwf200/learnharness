/**
 * The live half of the Claude Code CLI backend: the `fetch` pi-ai's
 * anthropic-messages provider calls (POST /v1/messages), answered by `claude`
 * processes. See claude-code-cli.ts for how a request maps onto the CLI.
 *
 * A process lives for one agent turn, not one request. When the model stops
 * for tool use, the reply stream ends but the process stays up: the CLI goes
 * on to call the tools through the stub MCP server, and those calls wait here.
 * pi-agent-core executes the tools itself and sends the next request with the
 * results; when that request continues exactly where the waiting process
 * stopped, the results answer the waiting calls and the same process streams
 * the next reply. The CLI's context therefore stays identical to pi's
 * transcript (and its prompt cache warm). Any other request (a new prompt,
 * a steer, a changed prefix, an expired process) starts a fresh process
 * that replays the transcript with `--resume`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
	CLAUDE_CODE_PATH_ENV, STUB_SERVER, TOOL_PREFIX,
	blocks, claudeCodeEnv, findClaudeBinary, isToolResultsOnly, planClaudeCodeRun, runFiles, sessionFile, stripCacheControl, toMcpResult,
	type WireBlock, type WireMessage, type WireRequest,
} from "./claude-code-cli.ts";

/** How long a process waits for the tool results of its last reply. */
const AWAIT_RESULTS_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 3000;

type Event = Record<string, unknown> & { type: string };
interface ToolUse { id: string; name: string; input: string; call?: { rpcId: unknown; socket: Socket } }

const live = new Set<CliProcess>();

function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error", message } }), { status, headers: { "content-type": "application/json" } });
}

function sse(event: Event): Uint8Array {
	return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function unprefix(name: string): string {
	return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

/** A transcript prefix in comparable form: pi-ai moves cache markers to the
 *  newest turn, which also turns that turn's string content into blocks. */
function canonical(messages: WireMessage[]): string {
	return JSON.stringify(messages.map((m) => ({ role: m.role, content: blocks(m) })));
}

/** What must not change for a process to serve a follow-up request. */
function signature(request: WireRequest): string {
	return JSON.stringify(stripCacheControl([request.model, request.system, request.tools, request.thinking, request.output_config, request.max_tokens]));
}

/** One reply being streamed to pi-ai: resolves with an error response, or
 *  with the SSE body at the reply's first event. */
class Reply {
	readonly response: Promise<Response>;
	private readonly body: ReadableStream<Uint8Array>;
	private resolve!: (response: Response) => void;
	private controller?: ReadableStreamDefaultController<Uint8Array>;
	private started = false;
	closed = false;

	constructor(onCancel: () => void) {
		this.response = new Promise((resolve) => { this.resolve = resolve; });
		this.body = new ReadableStream<Uint8Array>({
			start: (controller) => { this.controller = controller; },
			cancel: () => { this.closed = true; onCancel(); },
		});
	}

	push(event: Event): void {
		if (this.closed) return;
		if (!this.started) { this.started = true; this.resolve(new Response(this.body, { status: 200, headers: { "content-type": "text/event-stream" } })); }
		this.controller!.enqueue(sse(event));
	}
	end(): void {
		if (this.closed) return;
		this.closed = true;
		this.controller!.close();
	}
	fail(status: number, message: string): void {
		if (this.closed) return;
		if (!this.started) { this.closed = true; this.resolve(errorResponse(status, message)); return; }
		this.push({ type: "error", error: { type: "api_error", message } });
		this.end();
	}
}

class CliProcess {
	readonly signature: string;
	/** The transcript this process has answered (canonical form). */
	private transcript: string;
	private transcriptLength: number;
	private readonly token = randomUUID();
	private child!: ChildProcess;
	private reply?: Reply;
	private backlog: Event[] = [];
	private toolUses: ToolUse[] = [];
	private results = new Map<string, WireBlock>();
	private stopReason: string | undefined;
	private awaiting = false;
	private timer?: NodeJS.Timeout;
	private stderr = "";
	private dead = false;

	private constructor(request: WireRequest, messages: WireMessage[], private readonly dir: string, private readonly server: Server) {
		this.signature = signature(request);
		this.transcript = canonical(messages);
		this.transcriptLength = messages.length;
		server.on("connection", (socket) => this.accept(socket));
	}

	/** Write the run's files, open the tool relay, then spawn the CLI (its
	 *  MCP config names the relay port, so the port must exist first). */
	static async start(path: string, request: WireRequest, messages: WireMessage[]): Promise<CliProcess> {
		const dir = mkdtempSync(join(tmpdir(), "lh-claude-code-"));
		const server = createServer();
		try {
			const files = runFiles(dir);
			const run = planClaudeCodeRun(request, files);
			const port = await new Promise<number>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
			});
			const cli = new CliProcess(request, messages, dir, server);
			writeFileSync(files.system, run.system);
			writeFileSync(files.tools, JSON.stringify(run.tools));
			writeFileSync(files.stub, STUB_SERVER);
			writeFileSync(files.mcp, JSON.stringify({ mcpServers: { lh: { type: "stdio", command: process.execPath, args: [files.stub, files.tools, String(port), cli.token], env: { ELECTRON_RUN_AS_NODE: "1" } } } }));
			if (run.history.length) writeFileSync(files.history, sessionFile(run.history, request.model, dir));
			cli.spawn(path, run.args, run.env, run.stdin);
			return cli;
		} catch (error) {
			server.close();
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	}

	private spawn(path: string, args: string[], env: Record<string, string>, stdin: string): void {
		this.child = spawn(path, args, { cwd: this.dir, env: { ...claudeCodeEnv(), ...env }, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdin!.on("error", () => { /* surfaced by close */ });
		this.child.stdin!.end(stdin);
		createInterface({ input: this.child.stdout! }).on("line", (line) => this.line(line));
		this.child.stderr!.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
		this.child.once("error", (error) => this.close(503, `Claude Code CLI could not start: ${error.message}`));
		this.child.once("close", (code, signal) => this.close(500, `Claude Code CLI exited (${signal ?? code}) before replying${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`));
		live.add(this);
	}

	/** A waiting process whose transcript a newer request has moved past
	 *  (a steer, a retry, a new prompt) will never be continued. */
	supersededBy(messages: WireMessage[]): boolean {
		return this.awaiting && messages.length > this.transcriptLength && canonical(messages.slice(0, this.transcriptLength)) === this.transcript;
	}

	/** Does this request continue exactly where this process is waiting? */
	continues(request: WireRequest, messages: WireMessage[]): boolean {
		if (!this.awaiting || this.dead || this.signature !== signature(request)) return false;
		if (messages.length !== this.transcriptLength + 2 || canonical(messages.slice(0, this.transcriptLength)) !== this.transcript) return false;
		const ids = blocks(messages.at(-1)!).map((b) => String(b.tool_use_id));
		return ids.length === this.toolUses.length && this.toolUses.every((use) => ids.includes(use.id));
	}

	/** Stream the next reply; `results` answers the tool calls waiting here. */
	serve(messages: WireMessage[], signal: AbortSignal | undefined, results?: WireBlock[]): Promise<Response> {
		this.transcript = canonical(messages);
		this.transcriptLength = messages.length;
		this.awaiting = false;
		clearTimeout(this.timer);
		const reply = this.reply = new Reply(() => this.kill());
		signal?.addEventListener("abort", () => { reply.fail(499, "Request aborted"); this.kill(); }, { once: true });
		for (const event of this.backlog.splice(0)) this.event(event);
		for (const block of results ?? []) this.results.set(String(block.tool_use_id), block);
		for (const use of this.toolUses) this.answer(use);
		return reply.response;
	}

	private accept(socket: Socket): void {
		let authed = false;
		socket.on("error", () => { /* the stub went away with the CLI */ });
		createInterface({ input: socket }).on("line", (line) => {
			let message: { token?: string; id?: unknown; name?: string; arguments?: unknown };
			try { message = JSON.parse(line); } catch { return socket.destroy(); }
			if (!authed) { authed = message.token === this.token; if (!authed) socket.destroy(); return; }
			// Calls arrive in the reply's tool_use order; match on name + input.
			const name = unprefix(String(message.name)), input = JSON.stringify(message.arguments ?? {});
			const use = this.toolUses.find((u) => !u.call && u.name === name && u.input === input) ?? this.toolUses.find((u) => !u.call && u.name === name);
			if (!use) {
				socket.write(JSON.stringify({ id: message.id, result: { content: [{ type: "text", text: `Unknown tool call ${name}` }], isError: true } }) + "\n");
				return;
			}
			use.call = { rpcId: message.id, socket };
			this.answer(use);
		});
	}

	private answer(use: ToolUse): void {
		const block = this.results.get(use.id);
		if (!use.call || !block) return;
		use.call.socket.write(JSON.stringify({ id: use.call.rpcId, result: toMcpResult(block) }) + "\n");
	}

	private line(line: string): void {
		let message: Record<string, unknown>;
		try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
		if (message.type === "stream_event") return this.event(message.event as Event);
		const inner = message.message as { model?: string; content?: WireBlock[] } | undefined;
		if (message.type === "assistant" && inner?.model !== "<synthetic>") {
			// The finished blocks of the reply: record tool uses for matching.
			for (const block of inner?.content ?? []) {
				if (block.type === "tool_use" && !this.toolUses.some((u) => u.id === block.id)) this.toolUses.push({ id: String(block.id), name: unprefix(String(block.name)), input: JSON.stringify(block.input ?? {}) });
			}
			return;
		}
		// Failures the CLI reports as messages instead of stream events:
		// synthetic assistant text (auth, quota) or an error result.
		if (message.type === "assistant") {
			const text = inner?.content?.map((b) => String(b.text ?? "")).join("").trim() || "Claude Code request failed";
			return this.close(/auth|log ?in|oauth|credential/i.test(text) ? 401 : /limit|quota|rate/i.test(text) ? 429 : 500, text);
		}
		if (message.type === "result" && (message.is_error === true || message.subtype !== "success")) {
			this.close(500, String(message.result ?? message.subtype ?? "Claude Code request failed"));
		}
	}

	private event(raw: Event): void {
		if (!this.reply || this.reply.closed) { this.backlog.push(raw); return; }
		let event = raw;
		if (event.type === "message_start") { this.toolUses = []; this.results.clear(); this.stopReason = undefined; }
		if (event.type === "message_delta") this.stopReason = (event.delta as { stop_reason?: string } | undefined)?.stop_reason ?? this.stopReason;
		const block = event.content_block as { type?: string; name?: string } | undefined;
		if (event.type === "content_block_start" && block?.type === "tool_use") event = { ...event, content_block: { ...block, name: unprefix(String(block.name)) } };
		this.reply.push(event);
		if (event.type !== "message_stop") return;
		this.reply.end();
		if (this.stopReason !== "tool_use") return this.kill();
		this.awaiting = true;
		this.timer = setTimeout(() => this.kill(), AWAIT_RESULTS_MS);
		this.timer.unref?.();
	}

	stop(): void { this.kill(); }

	private kill(): void {
		const child = this.child;
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS).unref();
	}

	private close(status: number, message: string): void {
		this.reply?.fail(status, message);
		if (this.dead) return;
		this.dead = true;
		live.delete(this);
		clearTimeout(this.timer);
		this.kill();
		this.server.close();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** A `fetch` answering POST /v1/messages through the Claude Code CLI. */
export const claudeCodeFetch: typeof fetch = async (_input, init) => {
	let request: WireRequest;
	try { request = JSON.parse(String(init?.body)) as WireRequest; } catch { return errorResponse(400, "Unreadable request body"); }
	const messages = stripCacheControl(request.messages);
	const signal = init?.signal ?? undefined;

	const last = messages.at(-1);
	if (isToolResultsOnly(last)) {
		for (const cli of live) {
			if (cli.continues(request, messages)) return cli.serve(messages, signal, blocks(last!));
		}
	}
	for (const cli of live) if (cli.supersededBy(messages)) cli.stop();

	const path = findClaudeBinary();
	if (!path) return errorResponse(503, `Claude Code CLI not found. Install it, or set ${CLAUDE_CODE_PATH_ENV} to its path.`);
	let cli: CliProcess;
	try { cli = await CliProcess.start(path, request, messages); } catch (error) { return errorResponse(400, error instanceof Error ? error.message : String(error)); }
	return cli.serve(messages, signal);
};
