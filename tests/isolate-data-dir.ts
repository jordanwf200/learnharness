/**
 * Preloaded into every test process (`npm test` passes --import): points
 * LH_DATA_DIR at a throwaway directory before any app module reads
 * config.ts, so no test can write into the repo's data/ (which may be the
 * learner's synced records repo). Tests that need their own directory still
 * assign LH_DATA_DIR themselves before importing the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.LH_DATA_DIR) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-data-"));
	process.env.LH_DATA_DIR = dir;
	process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
