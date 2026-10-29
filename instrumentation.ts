/** Next's server-start hook: runs once, before the first request is served.
 *  Data sync pulls here so every store reads the latest records. */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { startDataSync } = await import("./src/server/data-sync.ts");
	startDataSync();
}
