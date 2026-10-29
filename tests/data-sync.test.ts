import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataSync, describeChanges } from "../src/server/data-sync.ts";

// A bare repo stands in for the GitHub remote; each clone is one computer.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-data-sync-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let n = 0;

function setup(): { remote: string; computer: (name: string) => string } {
	const remote = path.join(root, `remote-${++n}.git`);
	execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
	const seed = path.join(root, `seed-${n}`);
	execFileSync("git", ["clone", "--quiet", remote, seed], { stdio: "ignore" });
	identity(seed);
	fs.writeFileSync(path.join(seed, "README.md"), "records\n");
	git(seed, "add", "-A"); git(seed, "commit", "--quiet", "-m", "init"); git(seed, "push", "--quiet", "-u", "origin", "main");
	return {
		remote,
		computer: (name) => {
			const dir = path.join(root, `${name}-${n}`);
			execFileSync("git", ["clone", "--quiet", remote, dir], { stdio: "ignore" });
			identity(dir);
			return dir;
		},
	};
}
function identity(dir: string) { git(dir, "config", "user.name", "Learner"); git(dir, "config", "user.email", "learner@example.invalid"); }
const write = (dir: string, file: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), body); };
const remoteLog = (remote: string) => git(remote, "log", "--format=%s", "main").split("\n");
const quiet = { debounceMs: 50, maxWaitMs: 500, log: () => {} };

test("commit messages say what was learned", () => {
	assert.equal(describeChanges("3\t0\tgraph/nodes.jsonl\n1\t0\tgraph/chains.jsonl\n40\t2\tchats/a.json", "M\tgraph/nodes.jsonl\nM\tgraph/chains.jsonl\nA\tchats/a.json"), "Sync: +3 graph nodes, +1 reasoning chain, 1 new session");
	assert.equal(describeChanges("5\t5\tchats/a.json\n1\t1\tchats/b.json", "M\tchats/a.json\nM\tchats/b.json"), "Sync: 2 sessions updated");
	assert.equal(describeChanges("0\t2\tgraph/nodes.jsonl\n0\t9\tchats/a.json", "M\tgraph/nodes.jsonl\nD\tchats/a.json"), "Sync: -2 graph nodes, 1 session deleted");
	assert.equal(describeChanges("1\t1\tsettings.json\n1\t0\tprompts/x.md", "M\tsettings.json\nA\tprompts/x.md"), "Sync: settings updated, 1 other file");
	assert.equal(describeChanges("1\t0\tgraph/coverage.jsonl", "M\tgraph/coverage.jsonl"), "Sync: graph bookkeeping");
});

test("sync is on only for a data directory that is its own git checkout", () => {
	const { computer } = setup();
	const dir = computer("laptop");
	assert.equal(DataSync.enabledFor(dir), true);
	assert.equal(DataSync.enabledFor(path.join(dir, "chats")), false);
	process.env.LH_DATA_SYNC = "0";
	try { assert.equal(DataSync.enabledFor(dir), false); } finally { delete process.env.LH_DATA_SYNC; }
});

test("startup pulls the other computer's records, then a write is committed and pushed", async () => {
	const { remote, computer } = setup();
	const laptop = computer("laptop"), desktop = computer("desktop");
	write(desktop, "chats/c1.json", "{}\n"); git(desktop, "add", "-A"); git(desktop, "commit", "--quiet", "-m", "from desktop"); git(desktop, "push", "--quiet");

	const sync = new DataSync(laptop, quiet);
	sync.start();
	try {
		assert(fs.existsSync(path.join(laptop, "chats/c1.json")), "pulled before serving");
		write(laptop, "graph/nodes.jsonl", '{"id":"n1"}\n{"id":"n2"}\n');
		for (let i = 0; i < 100 && remoteLog(remote)[0] !== "Sync: +2 graph nodes"; i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(remoteLog(remote)[0], "Sync: +2 graph nodes");
		await sync.flush(); // the push lands on the remote just before it returns
		const status = sync.snapshot();
		assert.equal(status.state, "idle");
		assert.equal(status.unpushed, false);
		assert.equal(status.lastCommit?.message, "Sync: +2 graph nodes");
	} finally { sync.stop(); }
});

test("a push rejected because the other computer pushed first rebases and retries", async () => {
	const { remote, computer } = setup();
	const laptop = computer("laptop"), desktop = computer("desktop");
	const sync = new DataSync(laptop, quiet);
	sync.start(); sync.stop(); await sync.flush();

	git(desktop, "pull", "--quiet");
	write(desktop, "chats/d.json", "{}\n"); git(desktop, "add", "-A"); git(desktop, "commit", "--quiet", "-m", "from desktop"); git(desktop, "push", "--quiet");
	write(laptop, "chats/l.json", "{}\n");
	await sync.flush();
	assert.deepEqual(remoteLog(remote).slice(0, 2), ["Sync: 1 new session", "from desktop"]);
	assert.equal(sync.snapshot().state, "idle");
});

test("a real conflict stops pushing, keeps the local commit and explains", async () => {
	const { remote, computer } = setup();
	const laptop = computer("laptop"), desktop = computer("desktop");
	const sync = new DataSync(laptop, quiet);
	sync.start(); sync.stop(); await sync.flush();

	git(desktop, "pull", "--quiet");
	write(desktop, "settings.json", '{"from":"desktop"}\n'); git(desktop, "add", "-A"); git(desktop, "commit", "--quiet", "-m", "desktop settings"); git(desktop, "push", "--quiet");
	write(laptop, "settings.json", '{"from":"laptop"}\n');
	await sync.flush();
	const status = sync.snapshot();
	assert.equal(status.state, "error");
	assert.match(status.error ?? "", /another computer/);
	assert.equal(status.unpushed, true);
	assert.equal(git(laptop, "log", "-1", "--format=%s"), "Sync: settings updated", "kept locally");
	assert.equal(remoteLog(remote)[0], "desktop settings", "remote untouched");
	assert(!fs.existsSync(path.join(laptop, ".git", "rebase-merge")), "no rebase left half-done");
});

test("secrets, temp files and debug recordings never reach the remote", async () => {
	const { remote, computer } = setup();
	const laptop = computer("laptop");
	const sync = new DataSync(laptop, quiet);
	sync.start(); sync.stop();
	for (const file of ["auth.json", "chatgpt-credentials.json", "graph/nodes.jsonl.tmp-1a2b3c4d", "debug/provider-events/c.jsonl"]) write(laptop, file, "secret\n");
	write(laptop, "chats/ok.json", "{}\n");
	await sync.flush();
	const tracked = git(remote, "ls-tree", "-r", "--name-only", "main").split("\n");
	assert.deepEqual(tracked.sort(), [".gitignore", "README.md", "chats/ok.json"]);
});

test("an empty, just-created remote gets its first branch from the first sync", async () => {
	const remote = path.join(root, `empty-${++n}.git`);
	execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
	const laptop = path.join(root, `empty-laptop-${n}`);
	execFileSync("git", ["clone", "--quiet", remote, laptop], { stdio: "ignore" });
	identity(laptop);
	const sync = new DataSync(laptop, quiet);
	sync.start(); sync.stop();
	write(laptop, "chats/first.json", "{}\n");
	await sync.flush();
	assert.deepEqual(remoteLog(remote), ["Sync: 1 new session", "Keep secrets and scratch files out of sync"]);
	assert.equal(git(laptop, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
});
