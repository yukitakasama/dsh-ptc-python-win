/**
     * Browser half of dsh-ptc-python-win: the `run_code` tool-call card.
     *
     * WHY THIS FILE EXISTS
     * --------------------
     * The core row for `run_code` (package `@deepseek-ai/dsh-client-ui-tool`,
     * `lib/client.js`, branch `variant === "code"`) renders its program with
     * `lang: "typescript"` hard-coded, so a session running this Python runtime still
     * shows a `typescript` badge and TypeScript highlighting. The tool-call payload
     * does not carry a language either (`presentCall` returns only `title`/`kind`/
     * `rawInput`), so the language has to be derived on the client from the session's
     * agent preset.
     *
     * This module registers a keyed `run_code` row for `tool.call.toolview`, which
     * replaces the generic core row. The language comes from the session projection
     * `agentPreset`: presets listed in `PYTHON_PRESETS` get `python`, everything else
     * keeps `typescript` (the built-in `ptc` preset executes TypeScript).
     *
     * The file is a hand-written client bundle (no build step), mirroring the shape of
     * `@deepseek-ai/dsh-client-ui-brand-official/lib/client.js`. Keep it dependency-free
     * apart from the modules the web frontend injects statically.
     * @module dsh-ptc-python-win/client
     */

    window.__ModuleLoader__.load({
    	id: "dsh-ptc-python-win",
    	factory: (require) => {
    		var module = { exports: {} };
    		var exports = module.exports;
    		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    		const react = require("react");
    		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    		const h = react.createElement;

    		/** Preset ids whose `run_code` programs are Python. Add cloned preset ids here. */
    		const PYTHON_PRESETS = ["ptc-python"];
    		const PYTHON_LANGUAGE = "python";
    		const FALLBACK_LANGUAGE = "typescript";
    		const SLOT_NAME = "tool.call.toolview";
    		const CONVERSATION_NS = "conversation";
    		const CSS_ID = "dsh-ptc-python-win/run-code.module.css";

    		/**
    		 * Language a session's `run_code` programs are written in.
    		 * Unknown or missing presets keep the preceding core behaviour (TypeScript).
    		 * @param {unknown} agentPreset - the session projection `agentPreset`.
    		 * @returns {"python" | "typescript"} syntax-highlighting language id.
    		 */
    		function programLanguage(agentPreset) {
    			if (typeof agentPreset !== "string") return FALLBACK_LANGUAGE;
    			return PYTHON_PRESETS.indexOf(agentPreset.trim()) === -1 ? FALLBACK_LANGUAGE : PYTHON_LANGUAGE;
    		}

    		/**
    		 * Collapse a multi-line string to its first non-empty line, the way the core
    		 * tool row summarizes arguments and error text.
    		 * @param {unknown} value - text to collapse.
    		 * @returns {string} trimmed first line (possibly empty).
    		 */
    		function firstLine(value) {
    			if (typeof value !== "string" || value === "") return "";
    			const lines = value.trimStart().split(/\r?\n/);
    			return (lines[0] ?? "").trimEnd();
    		}

    		/**
    		 * @param {unknown} raw - raw JSON argument text from the tool call.
    		 * @returns {Record<string, unknown> | undefined} parsed object, or undefined.
    		 */
    		function parseArgs(raw) {
    			if (typeof raw !== "string" || raw.trim() === "") return undefined;
    			try {
    				const parsed = JSON.parse(raw);
    				return parsed !== null && typeof parsed === "object" ? parsed : undefined;
    			} catch {
    				return undefined;
    			}
    		}

    		/**
    		 * @param {Record<string, unknown> | undefined} args - parsed arguments.
    		 * @param {string} key - property to read.
    		 * @returns {string | undefined} non-blank string value.
    		 */
    		function stringArg(args, key) {
    			if (args === undefined) return undefined;
    			const value = args[key];
    			return typeof value === "string" && value.trim() !== "" ? value : undefined;
    		}

    		/**
    		 * Program text for the expanded body: the `code` argument when present,
    		 * otherwise the argument object as pretty JSON, otherwise nothing.
    		 * @param {string | null} argsRaw - raw argument text (`null` while neither prepared nor started).
    		 * @returns {string | null} program body, or null when there is nothing to show.
    		 */
    		function programBody(argsRaw) {
    			if (argsRaw === null || argsRaw === "") return null;
    			const args = parseArgs(argsRaw);
    			if (args === undefined) return null;
    			const code = stringArg(args, "code");
    			if (code !== undefined) return code;
    			return JSON.stringify(args, null, 2) ?? null;
    		}

    		/**
    		 * Model-facing result text of a settled call.
    		 * @param {Record<string, any>} block - settled tool-call block.
    		 * @returns {string} concatenated result text.
    		 */
    		function resultText(block) {
    			const content = Array.isArray(block?.content) ? block.content : [];
    			let text = "";
    			for (const item of content) {
    				if (item !== null && typeof item === "object" && item.type === "text" && typeof item.text === "string") text += item.text;
    				else text += JSON.stringify(item, null, 2);
    			}
    			if (text === "" && block?.error !== undefined && block.error !== null) {
    				return `${String(block.error.name ?? "")}: ${String(block.error.code ?? "")}`;
    			}
    			return text;
    		}

    		/**
    		 * Derive the row state, summary, program body and output for one call block.
    		 * Mirrors the core `toolRowModel`/`formatToolBody` behaviour for the code variant.
    		 * @param {Record<string, any>} block - tool-call block (streaming or settled).
    		 * @returns {{ state: string, summary: string, code: string | null, output: string | null }} row model.
    		 */
    		function rowModel(block) {
    			const settled = block !== null && typeof block === "object" && "kind" in block;
    			const argsRaw = settled ? (block.call?.argsRaw ?? "") : block?.phase === "start" ? block.argsRaw : null;

    			let state = "running";
    			if (!settled) state = block?.phase === "preparing" ? "preparing" : "running";
    			else if (block?.error?.code === "interrupted") state = "stopped";
    			else if (block?.isError === true || block?.meta?.stopped === true) state = "error";
    			else state = "ok";

    			let description;
    			if (state === "preparing") {
    				try {
    					description = block?.args?.text?.("description");
    				} catch {
    					description = undefined;
    				}
    			}
    			if (description === undefined) description = stringArg(parseArgs(argsRaw), "description");
    			const summary = firstLine(description ?? argsRaw ?? "");

    			return {
    				state,
    				summary,
    				code: programBody(argsRaw),
    				output: settled ? resultText(block) || null : null,
    			};
    		}

    		/* Chrome for the row, mirroring the core bash/run_code row layout. */
    		const CSS = `
    .ptc-rc{display:flex;flex-direction:column}
    .ptc-rc-root{display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);transition:color .1s}
    .ptc-rc-root[data-expandable]{cursor:pointer}
    @media (hover:hover){.ptc-rc-root:hover{color:var(--dsw-alias-label-secondary)}}
    @media (prefers-reduced-motion:reduce){.ptc-rc-root{transition:none}}
    .ptc-rc-leading{position:relative;display:inline-flex;justify-content:center;align-items:center;flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));margin-right:6px;color:inherit}
    .ptc-rc-leading svg:not([data-state]){width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}
    .ptc-rc-chevron{color:inherit}
    .ptc-rc-icon{display:inline-flex;opacity:1;transition:opacity .1s}
    .ptc-rc-chevron-hover{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity .1s}
    @media (hover:hover){.ptc-rc-root:hover .ptc-rc-icon{opacity:0}.ptc-rc-root:hover .ptc-rc-chevron-hover{opacity:1}}
    .ptc-rc-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
    .ptc-rc-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
    .ptc-rc-summary{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
    .ptc-rc-summary[data-error]{color:var(--dsw-alias-state-error-primary)}
    .ptc-rc-summary[data-stopped]{color:var(--dsw-alias-state-warn-label)}
    .ptc-rc-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .ptc-rc-body{display:flex;flex-direction:column}
    .ptc-rc-code{margin:4px 0 4px 4px}
    .ptc-rc-io{display:flex;flex-direction:column;margin:4px 0 4px 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}
    .ptc-rc-section{display:grid;grid-template-columns:max-content 1fr;column-gap:14px;align-items:baseline;max-height:150px;padding:12px 16px;overflow-y:auto}
    .ptc-rc-label{position:sticky;top:0;align-self:start;color:var(--dsw-alias-label-caption)}
    .ptc-rc-text{min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
    .ptc-rc-text[data-error]{color:var(--dsw-alias-state-error-primary)}
    `;

    		const CLASS = {
    			container: "ptc-rc",
    			root: "ptc-rc-root",
    			leading: "ptc-rc-leading",
    			chevron: "ptc-rc-chevron",
    			icon: "ptc-rc-icon",
    			chevronHover: "ptc-rc-chevron-hover",
    			title: "ptc-rc-title",
    			sep: "ptc-rc-sep",
    			summary: "ptc-rc-summary",
    			body: "ptc-rc-body",
    			code: "ptc-rc-code",
    			io: "ptc-rc-io",
    			section: "ptc-rc-section",
    			label: "ptc-rc-label",
    			text: "ptc-rc-text",
    		};

    		/** Mount the row stylesheet once per page. */
    		function injectStyle() {
    			if (typeof document === "undefined") return;
    			if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
    			const style = document.createElement("style");
    			style.dataset.pluginCss = CSS_ID;
    			style.textContent = CSS;
    			document.head.append(style);
    		}

    		/**
    		 * Keyed `run_code` row: core row chrome with a preset-aware program language.
    		 * @param {Record<string, any>} props - session-scoped tool-view props.
    		 * @returns {import("react").ReactElement} the row element.
    		 */
    		function RunCodeRow(props) {
    			const { block, sessionId, t, useSessions, useDisclosure } = props;
    			const model = react.useMemo(() => rowModel(block), [block]);
    			const disclosure = useDisclosure();
    			const expanded = disclosure?.expanded === true;
    			const toggle = typeof disclosure?.toggle === "function" ? disclosure.toggle : () => {};

    			const agentPreset = useSessions((state) => state?.byId?.[sessionId]?.projectionValues?.agentPreset);
    			const lang = programLanguage(agentPreset);

    			const expandable = model.code !== null || model.output !== null;
    			const open = expandable && expanded;
    			const running = model.state === "running" || model.state === "preparing";
    			const settlement =
    				model.state === "error"
    					? model.output === null ? undefined : firstLine(model.output)
    					: model.state === "stopped" ? t("bash.stopped") : undefined;
    			const summary = settlement ?? model.summary;
    			const title = t("tool.title.code");

    			const onKeyDown = (event) => {
    				if (event.key !== "Enter" && event.key !== " ") return;
    				event.preventDefault();
    				toggle();
    			};

    			const icon = h(primitives.IconCodeOutlineRegular, { size: 14 });
    			const leading = open
    				? h(primitives.IconChevronUpOutlineRegular, { className: CLASS.chevron, key: "chevron" })
    				: expandable
    					? [
    						h("span", { className: CLASS.icon, key: "icon" }, icon),
    						h(primitives.IconChevronDownOutlineRegular, { className: CLASS.chevronHover, key: "hover" }),
    					]
    					: icon;

    			const header = h(
    				"div",
    				{
    					className: CLASS.root,
    					"data-state": model.state,
    					"data-expandable": expandable ? "" : undefined,
    					role: expandable ? "button" : undefined,
    					tabIndex: expandable ? 0 : undefined,
    					"aria-expanded": expandable ? open : undefined,
    					"aria-label": summary === "" ? title : `${title} ${summary}`,
    					onClick: expandable ? toggle : undefined,
    					onKeyDown: expandable ? onKeyDown : undefined,
    				},
    				h("span", { className: CLASS.leading }, leading),
    				h("span", { className: CLASS.title }, running ? h(primitives.TextShimmer, { active: true }, title) : title),
    				summary === ""
    					? null
    					: h("span", { className: CLASS.sep, "aria-hidden": true }),
    				summary === ""
    					? null
    					: h(
    						"span",
    						{
    							className: CLASS.summary,
    							"data-error": model.state === "error" ? "" : undefined,
    							"data-stopped": model.state === "stopped" ? "" : undefined,
    						},
    						running ? h(primitives.TextShimmer, { active: true }, summary) : summary,
    					),
    			);

    			const bodyChildren = [];
    			if (model.code !== null) {
    				bodyChildren.push(
    					h(primitives.CodeBlock, {
    						key: "code",
    						code: model.code,
    						lang,
    						className: CLASS.code,
    						copyLabel: t("copy"),
    						copiedLabel: t("copied"),
    						toolbarLabels: {
    							codeLabel: t("codeBlock.title"),
    							wrapLabel: t("codeBlock.wrap"),
    							unwrapLabel: t("codeBlock.unwrap"),
    						},
    					}),
    				);
    			}
    			if (model.output !== null) {
    				bodyChildren.push(
    					h(
    						"div",
    						{ className: CLASS.io, key: "io" },
    						h(
    							"div",
    							{ className: CLASS.section },
    							h("span", { className: CLASS.label }, t("row.output")),
    							h(
    								"span",
    								{ className: CLASS.text, "data-error": model.state === "error" ? "" : undefined },
    								model.output,
    							),
    						),
    					),
    				);
    			}

    			const body = open && bodyChildren.length > 0 ? h("div", { className: CLASS.body }, bodyChildren) : null;

    			return h("div", { className: CLASS.container }, header, body);
    		}

    		/**
    		 * Install the row. `ctx.slots.inject` waits for the slot to be declared by the
    		 * core tool-call tree, so module load order does not matter.
    		 * @param {any} ctx - client plugin context.
    		 */
    		function apply(ctx) {
    			injectStyle();
    			ctx.slots.inject(SLOT_NAME, () =>
    				ctx.slots.register({ name: SLOT_NAME, key: "run_code", locale: CONVERSATION_NS }, RunCodeRow),
    			);
    		}

    		const inject = ["slots"];

    		exports.apply = apply;
    		exports.inject = inject;
    		exports.__testProgramLanguage = programLanguage;
    		return module.exports;
    	},
    });
    