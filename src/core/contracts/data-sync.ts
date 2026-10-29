/** GET /api/data-sync: the git-backed data sync's state
 *  (src/server/data-sync.ts owns it). "off" = the data directory is not
 *  a git checkout, or LH_DATA_SYNC=0. */
export interface DataSyncStatus {
	state: "off" | "idle" | "syncing" | "error";
	/** The data repo's push remote, when sync is on. */
	remote?: string;
	lastCommit?: { message: string; at: string };
	lastPushAt?: string;
	/** Committed locally but not yet on the remote. */
	unpushed?: boolean;
	error?: string;
}
