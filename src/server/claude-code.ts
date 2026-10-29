/** GET/POST /api/claude-code: the Claude Code CLI connection's status.
 *  GET reads it (re-checked when stale); POST re-checks now (the settings
 *  row's "Check again" after the user logs in from a terminal). Login and
 *  logout stay in the CLI: the app never touches its credentials. */

import { refreshClaudeCodeStatus } from "../agent/claude-code-cli.ts";

export async function claudeCodeStatusResponse(request: Request): Promise<Response> {
	const status = await refreshClaudeCodeStatus(request.method === "POST");
	return Response.json(status, { headers: { "cache-control": "no-store" } });
}
