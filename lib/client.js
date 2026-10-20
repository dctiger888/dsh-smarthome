window.__ModuleLoader__.load({
	id: "dsh-smarthome",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#endregion
		//#region src/client/dashboard.ts
		function locationOf(context) {
			return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
		}
		function isDashboardMeta(meta) {
			return typeof meta === "object" && meta !== null && meta.kind === "smarthome-dashboard";
		}
		/**
		* One dashboard call is a single checkpoint event: `ha_dashboard` returns the
		* WHOLE snapshot in `tool/result` meta, so each event carries complete
		* fallback state and no event correlation is needed.
		*/
		const dashboardDefinition = {
			kind: "smarthome-dashboard",
			target: "chat",
			match: (event) => {
				if (event.type !== "tool/result") return null;
				if (!isDashboardMeta(event.data.meta)) return null;
				const block = event.data.message.content[0];
				return {
					id: block !== void 0 && block.type === "tool-result" ? String(block.toolCallId) : String(event.seq),
					role: "start"
				};
			},
			start: (_context, match, _reader) => {
				if (match.event.type !== "tool/result" || !isDashboardMeta(match.event.data.meta)) throw new Error("smarthome-dashboard requires a tool/result carrying dashboard meta");
				return {
					turn: match.event.data.turn,
					step: match.event.data.step,
					snapshot: match.event.data.meta
				};
			},
			update: (context) => context.state,
			publication: () => "immediate",
			buildViewNode: (context) => {
				if (context.state === void 0) return null;
				return {
					key: context.key,
					kind: "smarthome-dashboard",
					id: context.id,
					target: "chat",
					anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
					location: locationOf(context),
					visibility: "visible",
					data: { snapshot: context.state.snapshot }
				};
			}
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of dsh-smarthome: renders a pretty home dashboard card into
		* the conversation when `ha_dashboard` runs. Loaded by the Web Client's
		* module loader from the package's `dsh.client` manifest.
		*/
		/** Required services: the conversation-node registry and the slots service. */
		const inject = ["slots"];
		const COLORS = {
			bg: "#12151a",
			card: "#16191e",
			border: "#262b33",
			text: "#e6e9ee",
			muted: "#8b93a1",
			on: "#6ee7b7",
			off: "#4a5160",
			accent: "#4d7cfe",
			warn: "#fbbf24",
			danger: "#f87171"
		};
		function iconFor(entityId) {
			if (entityId.startsWith("light.")) return "💡";
			if (entityId.startsWith("switch.")) return "🔌";
			if (entityId.startsWith("climate.")) return "❄️";
			if (entityId.startsWith("media_player.")) return "📺";
			if (entityId.startsWith("binary_sensor.")) return entityId.includes("door") ? "🚪" : "📡";
			if (entityId.startsWith("cover.")) return "🪟";
			if (entityId.startsWith("fan.")) return "🌀";
			if (entityId.startsWith("vacuum.")) return "🧹";
			if (entityId.startsWith("lock.")) return "🔒";
			if (entityId.startsWith("camera.")) return "📷";
			if (entityId.startsWith("sensor.")) {
				if (entityId.includes("temp")) return "🌡️";
				if (entityId.includes("humid")) return "💧";
				if (entityId.includes("power") || entityId.includes("energy") || entityId.includes("watt")) return "⚡";
				return "📊";
			}
			return "🏠";
		}
		function stateColor(state) {
			if (state === "on") return COLORS.on;
			if (state === "off") return COLORS.off;
			if (state === "unavailable" || state === "unknown") return COLORS.danger;
			return COLORS.accent;
		}
		function shortTime(iso) {
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return "";
			return d.toLocaleTimeString("zh-CN", { hour12: false });
		}
		const DOMAIN_TITLES = [
			["light.", "💡 灯光"],
			["switch.", "🔌 开关"],
			["sensor.", "📊 传感器"],
			["climate.", "❄️ 空调"],
			["media_player.", "📺 影音"],
			["binary_sensor.", "🚪 门窗"],
			["cover.", "🪟 窗帘"],
			["fan.", "🌀 风扇"],
			["vacuum.", "🧹 清洁"],
			["lock.", "🔒 门锁"]
		];
		function groupEntities(entities) {
			const groups = DOMAIN_TITLES.map(([prefix, title]) => ({
				title,
				items: entities.filter((e) => e.entity_id.startsWith(prefix))
			}));
			const others = entities.filter((e) => !DOMAIN_TITLES.some(([prefix]) => e.entity_id.startsWith(prefix)));
			if (others.length > 0) groups.push({
				title: "🏠 其他",
				items: others
			});
			return groups.filter((g) => g.items.length > 0);
		}
		function EntityRow({ entity }) {
			const value = entity.state === "on" || entity.state === "off" ? entity.state : `${entity.state}${entity.unit ? ` ${entity.unit}` : ""}`;
			return (0, react.createElement)("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 10px",
				borderRadius: 8,
				background: COLORS.card,
				border: `1px solid ${COLORS.border}`
			} }, (0, react.createElement)("span", { style: { fontSize: 15 } }, iconFor(entity.entity_id)), (0, react.createElement)("span", { style: {
				flex: 1,
				color: COLORS.text,
				fontSize: 13,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			} }, entity.friendly_name || entity.entity_id), (0, react.createElement)("span", { style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6
			} }, (0, react.createElement)("span", { style: {
				fontSize: 12,
				color: stateColor(entity.state),
				fontWeight: 600
			} }, value), (0, react.createElement)("span", { style: {
				width: 7,
				height: 7,
				borderRadius: "50%",
				background: stateColor(entity.state)
			} })));
		}
		/** Type guard: the tool-result meta carries a full dashboard snapshot. */
		function isDashboardSnapshot(value) {
			return typeof value === "object" && value !== null && value.kind === "smarthome-dashboard";
		}
		/**
		* Renders the dashboard card inside the `ha_dashboard` tool row.
		*
		* 0.2.1 适配：工具卡片走 keyed 槽 `tool.call.toolview`（key = 工具名），
		* 组件收到的 owner 是 ToolCall 的展开 `{ phase, block?, toolName, callId, cwd, ... }`；
		* 快照由 host 侧 `presentationMeta` 投影到 `block.meta`（不再走 conversationEvents，
		* 那条服务在 0.2.1 已无提供者）。
		*/
		function DashboardView(props) {
			const meta = props.block?.meta;
			if (!isDashboardSnapshot(meta)) return (0, react.createElement)("div", { style: {
				color: COLORS.muted,
				fontSize: 12,
				padding: "4px 2px"
			} }, "🏠 家庭仪表盘加载中…");
			const snapshot = meta;
			const groups = groupEntities(snapshot.entities);
			const onCount = snapshot.entities.filter((e) => e.state === "on").length;
			const recentEvents = snapshot.events.slice(-5).reverse();
			return (0, react.createElement)("div", { style: {
				background: COLORS.bg,
				border: `1px solid ${COLORS.border}`,
				borderRadius: 12,
				padding: "12px 14px",
				maxWidth: 560,
				fontFamily: "system-ui, -apple-system, \"PingFang SC\", sans-serif"
			} }, (0, react.createElement)("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				marginBottom: 10
			} }, (0, react.createElement)("span", { style: { fontSize: 16 } }, "🏠"), (0, react.createElement)("span", { style: {
				color: COLORS.text,
				fontWeight: 700,
				fontSize: 14,
				flex: 1
			} }, "家庭仪表盘"), (0, react.createElement)("span", { style: {
				color: COLORS.muted,
				fontSize: 11
			} }, `${snapshot.entities.length} 个设备 · ${onCount} 在线 · ${shortTime(snapshot.generatedAt)}`)), ...snapshot.scenes.length > 0 ? [(0, react.createElement)("div", {
				key: "scenes",
				style: {
					display: "flex",
					flexWrap: "wrap",
					gap: 6,
					marginBottom: 10
				}
			}, ...snapshot.scenes.map((scene) => (0, react.createElement)("span", {
				key: scene.entity_id,
				style: {
					fontSize: 12,
					color: COLORS.text,
					background: COLORS.card,
					border: `1px solid ${COLORS.border}`,
					borderRadius: 99,
					padding: "3px 10px"
				}
			}, `🎬 ${scene.friendly_name}`)))] : [], ...groups.map((group) => (0, react.createElement)("div", {
				key: group.title,
				style: { marginBottom: 8 }
			}, (0, react.createElement)("div", { style: {
				color: COLORS.muted,
				fontSize: 11,
				marginBottom: 4
			} }, group.title), (0, react.createElement)("div", { style: {
				display: "grid",
				gridTemplateColumns: "1fr 1fr",
				gap: 6
			} }, ...group.items.map((entity) => (0, react.createElement)(EntityRow, {
				key: entity.entity_id,
				entity
			}))))), ...recentEvents.length > 0 ? [(0, react.createElement)("div", {
				key: "events",
				style: {
					marginTop: 8,
					paddingTop: 8,
					borderTop: `1px solid ${COLORS.border}`
				}
			}, (0, react.createElement)("div", { style: {
				color: COLORS.muted,
				fontSize: 11,
				marginBottom: 4
			} }, "🕐 最近变化"), ...recentEvents.map((event, i) => (0, react.createElement)("div", {
				key: i,
				style: {
					color: COLORS.muted,
					fontSize: 12,
					display: "flex",
					gap: 6
				}
			}, (0, react.createElement)("span", {}, iconFor(event.entity_id)), (0, react.createElement)("span", { style: { flex: 1 } }, `${event.entity_id}: ${event.old_state ?? "—"} → `, (0, react.createElement)("span", { style: { color: stateColor(event.state) } }, event.state)), (0, react.createElement)("span", {}, shortTime(event.last_changed)))))] : []);
		}
		function apply(ctx) {
			// 0.2.1 适配：工具卡片走 keyed 槽 `tool.call.toolview`，key = 工具名；
			// 数据来自 host 侧 `presentationMeta` 投影到 block.meta。
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "ha_dashboard"
			}, DashboardView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

