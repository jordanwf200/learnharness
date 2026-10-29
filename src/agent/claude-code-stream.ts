import { normalizeContext, type Api, type Model, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { CLAUDE_CODE } from "../core/contracts/subscriptions.ts";
import { claudeCodeFetch } from "./claude-code-bridge.ts";

/** The Claude Code catalog is pi-ai's Anthropic catalog under the
 *  `claude-code` route. Mid-conversation system/effort/tool-change messages
 *  are switched off: a CLI session file carries plain user/assistant turns
 *  only, so pi-ai folds those into ordinary messages instead. */
export function toClaudeCodeModel(model: Model<Api>): Model<Api> {
	return {
		...model,
		provider: CLAUDE_CODE.providerId,
		compat: { ...model.compat, supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false },
	} as Model<Api>;
}

/** pi-ai's own Anthropic provider (request building, SSE parsing, usage),
 *  with the CLI as its transport. The CLI holds the credentials, so the key
 *  is a placeholder that only satisfies pi-ai's auth assertion; retries
 *  belong to the CLI. */
export function claudeCodeStream(): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => streamSimple(model as Model<"anthropic-messages">, normalizeContext(context), {
		...options,
		apiKey: "claude-code-cli",
		fetch: claudeCodeFetch,
		maxRetries: 0,
	});
}
