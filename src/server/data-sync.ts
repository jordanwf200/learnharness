/**
 * Git-backed data sync: when the data directory (PATHS.data, LH_DATA_DIR)
 * is itself a git checkout, every change the app writes there (chats, graph
 * ledgers, practice sets, settings) is committed and pushed, so a private
 * remote carries one learner's records between computers.
 *
 *   - startup (instrumentation.ts → startDataSync, before any request):
 *     pull, so every store reads the latest records; then commit + push any
 *     leftovers from a previous run;
 *   - while running: a recursive watcher batches writes (DEBOUNCE_MS after
 *     the last write, at most MAX_WAIT_MS after the first) into one commit,
 *     then pushes. A rejected push rebases onto the remote and retries; a
 *     real conflict aborts the rebase, keeps committing locally and reports
 *     the error instead of guessing a merge;
 *   - process exit: a last synchronous commit + push, best effort.
 *
 * Remote changes are only pulled at startup: the stores cache records in
 * memory, so pulling under a running server would desync them. Quit the app
 * on one computer before continuing on another.
 *
 * Opt out with LH_DATA_SYNC=0. The data repo's .gitignore keeps debug
 * recordings, atomic-write temp files and any credential file out.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { DataSyncStatus } from "../core/contracts/data-sync.ts";

export type { DataSyncStatus };

const DEBOUNCE_MS = 5_000;
const MAX_WAIT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 30_000;

/** Never committed, whatever the data repo's own .gitignore says. */
const IGNORED = ["debug/", "*.tmp-*", ".*.tmp-*", "auth.json", "*-credentials.json*", ".DS_Store"];

interface Options { debounceMs?: number; maxWaitMs?: number; log?: (message: string) => void }

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };

function gitSync(dir: string, args: string[], timeout = NETWORK_TIMEOUT_MS): string {
	return execFileSync("git", args, { cwd: dir, env: GIT_ENV, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function git(dir: string, args: string[], timeout = NETWORK_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd: dir, env: GIT_ENV, timeout, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) reject(new Error((stderr || error.message).trim()));
			else resolve(stdout);
		});
	});
}

/** A commit message that says what was learned, from the staged diff. */
export function describeChanges(numstat: string, nameStatus: string): string {
	const added = new Map<string, number>(), removed = new Map<string, number>();
	for (const line of numstat.trim().split("\n").filter(Boolean)) {
		const [a, d, file] = line.split("\t");
		added.set(file!, Number(a) || 0); removed.set(file!, Number(d) || 0);
	}
	const parts: string[] = [];
	const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
	for (const [file, noun] of [["graph/nodes.jsonl", "graph node"], ["graph/chains.jsonl", "reasoning chain"]] as const) {
		const net = (added.get(file) ?? 0) - (removed.get(file) ?? 0);
		if (net > 0) parts.push(`+${count(net, noun)}`);
		else if (net < 0) parts.push(`-${count(-net, noun)}`);
	}
	let created = 0, updated = 0, deleted = 0, settings = false, other = 0;
	for (const line of nameStatus.trim().split("\n").filter(Boolean)) {
		const [status, ...paths] = line.split("\t");
		const file = paths.at(-1)!;
		if (/^(chats|practice)\/[^/]+\.json$/.test(file)) {
			if (status === "A") created++; else if (status === "D") deleted++; else updated++;
		} else if (file === "settings.json") settings = true;
		else if (!file.startsWith("graph/")) other++;
	}
	if (created) parts.push(`${count(created, "new session")}`);
	if (updated) parts.push(`${count(updated, "session")} updated`);
	if (deleted) parts.push(`${count(deleted, "session")} deleted`);
	if (settings) parts.push("settings updated");
	if (other) parts.push(`${count(other, "other file")}`);
	if (!parts.length) parts.push("graph bookkeeping");
	return `Sync: ${parts.join(", ")}`;
}

export class DataSync {
	private status: DataSyncStatus;
	private timer?: NodeJS.Timeout;
	private firstPending = 0;
	private queue: Promise<void> = Promise.resolve();
	private watcher?: fs.FSWatcher;
	private readonly debounceMs: number;
	private readonly maxWaitMs: number;
	private readonly log: (message: string) => void;

	constructor(readonly dir: string, options: Options = {}) {
		this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
		this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
		this.log = options.log ?? ((message) => console.log(`[data-sync] ${message}`));
		this.status = { state: "idle", remote: this.remote() };
	}

	/** A git checkout of its own (not merely inside the code repo). */
	static enabledFor(dir: string): boolean {
		return process.env.LH_DATA_SYNC !== "0" && fs.existsSync(path.join(dir, ".git"));
	}

	snapshot(): DataSyncStatus { return { ...this.status }; }

	/** Pull first (synchronously: callers start serving only afterwards),
	 *  then publish leftovers and watch for new writes. */
	start(): void {
		try {
			if (this.hasUpstream()) {
				gitSync(this.dir, ["pull", "--rebase", "--autostash", "--quiet"]);
				this.log(`pulled ${this.status.remote}`);
			}
		} catch (error) {
			this.fail(`Pull failed, continuing with local records: ${message(error)}`);
		}
		this.log(`syncing ${this.dir} with ${this.status.remote ?? "no remote (commits stay local)"}`);
		try { this.ensureIgnored(); } catch (error) { this.fail(`Could not update .gitignore: ${message(error)}`); }
		this.watcher = fs.watch(this.dir, { recursive: true }, (_event, file) => {
			if (file && this.relevant(String(file))) this.schedule();
		});
		this.watcher.on("error", (error) => this.fail(`Watcher stopped: ${error.message}`));
		void this.flush();
	}

	stop(): void {
		this.watcher?.close();
		clearTimeout(this.timer);
	}

	/** Commit and push whatever is pending (serialized). */
	flush(): Promise<void> {
		clearTimeout(this.timer); this.timer = undefined; this.firstPending = 0;
		this.queue = this.queue.then(() => this.commitAndPush()).catch((error) => this.fail(message(error)));
		return this.queue;
	}

	/** Best-effort final commit + push for process exit (synchronous). */
	flushSync(): void {
		this.stop();
		try {
			gitSync(this.dir, ["add", "-A"]);
			if (!this.staged()) return;
			gitSync(this.dir, ["commit", "--quiet", "-m", this.message()]);
			if (this.status.remote) gitSync(this.dir, this.hasUpstream() ? ["push", "--quiet"] : ["push", "--quiet", "-u", "origin", "HEAD"], 10_000);
		} catch { /* the next start publishes what is left */ }
	}

	private relevant(file: string): boolean {
		const parts = file.split(path.sep);
		return parts[0] !== ".git" && parts[0] !== "debug" && !/\.tmp-/.test(file);
	}

	private schedule(): void {
		const now = Date.now();
		if (!this.firstPending) this.firstPending = now;
		clearTimeout(this.timer);
		const wait = Math.min(this.debounceMs, Math.max(0, this.firstPending + this.maxWaitMs - now));
		this.timer = setTimeout(() => void this.flush(), wait);
		this.timer.unref?.();
	}

	private async commitAndPush(): Promise<void> {
		this.status = { ...this.status, state: "syncing" };
		await git(this.dir, ["add", "-A"]);
		const staged = await git(this.dir, ["diff", "--cached", "--name-only"]);
		if (staged.trim()) {
			const msg = describeChanges(await git(this.dir, ["diff", "--cached", "--numstat"]), await git(this.dir, ["diff", "--cached", "--name-status"]));
			await git(this.dir, ["commit", "--quiet", "-m", msg]);
			this.status = { ...this.status, lastCommit: { message: msg, at: new Date().toISOString() }, unpushed: true };
			this.log(msg);
		}
		if (this.hasUpstream() ? this.status.unpushed || await this.ahead() : this.status.remote && await this.hasCommits()) await this.push();
		this.status = { ...this.status, state: "idle", error: undefined };
	}

	private async push(): Promise<void> {
		try {
			// A just-created remote has no branch yet: the first push sets it.
			await git(this.dir, this.hasUpstream() ? ["push", "--quiet"] : ["push", "--quiet", "-u", "origin", "HEAD"]);
		} catch (error) {
			// Another computer pushed first: replay ours on top of theirs.
			if (!/rejected|non-fast-forward|fetch first/i.test(message(error))) throw error;
			try {
				await git(this.dir, ["pull", "--rebase", "--quiet"]);
			} catch (rebaseError) {
				await git(this.dir, ["rebase", "--abort"]).catch(() => undefined);
				throw new Error(`Your records changed on another computer and could not be merged automatically (${message(rebaseError)}). They stay committed locally; resolve the conflict in ${this.dir} with git.`);
			}
			await git(this.dir, ["push", "--quiet"]);
		}
		this.status = { ...this.status, unpushed: false, lastPushAt: new Date().toISOString() };
	}

	private async ahead(): Promise<boolean> {
		const count = await git(this.dir, ["rev-list", "--count", "@{upstream}..HEAD"]).catch(() => "0");
		return Number(count.trim()) > 0;
	}

	private async hasCommits(): Promise<boolean> {
		return git(this.dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
	}

	private hasUpstream(): boolean {
		try { gitSync(this.dir, ["rev-parse", "--abbrev-ref", "@{upstream}"], 5_000); return true; } catch { return false; }
	}

	private remote(): string | undefined {
		try { return gitSync(this.dir, ["remote", "get-url", "--push", "origin"], 5_000).trim() || undefined; } catch { return undefined; }
	}

	private staged(): boolean {
		return gitSync(this.dir, ["diff", "--cached", "--name-only"]).trim().length > 0;
	}

	private message(): string {
		return describeChanges(gitSync(this.dir, ["diff", "--cached", "--numstat"]), gitSync(this.dir, ["diff", "--cached", "--name-status"]));
	}

	/** The data repo must never carry secrets or scratch files (its own
	 *  commit, so the first records commit only holds records). */
	private ensureIgnored(): void {
		const file = path.join(this.dir, ".gitignore");
		const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const lines = new Set(existing.split("\n").map((line) => line.trim()));
		const missing = IGNORED.filter((entry) => !lines.has(entry));
		if (!missing.length) return;
		fs.writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
		gitSync(this.dir, ["add", ".gitignore"]);
		gitSync(this.dir, ["commit", "--quiet", "-m", "Keep secrets and scratch files out of sync", "--", ".gitignore"]);
	}

	private fail(error: string): void {
		this.status = { ...this.status, state: "error", error };
		this.log(error);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ─── the process-wide instance ───────────────────────────────────────────────

const KEY = Symbol.for("lh.dataSync");
type Global = typeof globalThis & { [KEY]?: DataSync | null };

/** Start syncing the data directory if it is a git checkout (idempotent;
 *  dev reloads re-import modules, so the instance lives on globalThis). */
export function startDataSync(dir: string = PATHS.data): void {
	const global = globalThis as Global;
	if (global[KEY] !== undefined) return;
	if (!DataSync.enabledFor(dir)) { global[KEY] = null; return; }
	const sync = new DataSync(dir);
	global[KEY] = sync;
	sync.start();
	process.once("exit", () => sync.flushSync());
}

export function dataSyncStatus(): DataSyncStatus {
	return (globalThis as Global)[KEY]?.snapshot() ?? { state: "off" };
}
