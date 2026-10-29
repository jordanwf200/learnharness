#!/usr/bin/env node
// A stand-in for the `claude` CLI (tests/claude-code.test.ts): speaks the
// same stream-json + MCP protocol the bridge relies on, with scripted
// replies. Every invocation appends {args, history, stdin} to $FAKE_CLAUDE_LOG.
//   - stdin text "call add"   → tool_use mcp__lh__add {a:2,b:3}, then (after
//                                the MCP call returns) "result: <text>"
//   - stdin text "auth fail"  → the CLI's synthetic auth-failure message
//   - anything else           → "echo: <last text>"
// `claude auth status` prints $FAKE_CLAUDE_AUTH (JSON).
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write(process.env.FAKE_CLAUDE_AUTH ?? '{"loggedIn":false}'); process.exit(0); }
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const ev = (event) => out({ type: "stream_event", event });

const stdin = await new Promise((resolve) => { let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => resolve(s)); });
const turn = JSON.parse(stdin.trim().split("\n")[0]);
const history = flag("--resume") ? readFileSync(flag("--resume"), "utf8").trim().split("\n").map((l) => JSON.parse(l).message) : [];
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, history, stdin: turn.message }) + "\n");

const content = turn.message.content;
const text = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("");
out({ type: "system", subtype: "init", tools: [] });

let n = 0;
function message(blocks, stop) {
	const id = `msg_fake_${++n}`;
	ev({ type: "message_start", message: { id, type: "message", role: "assistant", model: flag("--model"), content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
			ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else {
			ev({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
			ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		}
		ev({ type: "content_block_stop", index });
		out({ type: "assistant", message: { id, model: flag("--model"), role: "assistant", content: [block] } });
	});
	ev({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
	ev({ type: "message_stop" });
}

if (text === "auth fail") {
	out({ type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Failed to authenticate: OAuth session expired" }] } });
	out({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate" });
	process.exit(1);
} else if (text === "call add") {
	message([{ type: "tool_use", id: "toolu_fake_1", name: "mcp__lh__add", input: { a: 2, b: 3 } }], "tool_use");
	const server = JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.lh;
	const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
	const replies = new Map();
	createInterface({ input: mcp.stdout }).on("line", (line) => { const m = JSON.parse(line); replies.get(m.id)?.(m.result); });
	const rpc = (id, method, params) => new Promise((resolve) => { replies.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
	await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
	const listed = await rpc(2, "tools/list", {});
	if (!listed.tools.some((t) => t.name === "add")) throw new Error("stub did not list add");
	const result = await rpc(3, "tools/call", { name: "add", arguments: { a: 2, b: 3 } });
	mcp.stdin.end();
	message([{ type: "text", text: `result: ${result.content.map((c) => c.text).join("")}${result.isError ? " (error)" : ""}` }], "end_turn");
} else {
	message([{ type: "text", text: `echo: ${text}` }], "end_turn");
}
out({ type: "result", subtype: "success", is_error: false, result: "" });
