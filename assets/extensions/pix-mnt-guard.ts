// pix-mnt-guard v1
/**
 * pix-mnt-guard — /mnt permission middleware for pi on WSL.
 *
 * Installed by pix into <PI_CODING_AGENT_DIR>/extensions/.
 *
 * Middleware design:
 *   Stage 1 (MATCH):   extract every /mnt path reference from the tool call.
 *                      No reference -> return undefined (pass through, zero interference).
 *   Stage 2 (DECIDE):  /mnt involved ->
 *                        write/edit        -> hard block
 *                        bash (write-ish)  -> hard block
 *                        read/ls/grep/find -> ask the user
 *                        bash (read-ish)   -> ask the user
 *                        unknown tools     -> ask the user (fail-safe)
 *                      No UI (print/json mode) -> block (fail-closed).
 *
 * `cd /mnt/...` inside a bash command counts as touching /mnt.
 *
 * Note: this is an application-level policy hook, not a security boundary.
 * Obfuscated bash (variable splicing, globs like /m?t) can evade string
 * matching. Use pix --sandbox for mount-level isolation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

/** Absolute path boundary test: matches /mnt, /mnt/..., but not /mntx. */
const MNT_ABS_RE = /^\/mnt(?:\/|$)/;

/** Literal /mnt references inside arbitrary strings (bash commands, args). */
const MNT_LITERAL_RE = /\/mnt(?![\w.-])(?:\/[^\s"'`;&|()<>\\]*)?/g;

/** Tools whose input.path is a write target. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Input keys that commonly carry a single path. */
const PATH_KEYS = new Set(["path", "file", "filePath", "filepath", "source", "destination", "target", "cwd", "dir", "directory"]);

/** bash commands that always mutate their target. */
const BASH_ALWAYS_WRITE_RE =
	/(?:^|[\s;|&(`])(?:sudo\s+)?(?:rm|rmdir|mv|mkdir|touch|chmod|chown|chgrp|ln|install|truncate|shred|mkfifo|mknod|patch|tar|vi|vim|nvim|nano|emacs|code)(?:\s|$)/;

/** sed with in-place edit. */
const BASH_SED_I_RE = /(?:^|[\s;|&(`])(?:sudo\s+)?sed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\b|[^;|&]*\s-i\b)/;

/** git subcommands that mutate config/metadata in the target. */
const BASH_GIT_WRITE_RE = /(?:^|[\s;|&(`])git\s+(?:config|init|clone)(?:\s|$)/;

/** Redirection whose target is a /mnt path: >, >> (including 2>/mnt/... etc). */
const BASH_REDIRECT_TO_MNT_RE = /\d?>>?\s*\/mnt(?![\w.-])/;

/** dd writing to /mnt: dd ... of=/mnt/... */
const BASH_DD_OF_MNT_RE = /(?:^|[\s;|&(`])dd\b[^;|&]*\bof=\/mnt(?![\w.-])/;

/** Copy-like commands: write iff the LAST positional token is a /mnt path. */
const BASH_COPY_CMD_RE = /^(?:sudo\s+)?(?:cp|rsync|scp)$/;

function isMntAbs(p: string): boolean {
	return MNT_ABS_RE.test(p);
}

function scanLiteralRefs(text: string, out: Set<string>): void {
	MNT_LITERAL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MNT_LITERAL_RE.exec(text)) !== null) {
		if (m[0].length >= 4) out.add(m[0]);
	}
}

function walkStrings(value: unknown, out: Set<string>): void {
	if (typeof value === "string") {
		scanLiteralRefs(value, out);
	} else if (Array.isArray(value)) {
		for (const item of value) walkStrings(item, out);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) walkStrings(item, out);
	}
}

/**
 * Stage 1: collect every /mnt path referenced by this tool call.
 * Returns an empty array when the call does not touch /mnt at all.
 */
function extractMntRefs(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const refs = new Set<string>();

	// Path-like fields: resolve relative paths against the session cwd.
	for (const [key, value] of Object.entries(input ?? {})) {
		if (!PATH_KEYS.has(key)) continue;
		const values = Array.isArray(value) ? value : [value];
		for (const v of values) {
			if (typeof v !== "string" || v.length === 0) continue;
			const resolved = v.startsWith("/") ? path.posix.normalize(v) : path.posix.resolve(cwd, v);
			if (isMntAbs(resolved)) refs.add(resolved);
		}
	}

	// Literal scan of every string in the input (bash commands, unknown tools).
	walkStrings(input, refs);

	return [...refs];
}

function tokenize(command: string): string[] {
	return command.split(/[\s;|&()]+/).filter((t) => t.length > 0);
}

/** Stage 2 helper: classify a bash command that references /mnt. */
function bashIntent(command: string): "read" | "write" {
	if (BASH_REDIRECT_TO_MNT_RE.test(command)) return "write";
	if (BASH_DD_OF_MNT_RE.test(command)) return "write";
	if (BASH_SED_I_RE.test(command)) return "write";
	if (BASH_GIT_WRITE_RE.test(command)) return "write";
	if (BASH_ALWAYS_WRITE_RE.test(command)) return "write";

	// cp/rsync/scp: /mnt as final destination means write; /mnt only as source means read.
	const tokens = tokenize(command);
	const cmd = tokens.findIndex((t) => BASH_COPY_CMD_RE.test(t));
	if (cmd !== -1) {
		const args = tokens.slice(cmd + 1).filter((t) => !t.startsWith("-"));
		const last = args[args.length - 1];
		if (last && MNT_LITERAL_RE.test(last)) {
			MNT_LITERAL_RE.lastIndex = 0;
			return "write";
		}
		MNT_LITERAL_RE.lastIndex = 0;
	}

	return "read";
}

function blockReason(toolName: string, refs: string[]): string {
	return (
		`Blocked by pix-mnt-guard: writes to Windows drives (/mnt) are forbidden ` +
		`(tool "${toolName}" -> ${refs.join(", ")}). ` +
		`Work inside the projected WSL workspace instead, or ask the user to run the command manually.`
	);
}

export default function (pi: ExtensionAPI) {
	// Session-scoped approval cache. Seeded with the session cwd: if the user
	// launched pi from a /mnt directory, that tree is implicitly approved.
	const approvedPrefixes: string[] = [];

	function isApproved(ref: string): boolean {
		return approvedPrefixes.some((p) => ref === p || ref.startsWith(p.endsWith("/") ? p : p + "/"));
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isMntAbs(ctx.cwd) && !isApproved(ctx.cwd)) {
			approvedPrefixes.push(ctx.cwd);
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus("mnt-guard", "🛡 /mnt guarded");
		}
	});

	// ── Middleware body ──────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		const refs = extractMntRefs(event.toolName, event.input as Record<string, unknown>, ctx.cwd);

		// Not touching /mnt -> pass through untouched.
		if (refs.length === 0) return undefined;

		const unapproved = refs.filter((r) => !isApproved(r));
		if (unapproved.length === 0) return undefined;

		// ── Stage 2: DECIDE ────────────────────────────────────────────

		// Hard block: explicit write tools.
		if (WRITE_TOOLS.has(event.toolName)) {
			if (ctx.hasUI) ctx.ui.notify(`Blocked write to /mnt: ${unapproved.join(", ")}`, "warning");
			return { block: true, reason: blockReason(event.toolName, unapproved) };
		}

		// bash: classify intent; write-ish commands are hard-blocked.
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: string }).command ?? "");
			if (bashIntent(command) === "write") {
				if (ctx.hasUI) ctx.ui.notify(`Blocked /mnt write via bash: ${command}`, "warning");
				return { block: true, reason: blockReason(event.toolName, unapproved) };
			}
		}

		// Everything else is treated as a read -> ask the user.
		if (!ctx.hasUI) {
			// print/json mode: fail closed.
			return {
				block: true,
				reason:
					`Blocked by pix-mnt-guard: /mnt access requires user confirmation, ` +
					`but no interactive UI is available (tool "${event.toolName}" -> ${unapproved.join(", ")}).`,
			};
		}

		const description =
			event.toolName === "bash"
				? `command:\n  ${String((event.input as { command?: string }).command ?? "")}`
				: `${event.toolName} -> ${unapproved.join(", ")}`;

		const choice = await ctx.ui.select(
			`⚠️ Tool "${event.toolName}" wants to READ from a Windows drive (/mnt):\n\n  ${description}\n\nAllow?`,
			["Allow once", "Trust this path for session", "Deny"],
		);

		if (choice === "Allow once") return undefined;

		if (choice === "Trust this path for session") {
			for (const ref of unapproved) {
				if (!isApproved(ref)) approvedPrefixes.push(ref);
			}
			ctx.ui.notify(`Trusted for this session: ${unapproved.join(", ")}`, "info");
			return undefined;
		}

		return {
			block: true,
			reason: `Blocked by user via pix-mnt-guard: /mnt access denied (${unapproved.join(", ")}).`,
		};
	});
}
