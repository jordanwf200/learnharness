"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CLAUDE_CODE, type ClaudeCodeConnectionStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionRow } from "./connection-controls";

/** The Claude Code CLI connection (GET/POST /api/claude-code). There is no
 *  in-app login: the CLI owns its credentials, so the row reports what the
 *  installed `claude` is logged in as and how to fix it when it is not. */
export function ClaudeCodeConnection({ labelClassName }: { labelClassName?: string }) {
	const [status, setStatus] = useState<ClaudeCodeConnectionStatus>({ state: "unknown" });
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const last = useRef<string | undefined>(undefined);

	const check = useCallback(async (force: boolean) => {
		setBusy(true);
		try {
			const response = await fetch("/api/claude-code", { method: force ? "POST" : "GET" });
			if (!response.ok) throw new Error(String(response.status));
			const next = await response.json() as ClaudeCodeConnectionStatus;
			setStatus(next); setFailed(false);
			// A changed state changes which models the pickers may offer.
			if (last.current !== undefined && last.current !== next.state) notifySettingsSaved("keys");
			last.current = next.state;
		} catch { setFailed(true); } finally { setBusy(false); }
	}, []);
	useEffect(() => { void check(false); }, [check]);

	return <div className="flex flex-col gap-2" data-testid="claude-code-connection">
		<ConnectionRow label={CLAUDE_CODE.label} labelClassName={labelClassName} action="Check again" actionTestid="claude-code-check" disabled={busy} onAction={() => void check(true)}>
			<span className="font-ui text-xs text-muted-foreground" data-testid="claude-code-state">{summary(status, busy)}</span>
		</ConnectionRow>
		{failed && <p role="alert" className="text-xs text-red-400">The Claude Code status could not be read. Try again.</p>}
		{!failed && hint(status) && <p className="font-ui text-xs text-muted-foreground">{hint(status)}</p>}
	</div>;
}

function summary(status: ClaudeCodeConnectionStatus, busy: boolean): string {
	switch (status.state) {
		case "unknown": return busy ? "Checking…" : "Not checked";
		case "missing": return "CLI not found";
		case "logged-out": return "Not logged in";
		case "error": return "Status unavailable";
		case "ready": return ["Connected", status.email, status.plan && `(${status.plan})`].filter(Boolean).join(" ");
	}
}

function hint(status: ClaudeCodeConnectionStatus): string | undefined {
	switch (status.state) {
		case "missing": return "Install Claude Code, or set LH_CLAUDE_CODE_PATH to the claude binary, then check again.";
		case "logged-out": return "Run `claude auth login` in a terminal, then check again.";
		case "error": return status.message;
		case "ready": return "Requests run through the claude CLI on this machine and count toward that login's plan limits.";
		default: return undefined;
	}
}
