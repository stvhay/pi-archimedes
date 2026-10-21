import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Events, emitOn } from "@pi-archimedes/core/events";
import { getBridge } from "@pi-archimedes/core/bridge";
import { type AskQuestion, type AskSelection } from "./selection.js";
import { askSingleQuestionWithInlineNote } from "./picker.js";
import { askQuestionsWithTabs } from "./dialog.js";
import { emitBlocked, blockedLabel } from "./herdr.js";

export function registerIpcRelay(
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | undefined,
	unsubscribes: Array<() => void>,
): void {
	const unsubAskRequest = pi.events.on(Events.ASK_REQUEST, async (payload: unknown) => {
		const data = payload as {
			source: string;
			requestId: string;
			questions: AskQuestion[];
		};

		// Skip main agent — it shows its own UI in the tool handler
		if (data.source === "main") return;

		// Bridge mode: the bridge forwards subagent asks to the Client — the
		// relay must stay inert (per-message gate: registerIpcRelay runs at
		// extension load when bridge.active is false in every mode, and ctx.mode
		// is only captured at the first session_start, so a registration-time
		// gate would silently reintroduce the double-consumption bug).
		if (getBridge().active) return;

		if (!data.questions || data.questions.length === 0) return;

		// Defer to next tick so TUI can process current state
		await new Promise((resolve) => setImmediate(resolve));
		await handleAskRequest(data, getCtx, (active, label) => emitBlocked(pi, active, label), pi.events);
	});
	unsubscribes.push(unsubAskRequest);
}

async function handleAskRequest(
	data: {
		requestId: string;
		questions: AskQuestion[];
	},
	getCtx: () => ExtensionContext | undefined,
	reportBlocked: (active: boolean, label?: string) => void,
	events: EventBus,
): Promise<void> {
	const ctx = getCtx();
	if (!ctx?.ui) return;

	const questions = data.questions;
	let cancelled = true;
	let selections: AskSelection[] = [];

	// Report to herdr's managed extension: the PARENT's TUI is the surface this
	// subagent's dialog appears on (the child process is headless and its own
	// herdr extension is inert). Paired in the finally — the existing catch
	// converts a picker error into a cancelled result, so the dialog always
	// settles.
	reportBlocked(true, blockedLabel(questions));
	try {
		if (questions.length === 1) {
			const q = questions[0]!;
			if (q.multi) {
				// Multi-select single question routes to the tabs dialog (picker doesn't support multi)
				const res = await askQuestionsWithTabs(ctx.ui, questions);
				cancelled = res.cancelled;
				selections = res.selections;
			} else {
				const input: { question: string; description?: string; options: typeof q.options; recommended?: number } = {
					question: q.question,
					options: q.options,
				};
				if (q.description && q.description.trim().length > 0) input.description = q.description;
				if (q.recommended != null) input.recommended = q.recommended;
				const sel = await askSingleQuestionWithInlineNote(ctx.ui, input);
				selections = [sel];
				cancelled = sel.selectedOptions.length === 0 && !sel.customInput;
			}
		} else {
			const res = await askQuestionsWithTabs(ctx.ui, questions);
			cancelled = res.cancelled;
			selections = res.selections;
		}
	} catch {
		cancelled = true;
		selections = questions.map(() => ({ selectedOptions: [] }));
	} finally {
		reportBlocked(false);
	}

	// Build results matching the request's questions
	const results = questions.map((q, i) => {
		const customInput = selections[i]?.customInput;
		return {
			id: q.id,
			selectedOptions: selections[i]?.selectedOptions ?? [],
			...(customInput !== undefined ? { customInput } : {}),
		};
	});

	// Emit on the handle — the parent's streamEvents writes it to the child socket
	emitOn(events, Events.ASK_RESPONSE, {
		requestId: data.requestId,
		cancelled,
		results,
	});
}
