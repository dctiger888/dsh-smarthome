import { credentialRef } from "@deepseek-ai/dsh-credentials";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/config.ts
const Config = Schema.object({
	baseUrl: Schema.string().description("Home Assistant base URL, e.g. http://homeassistant.local:8123").default("http://homeassistant.local:8123"),
	token: Schema.string().description("Long-lived access token (HA → Profile → Security → Long-lived access tokens)").default(""),
	tokenEnv: Schema.string().description("Environment variable holding the token (used when `token` is empty)").default("HOME_ASSISTANT_TOKEN"),
	timeoutMs: Schema.number().description("Request timeout in milliseconds").default(15e3),
	requireApproval: Schema.boolean().description("Require human approval before state-changing calls").default(true),
	allowedDomains: Schema.array(Schema.string()).description("Allowed service domains (light, switch, …); empty allows every domain").default([]),
	maxHistoryEvents: Schema.number().description("Maximum history events returned by ha_history").default(200),
	wsEnabled: Schema.boolean().description("Enable the WebSocket API (real-time state changes, area registry)").default(true),
	eventBufferSize: Schema.number().description("Rolling size of the state-change event buffer").default(50)
});
//#endregion
//#region src/ha.ts
var HomeAssistantError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.name = "HomeAssistantError";
		this.status = status;
	}
};
var HomeAssistantClient = class {
	baseUrl;
	token;
	timeoutMs;
	resolveToken;
	constructor(baseUrl, token, timeoutMs = 15e3, resolveToken) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = token;
		this.timeoutMs = timeoutMs;
		this.resolveToken = resolveToken;
	}
	/** True when a token source is available; all requests fail loudly when false. */
	get configured() {
		return this.token.length > 0 || this.resolveToken !== void 0;
	}
	/** Resolve the current token (re-resolved per request when a resolver is set). */
	async tokenFor() {
		if (this.resolveToken) return await this.resolveToken() ?? "";
		return this.token;
	}
	async request(path, init = {}) {
		const token = await this.tokenFor();
		if (!token) throw new HomeAssistantError("dsh-smarthome is not configured: no Home Assistant token. Set `token` or `tokenEnv` in the smarthome plugin config, then restart dsh.");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...init.headers
				},
				signal: controller.signal
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				const detail = body ? `: ${body.slice(0, 300)}` : "";
				throw new HomeAssistantError(`Home Assistant ${res.status} ${res.statusText}${detail}`, res.status);
			}
			const body = await res.text();
			if (body.length === 0) return null;
			try {
				return JSON.parse(body);
			} catch {
				return body;
			}
		} catch (err) {
			if (err instanceof HomeAssistantError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw new HomeAssistantError(`Home Assistant request timed out after ${this.timeoutMs}ms: ${path}`);
			throw new HomeAssistantError(`Home Assistant request failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			clearTimeout(timer);
		}
	}
	/** `GET /api/` — returns "API running." when reachable. */
	health() {
		return this.request("/api/");
	}
	/** `GET /api/config` — instance name, version, timezone, unit system. */
	getConfig() {
		return this.request("/api/config");
	}
	/** `GET /api/states` — every entity state. */
	getStates() {
		return this.request("/api/states");
	}
	/** `GET /api/states/<entity_id>` — one entity state. */
	getState(entityId) {
		return this.request(`/api/states/${encodeURIComponent(entityId)}`);
	}
	/**
	* `POST /api/services/<domain>/<service>`.
	* `target` (entity_id / area_id / device_id) and `data` merge into one body.
	*/
	callService(domain, service, target, data) {
		return this.request(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
			method: "POST",
			body: JSON.stringify({
				...target,
				...data
			})
		});
	}
	/** `GET /api/history/period/<start>` — one array of state timelines per entity. */
	async getHistory(options = {}) {
		const start = options.start ?? (/* @__PURE__ */ new Date(Date.now() - 36e5)).toISOString();
		const query = new URLSearchParams();
		if (options.end) query.set("end", options.end);
		if (options.entityId) query.set("filter_entity_id", options.entityId);
		query.set("minimal_response", "");
		const qs = query.toString();
		const path = `/api/history/period/${encodeURIComponent(start)}${qs ? `?${qs}` : ""}`;
		return this.request(path);
	}
	/** `POST /api/template` — render a Jinja2 template server-side. */
	renderTemplate(template) {
		return this.request("/api/template", {
			method: "POST",
			body: JSON.stringify({ template })
		});
	}
};
/**
* Minimal Home Assistant WebSocket client: authenticates, subscribes to
* `state_changed`, keeps a rolling event buffer, answers pings, and reconnects
* with backoff. All WS features degrade gracefully when the socket is
* unavailable (no WebSocket global) or disconnected (real HA not reachable).
*
* `start()` opens the socket; `dispose()` closes it and stops reconnecting.
*/
var HomeAssistantWsClient = class {
	baseUrl;
	token;
	options;
	resolveToken;
	socket = null;
	pending = /* @__PURE__ */ new Map();
	nextId = 1;
	disposed = false;
	reconnectDelay = 1e3;
	reconnectTimer = null;
	status = "disconnected";
	events = [];
	constructor(baseUrl, token, options, resolveToken) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = token;
		this.options = options;
		this.resolveToken = resolveToken;
	}
	/** Resolve the current token (re-resolved per connection when a resolver is set). */
	async tokenFor() {
		if (this.resolveToken) return await this.resolveToken() ?? "";
		return this.token;
	}
	/** Open the socket (no-op when disabled or unavailable). */
	async start() {
		if (this.disposed) return;
		if (!this.options.enabled) {
			this.status = "disconnected";
			return;
		}
		if (typeof WebSocket === "undefined") {
			this.status = "unavailable";
			return;
		}
		if (this.socket && this.socket.readyState < 2) return;
		const token = await this.tokenFor();
		const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/api/websocket`;
		const socket = new WebSocket(wsUrl);
		this.socket = socket;
		this.status = "connecting";
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({
				type: "auth",
				access_token: token
			}));
		});
		socket.addEventListener("message", (event) => {
			this.onMessage(event.data, token);
		});
		socket.addEventListener("close", () => {
			if (this.socket === socket) this.socket = null;
			if (this.status !== "unavailable") this.status = "disconnected";
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new HomeAssistantError("Home Assistant WebSocket connection closed"));
			}
			this.pending.clear();
			this.scheduleReconnect();
		});
		socket.addEventListener("error", () => {});
	}
	onMessage(raw, token) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg.type === "auth_required") {
			this.socket?.send(JSON.stringify({
				type: "auth",
				access_token: token
			}));
			return;
		}
		if (msg.type === "auth_ok") {
			this.status = "connected";
			this.reconnectDelay = 1e3;
			this.socket?.send(JSON.stringify({
				id: this.nextId++,
				type: "subscribe_events",
				event_type: "state_changed"
			}));
			return;
		}
		if (msg.type === "auth_invalid" || msg.type === "auth_failed") {
			this.status = "disconnected";
			return;
		}
		if (msg.type === "pong") return;
		if (msg.type === "ping") {
			this.socket?.send(JSON.stringify({ type: "pong" }));
			return;
		}
		if (msg.type === "event" && msg.event?.event_type === "state_changed") {
			const data = msg.event.data ?? {};
			const entityId = typeof data.entity_id === "string" ? data.entity_id : "";
			const newState = data.new_state;
			const oldState = data.old_state;
			if (entityId && newState?.state != null) {
				const change = {
					entity_id: entityId,
					state: newState.state,
					old_state: oldState?.state ?? null,
					last_changed: newState.last_changed ?? (/* @__PURE__ */ new Date()).toISOString()
				};
				this.events.push(change);
				if (this.events.length > this.options.bufferSize) this.events.shift();
				this.options.onEvent?.(change);
			}
			return;
		}
		if (typeof msg.id === "number") {
			const pending = this.pending.get(msg.id);
			if (pending) {
				this.pending.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.success) pending.resolve(msg.result);
				else pending.reject(new HomeAssistantError(`Home Assistant WebSocket error: ${JSON.stringify(msg.result)}`));
			}
		}
	}
	scheduleReconnect() {
		if (this.disposed || this.reconnectTimer || !this.options.enabled) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.disposed) return;
			this.start();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 3e4);
	}
	/** Query the area registry over the socket (HA WebSocket API). */
	listAreas() {
		return this.request("config/area_registry/list");
	}
	/** Query the device registry over the socket (HA WebSocket API). */
	async listDevices() {
		return (await this.request("config/device_registry/list")).map((d) => ({
			id: d.id,
			name: d.name_by_user ?? d.name ?? d.id,
			...d.area_id ? { area_id: d.area_id } : {}
		}));
	}
	request(type, timeoutMs = 8e3) {
		if (this.status === "unavailable") return Promise.reject(new HomeAssistantError("dsh-smarthome: WebSocket is unavailable in this Node runtime (needs the built-in WebSocket, Node ≥ 22)."));
		if (this.status !== "connected" || !this.socket || this.socket.readyState !== 1) return Promise.reject(new HomeAssistantError("dsh-smarthome: WebSocket is not connected to Home Assistant (is it running? check ha_health)."));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new HomeAssistantError(`Home Assistant WebSocket request "${type}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve,
				reject,
				timer
			});
			this.socket?.send(JSON.stringify({
				id,
				type
			}));
		});
	}
	/** Close the socket and stop reconnecting. */
	dispose() {
		this.disposed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new HomeAssistantError("dsh-smarthome: WebSocket disposed"));
		}
		this.pending.clear();
		if (this.socket) this.socket.close();
		this.socket = null;
	}
};
//#endregion
//#region src/dashboard.ts
/**
* Shared dashboard snapshot contract between the host tool (`ha_dashboard`)
* and the browser client node. Type-only — the client bundle imports it for
* types only; the marker literal is duplicated deliberately so neither side
* needs a runtime import of the other.
*/
/** Marker carried on `tool/result` meta to identify a dashboard snapshot. */
const DASHBOARD_META_KIND = "smarthome-dashboard";
//#endregion
//#region src/tools.ts
/** Text content block helper for `output.render` / card content. */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Cap rendered text at a sane size so huge attribute maps cannot flood context. */
function truncate(value, max = 4e3) {
	return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}
/**
* Register the `ha_*` tools. Reads are cheap and safe; the powerful tools
* (`ha_call_service`, `ha_render_template`) are gated by the plugin's
* `tools/pre-execute` policy in index.ts. WebSocket-backed tools
* (`ha_list_areas`, `ha_events`) degrade gracefully when the socket is down.
*/
function registerTools(ctx, client, ws, config) {
	ctx.tools.register(defineTool({
		name: "ha_health",
		description: "Check the connection to Home Assistant and return instance info (location name, version, timezone, unit system) plus WebSocket status. Call this first to verify the plugin is configured.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					reachable: { type: "boolean" },
					location: { type: "string" },
					version: { type: "string" },
					timezone: { type: "string" },
					websocket: { type: "string" }
				}
			},
			render: (_args, value) => {
				const v = value;
				return text(v.reachable ? `Home Assistant reachable: "${v.location}" (version ${v.version ?? "unknown"}, timezone ${v.timezone ?? "unknown"}, websocket ${v.websocket ?? "n/a"})` : "Home Assistant unreachable");
			}
		},
		async execute() {
			const message = await client.health();
			const messageText = typeof message === "string"
				? message
				: (message && typeof message.message === "string" ? message.message : JSON.stringify(message));
			if (!messageText.includes("API running")) throw new Error(`Unexpected Home Assistant response: ${JSON.stringify(message)}`);
			const configInfo = await client.getConfig();
			return {
				reachable: true,
				location: configInfo.location_name ?? "",
				version: configInfo.version ?? "",
				timezone: configInfo.time_zone ?? "",
				websocket: ws.status
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_list_entities",
		description: "List Home Assistant entities, optionally filtered by domain (light, switch, sensor, …) and/or a text query on entity id or friendly name. Returns compact summaries to keep context small.",
		parameters: {
			domain: {
				type: "string",
				description: "Entity domain filter, e.g. \"light\" or \"sensor\""
			},
			query: {
				type: "string",
				description: "Text search over entity id and friendly name"
			},
			limit: {
				type: "number",
				description: "Maximum entities to return"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					count: { type: "number" },
					entities: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								entity_id: { type: "string" },
								state: { type: "string" },
								friendly_name: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return text(truncate(value.entities.map((e) => `- ${e.entity_id}: ${e.state}${e.friendly_name ? ` (${e.friendly_name})` : ""}`).join("\n") || "(no entities)"));
			}
		},
		async execute(args) {
			const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
			const states = await client.getStates();
			const query = (args.query ?? "").toLowerCase();
			const filtered = states.filter((s) => !args.domain || s.entity_id.startsWith(`${args.domain}.`)).filter((s) => !query || s.entity_id.toLowerCase().includes(query) || String(s.attributes.friendly_name ?? "").toLowerCase().includes(query)).sort((a, b) => a.entity_id.localeCompare(b.entity_id)).slice(0, limit);
			return {
				count: filtered.length,
				entities: filtered.map((s) => ({
					entity_id: s.entity_id,
					state: s.state,
					friendly_name: typeof s.attributes.friendly_name === "string" ? s.attributes.friendly_name : ""
				}))
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_get_state",
		description: "Get the full state of one Home Assistant entity, including its attributes (brightness, temperature, battery level, …).",
		parameters: { entityId: {
			type: "string",
			required: true,
			description: "Entity id, e.g. \"light.living_room\""
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const s = value;
				return text(truncate(`${s.entity_id}: ${s.state}\n${JSON.stringify(s.attributes ?? {}, null, 2)}`));
			}
		},
		async execute(args) {
			const s = await client.getState(args.entityId);
			return {
				entity_id: s.entity_id,
				state: s.state,
				attributes: s.attributes,
				last_changed: s.last_changed,
				last_updated: s.last_updated
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_history",
		description: "Query Home Assistant state history for one entity (or all entities) over a time window. Returns a compact timeline of state changes. Defaults to the last hour.",
		parameters: {
			entityId: {
				type: "string",
				description: "Entity id filter; omit for all entities"
			},
			start: {
				type: "string",
				description: "ISO 8601 start time; defaults to one hour ago"
			},
			end: {
				type: "string",
				description: "ISO 8601 end time"
			},
			maxEvents: {
				type: "number",
				description: "Maximum timeline entries to return"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					count: { type: "number" },
					events: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								entity_id: { type: "string" },
								state: { type: "string" },
								last_changed: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return text(truncate(value.events.map((e) => `- ${e.last_changed}  ${e.entity_id}: ${e.state}`).join("\n") || "(no history)"));
			}
		},
		async execute(args) {
			const periods = await client.getHistory({
				start: args.start,
				end: args.end,
				entityId: args.entityId
			});
			const maxEvents = Math.min(Math.max(args.maxEvents ?? config.maxHistoryEvents, 1), 1e3);
			const events = periods.flat().map((s) => ({
				entity_id: s.entity_id,
				state: s.state,
				last_changed: s.last_changed
			})).slice(0, maxEvents);
			return {
				count: events.length,
				events
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_call_service",
		description: "Call a Home Assistant service, e.g. light.turn_on, switch.turn_off, climate.set_temperature. Target by entity id(s), by area (areaId — affects everything in that room), or by device (deviceId). Requires human approval (configurable). Use ha_list_entities / ha_list_areas first.",
		parameters: {
			domain: {
				type: "string",
				required: true,
				description: "Service domain, e.g. \"light\""
			},
			service: {
				type: "string",
				required: true,
				description: "Service name, e.g. \"turn_on\""
			},
			entityId: {
				type: "string",
				description: "Target a single entity, e.g. \"light.living_room\""
			},
			entityIds: {
				type: "array",
				items: { type: "string" },
				description: "Target multiple entities (takes precedence over entityId)"
			},
			areaId: {
				type: "string",
				description: "Target every device in an area, e.g. \"living_room\" (see ha_list_areas)"
			},
			deviceId: {
				type: "string",
				description: "Target a device, e.g. \"a1b2c3…\""
			},
			data: {
				type: "object",
				additionalProperties: true,
				description: "Service data, e.g. {\"brightness\": 128} or {\"temperature\": 21}"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean" },
					domain: { type: "string" },
					service: { type: "string" },
					target: { type: "string" },
					data: { type: "json" }
				}
			},
			render: (_args, value) => {
				const target = value.target || "(whole domain)";
				return text(`Called ${value.domain}.${value.service} on ${target}${value.data ? ` with ${JSON.stringify(value.data)}` : ""}.`);
			}
		},
		presentCall(args) {
			const a = args;
			if (!a.domain || !a.service) return void 0;
			return {
				card: "generic",
				title: `${a.domain}.${a.service}`,
				kind: "execute"
			};
		},
		presentResult(_args, result) {
			return {
				card: "generic",
				content: result.isError ? result.content : [{
					type: "text",
					text: "✅ Service call completed"
				}]
			};
		},
		async execute(args) {
			const entityIds = args.entityIds?.length ? args.entityIds : args.entityId ? [args.entityId] : [];
			const target = entityIds.length ? { entity_id: entityIds } : args.areaId ? { area_id: args.areaId } : args.deviceId ? { device_id: args.deviceId } : void 0;
			const TARGET_KEYS = /* @__PURE__ */ new Set([
				"entity_id",
				"entity_ids",
				"area_id",
				"device_id"
			]);
			const rawData = args.data ?? void 0;
			const data = rawData ? Object.fromEntries(Object.entries(rawData).filter(([key]) => !TARGET_KEYS.has(key))) : void 0;
			const label = entityIds.length ? entityIds.join(", ") : args.areaId ? `area:${args.areaId}` : args.deviceId ? `device:${args.deviceId}` : "";
			await client.callService(args.domain, args.service, target, data);
			return {
				ok: true,
				domain: args.domain,
				service: args.service,
				target: label,
				data: data && Object.keys(data).length > 0 ? data : null
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_list_areas",
		description: "List Home Assistant areas (rooms) via the WebSocket API. Use the returned area_id with ha_call_service to control everything in a room at once.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					count: { type: "number" },
					areas: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								area_id: { type: "string" },
								name: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const areas = value.areas;
				return text(areas.length ? areas.map((a) => `- ${a.area_id}: ${a.name}`).join("\n") : "(no areas)");
			}
		},
		async execute() {
			const areas = await ws.listAreas();
			return {
				count: areas.length,
				areas: areas.map((a) => ({
					area_id: a.area_id,
					name: a.name
				}))
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_list_devices",
		description: "List Home Assistant devices via the WebSocket device registry, optionally filtered by text or by area. Use the returned device id with ha_call_service (deviceId) to control a physical device directly.",
		parameters: {
			query: {
				type: "string",
				description: "Text search over device name or id"
			},
			areaId: {
				type: "string",
				description: "Only devices in this area (see ha_list_areas)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					count: { type: "number" },
					devices: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								id: { type: "string" },
								name: { type: "string" },
								area_id: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const devices = value.devices;
				return text(devices.length ? devices.map((d) => `- ${d.id}: ${d.name}${d.area_id ? ` (area: ${d.area_id})` : ""}`).join("\n") : "(no devices)");
			}
		},
		async execute(args) {
			const query = (args.query ?? "").toLowerCase();
			const devices = (await ws.listDevices()).filter((d) => !args.areaId || d.area_id === args.areaId).filter((d) => !query || d.id.toLowerCase().includes(query) || d.name.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({
				id: d.id,
				name: d.name,
				...d.area_id ? { area_id: d.area_id } : {}
			}));
			return {
				count: devices.length,
				devices
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_events",
		description: "Return recent real-time state changes buffered from the Home Assistant WebSocket (entity, state, previous state, timestamp). Empty when WebSocket is not connected.",
		parameters: { limit: {
			type: "number",
			description: "Maximum events to return"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					count: { type: "number" },
					websocket: { type: "string" },
					events: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								entity_id: { type: "string" },
								state: { type: "string" },
								old_state: { oneOf: [{ type: "string" }, { type: "null" }] },
								last_changed: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return text(truncate(value.events.map((e) => `- ${e.last_changed}  ${e.entity_id}: ${e.old_state ?? "—"} → ${e.state}`).join("\n") || "(no recent events)"));
			}
		},
		async execute(args) {
			const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
			const events = ws.events.slice(-limit).map((e) => ({
				entity_id: e.entity_id,
				state: e.state,
				old_state: e.old_state,
				last_changed: e.last_changed
			}));
			return {
				count: events.length,
				websocket: ws.status,
				events
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_render_template",
		description: "Render a Home Assistant Jinja2 template server-side and return the result. Powerful: can evaluate sensor states, calculations, and comparisons. Requires approval (configurable).",
		parameters: { template: {
			type: "string",
			required: true,
			description: "Jinja2 template, e.g. \"{{ states('sensor.temperature') }}\""
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					template: { type: "string" },
					rendered: { type: "string" }
				}
			},
			render: (_args, value) => text(truncate(`Rendered: ${value.rendered}`))
		},
		async execute(args) {
			const rendered = await client.renderTemplate(args.template);
			return {
				template: args.template,
				rendered
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_list_scenes",
		description: "List Home Assistant scenes (one-click moods like \"cinema\", \"goodnight\", \"away\"). Activate one with ha_call_service: domain \"scene\", service \"turn_on\", entityId the scene entity id.",
		parameters: { query: {
			type: "string",
			description: "Optional text search over scene id or friendly name"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					count: { type: "number" },
					scenes: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								entity_id: { type: "string" },
								state: { type: "string" },
								friendly_name: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const scenes = value.scenes;
				return text(scenes.length ? scenes.map((s) => `- ${s.entity_id}: ${s.friendly_name || s.entity_id}`).join("\n") : "(no scenes)");
			}
		},
		async execute(args) {
			const states = await client.getStates();
			const query = (args.query ?? "").toLowerCase();
			const scenes = states.filter((s) => s.entity_id.startsWith("scene.")).filter((s) => !query || s.entity_id.toLowerCase().includes(query) || String(s.attributes.friendly_name ?? "").toLowerCase().includes(query)).sort((a, b) => a.entity_id.localeCompare(b.entity_id)).map((s) => ({
				entity_id: s.entity_id,
				state: s.state,
				friendly_name: typeof s.attributes.friendly_name === "string" ? s.attributes.friendly_name : ""
			}));
			return {
				count: scenes.length,
				scenes
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_dashboard",
		description: "Build a full home dashboard snapshot: every entity (grouped by domain, with friendly names, states and units), all scenes, and recent state changes. The result renders as a home dashboard card in the Web UI.",
		parameters: {},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const s = value;
				const on = s.entities.filter((e) => e.state === "on").length;
				return text(`Dashboard snapshot: ${s.entities.length} entities (${on} on), ${s.scenes.length} scenes, ${s.events.length} recent changes.`);
			},
			presentationMeta: (_args, value) => value
		},
		presentResult(_args, result) {
			return {
				card: "generic",
				content: result.isError ? result.content : [{
					type: "text",
					text: "🏠 Home dashboard ready"
				}]
			};
		},
		async execute() {
			const states = await client.getStates();
			const scenes = states.filter((s) => s.entity_id.startsWith("scene.")).map((s) => ({
				entity_id: s.entity_id,
				friendly_name: typeof s.attributes.friendly_name === "string" ? s.attributes.friendly_name : s.entity_id
			})).sort((a, b) => a.entity_id.localeCompare(b.entity_id));
			const entities = states.filter((s) => !s.entity_id.startsWith("scene.")).sort((a, b) => a.entity_id.localeCompare(b.entity_id)).map((s) => ({
				entity_id: s.entity_id,
				state: s.state,
				friendly_name: typeof s.attributes.friendly_name === "string" ? s.attributes.friendly_name : s.entity_id,
				...typeof s.attributes.unit_of_measurement === "string" ? { unit: s.attributes.unit_of_measurement } : {}
			}));
			const events = ws.events.slice(-8).map((e) => ({
				entity_id: e.entity_id,
				state: e.state,
				old_state: e.old_state,
				last_changed: e.last_changed
			}));
			return {
				kind: DASHBOARD_META_KIND,
				generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				entities,
				scenes,
				events
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_wait_for_state",
		description: "Poll one entity until its state matches (or stops matching) a target, up to a timeout. Real monitoring tasks: wait for the washer to finish, wait until the living room reaches a temperature, watch whether a door stays closed. The call blocks the turn until the condition is met, the timeout elapses, or the caller cancels. Returns matched=false on timeout (with the last observed state) — not an error.",
		parameters: {
			entityId: {
				type: "string",
				required: true,
				description: "Entity to watch, e.g. \"binary_sensor.washer\" or \"sensor.temperature\""
			},
			targetState: {
				type: "string",
				description: "Wait until state EQUALS this (omit to use notTargetState)"
			},
			notTargetState: {
				type: "string",
				description: "Wait until state no longer equals this"
			},
			timeoutMs: {
				type: "number",
				description: "Max wait in ms (default 120000, max 600000)"
			},
			checkIntervalMs: {
				type: "number",
				description: "Poll interval in ms (default 1000, min 200)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					matched: { type: "boolean" },
					entity_id: { type: "string" },
					state: { type: "string" },
					waitedMs: { type: "number" }
				}
			},
			render: (_args, value) => text(value.matched ? `${value.entity_id} reached "${value.state}" after ${value.waitedMs}ms` : `${value.entity_id} did not match within ${value.waitedMs}ms (last state: ${value.state})`)
		},
		async execute(args, exec) {
			const entityId = args.entityId;
			const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 12e4, 500), 6e5);
			const intervalMs = Math.min(Math.max(args.checkIntervalMs ?? 1e3, 200), 3e4);
			const start = Date.now();
			let last = "";
			while (Date.now() - start < timeoutMs) {
				if (exec.signal.aborted) throw new Error("cancelled");
				const state = await client.getState(entityId);
				last = state.state;
				if (args.targetState !== void 0 ? state.state === args.targetState : args.notTargetState !== void 0 ? state.state !== args.notTargetState : true) return {
					matched: true,
					entity_id: entityId,
					state: state.state,
					waitedMs: Date.now() - start
				};
				await sleep(intervalMs, exec.signal);
			}
			return {
				matched: false,
				entity_id: entityId,
				state: last,
				waitedMs: Date.now() - start
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_notify",
		description: "Send a notification through Home Assistant: a persistent notification in the HA UI (default), or any notify service such as a mobile app or speaker. Real business: \"tell me on my phone when the task is done\" or \"announce on the living room speaker\". Low-risk and not approval-gated.",
		parameters: {
			message: {
				type: "string",
				required: true,
				description: "Notification text"
			},
			title: {
				type: "string",
				description: "Optional title (persistent_notification only)"
			},
			notifyService: {
				type: "string",
				description: "Notify service id, e.g. \"mobile_app_my_phone\" or \"persistent_notification\" (default)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean" },
					service: { type: "string" },
					message: { type: "string" }
				}
			},
			render: (_args, value) => text(`Notification sent via ${value.service}.`)
		},
		async execute(args) {
			const service = args.notifyService ?? "persistent_notification";
			if (service === "persistent_notification") await client.callService("persistent_notification", "create", void 0, {
				message: args.message,
				...args.title ? { title: args.title } : {}
			});
			else await client.callService("notify", service, void 0, {
				message: args.message,
				...args.title ? { title: args.title } : {}
			});
			return {
				ok: true,
				service,
				message: args.message
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "ha_weather",
		description: "Current weather and a structured forecast from the Home Assistant weather entity. Saves the model from parsing raw weather attributes. Example: \"what is the weather like tomorrow and should I take an umbrella?\".",
		parameters: {
			entityId: {
				type: "string",
				description: "Weather entity id; defaults to the first weather.* entity"
			},
			forecastDays: {
				type: "number",
				description: "Forecast entries to return (default 3, max 7)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					entity_id: { type: "string" },
					condition: { type: "string" },
					temperature: { type: "json" },
					humidity: { type: "json" },
					forecast: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								datetime: { type: "string" },
								condition: { type: "string" },
								temperature: { type: "json" },
								precipitation_probability: { type: "json" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				const lines = (v.forecast ?? []).map((f) => `- ${f.datetime}: ${f.condition ?? "?"} ${f.temperature != null ? `${f.temperature}°` : ""}`);
				return text(truncate(`Weather: ${v.condition ?? "unknown"}${v.temperature != null ? `, ${v.temperature}°` : ""}\n${lines.join("\n")}`));
			}
		},
		async execute(args) {
			const states = await client.getStates();
			const weather = args.entityId ? await client.getState(args.entityId) : states.find((s) => s.entity_id.startsWith("weather.")) ?? (() => {
				throw new Error("dsh-smarthome: no weather entity found in Home Assistant");
			})();
			const attrs = weather.attributes;
			const rawForecast = Array.isArray(attrs.forecast) ? attrs.forecast : [];
			const days = Math.min(Math.max(args.forecastDays ?? 3, 1), 7);
			return {
				entity_id: weather.entity_id,
				condition: typeof attrs.condition === "string" ? attrs.condition : weather.state,
				...attrs.temperature != null ? { temperature: attrs.temperature } : {},
				...attrs.humidity != null ? { humidity: attrs.humidity } : {},
				forecast: rawForecast.slice(0, days).map((f) => ({
					datetime: String(f.datetime ?? ""),
					...f.condition != null ? { condition: String(f.condition) } : {},
					...f.temperature != null ? { temperature: f.temperature } : {},
					...f.precipitation_probability != null ? { precipitation_probability: f.precipitation_probability } : {}
				}))
			};
		}
	}));
}
/** Resolve after `ms`, abortable via the execution signal. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("cancelled"));
		}, { once: true });
	});
}
//#endregion
//#region src/index.ts
const name = "dsh-smarthome";
const inject = ["tools"];
/** Tools that change (or can be abused to change) Home Assistant state. */
const SENSITIVE_TOOLS = /* @__PURE__ */ new Set(["ha_call_service", "ha_render_template"]);
function apply(ctx, config) {
	const credentials = ctx.get("credentials");
	const resolveToken = async () => {
		if (config.token) return config.token;
		const ref = credentialRef(config.tokenEnv);
		if (credentials) {
			const hit = await credentials.resolve(ref);
			if (hit) return hit.value;
		}
		return process.env[config.tokenEnv] ?? "";
	};
	const client = new HomeAssistantClient(config.baseUrl, "", config.timeoutMs, resolveToken);
	const ws = new HomeAssistantWsClient(config.baseUrl, "", {
		enabled: config.wsEnabled,
		bufferSize: config.eventBufferSize
	}, resolveToken);
	ctx.effect(() => {
		ws.start();
		return () => ws.dispose();
	}, `${name}.ws`);
	registerTools(ctx, client, ws, config);
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (!exec.name.startsWith("ha_")) return next();
		if (exec.name === "ha_call_service" && config.allowedDomains.length > 0) {
			const args = exec.arguments;
			const domain = typeof args?.domain === "string" ? args.domain : void 0;
			if (domain && !config.allowedDomains.includes(domain)) return {
				kind: "deny",
				reason: `dsh-smarthome: service domain "${domain}" is not in allowedDomains (${config.allowedDomains.join(", ")}).`
			};
		}
		if (config.requireApproval && SENSITIVE_TOOLS.has(exec.name)) return {
			kind: "ask",
			reason: `dsh-smarthome: "${exec.name}" changes Home Assistant state — approve to continue.`
		};
		return next();
	});
}
//#endregion
export { Config, apply, inject, name };
