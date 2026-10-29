"use client";

import { useEffect, useState } from "react";
import type { DataSyncStatus } from "@/src/core";
import { SettingsRow } from "./controls.tsx";

/** Settings → General: whether learning records sync to a git remote
 *  (GET /api/data-sync), and the error to act on when they cannot. */
export function DataSyncRow() {
	const [status, setStatus] = useState<DataSyncStatus | undefined>(undefined);
	useEffect(() => {
		let live = true;
		const read = () => fetch("/api/data-sync").then((r) => r.ok ? r.json() as Promise<DataSyncStatus> : undefined).then((s) => { if (live && s) setStatus(s); }).catch(() => undefined);
		void read();
		const timer = setInterval(read, 5000);
		return () => { live = false; clearInterval(timer); };
	}, []);
	if (!status) return null;
	return <SettingsRow label="Data sync" testid="row-data-sync" hint={<>
		<span className="block">{hint(status)}</span>
		{status.state === "error" && <span role="alert" className="block text-red-400">{status.error}</span>}
	</>}>
		<span className="shrink-0 font-ui text-xs text-muted-foreground" data-testid="data-sync-state">{label(status)}</span>
	</SettingsRow>;
}

function label(status: DataSyncStatus): string {
	switch (status.state) {
		case "off": return "Off";
		case "syncing": return "Syncing…";
		case "error": return status.unpushed ? "Not pushed" : "Error";
		case "idle": return status.unpushed ? "Not pushed" : "Up to date";
	}
}

function hint(status: DataSyncStatus): string {
	if (status.state === "off") return "Clone a private git repo into the data directory to sync chats and the knowledge graph between computers.";
	const remote = status.remote?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") ?? "local only";
	const last = status.lastCommit ? ` · last: ${status.lastCommit.message.replace(/^Sync: /, "")}` : "";
	return `Commits and pushes every change to ${remote}${last}`;
}
