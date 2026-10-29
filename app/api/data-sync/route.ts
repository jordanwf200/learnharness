import { dataSyncStatus } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(): Response {
	return Response.json(dataSyncStatus(), { headers: { "cache-control": "no-store" } });
}
