const API_ORIGIN = "https://api.cut.pro";
const API_PATH = "/api/v1";
const PRICES_PATH = "/public/generations/models";
const MAX_SERVER_WAIT_SECONDS = 60;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 1000;
// Longer than the 60 seconds a create or a get may be held by the server.
const DEFAULT_REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
// The proxy only forwards JSON requests; uploads go from your server with the SDK.
const MAX_PROXY_BODY_BYTES = 1024 * 1024;
// What `proxy()` forwards: everything a browser app needs to price, start and follow a generation, nothing that reads the account.
const PROXIED: readonly [string, RegExp][] = [
	["GET", /^\/models(\/featured)?$/],
	["GET", /^\/prices$/],
	["POST", /^\/generations(\/quote)?$/],
	["GET", /^\/generations\/[\w-]+$/],
];

// The part of `fetch` the client calls, so a runtime's own extras (Bun's `preconnect`) are not required of a custom one.
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CutProOptions {
	/** Server side only. Defaults to the `CUTPRO_API_KEY` environment variable. Get one at https://cut.pro/studio/me/api-keys */
	apiKey?: string;
	/** Defaults to https://api.cut.pro/api/v1. In a browser, point it at your own `proxy()` route, such as `/api/cutpro`. */
	baseURL?: string;
	/** Only for a key that reaches more than one workspace. */
	workspaceId?: string;
	/** Per request, retries included. Defaults to 90 seconds. */
	timeoutMs?: number;
	fetch?: Fetch;
	headers?: Record<string, string>;
	/** Sends the key from a browser, where anyone can read it. Only for a key you are willing to lose. */
	dangerouslyAllowBrowser?: boolean;
}

export interface RequestOptions {
	signal?: AbortSignal;
	headers?: Record<string, string>;
}

export interface CreateOptions extends RequestOptions {
	/** Any unique string: the same key within 24 hours answers the first result and never charges twice. Generated when left out. */
	idempotencyKey?: string;
	/** Seconds the server holds the answer while the generation runs, up to 60. */
	wait?: number;
}

export interface WaitOptions extends RequestOptions {
	/** Pause between polls. Each poll is already held by the server for up to 60 seconds. */
	intervalMs?: number;
	timeoutMs?: number;
}

export type GenerateOptions = Omit<CreateOptions, "wait"> & WaitOptions;

export interface ProxyOptions {
	/** Defaults to the `CUTPRO_API_KEY` environment variable. */
	apiKey?: string;
	/** The path your route is mounted at, stripped before matching, such as `/api/cutpro`. */
	prefix?: string;
	/** Runs before anything is forwarded: return false to answer 401. This is where you check your own session, since every forwarded call spends your credits. */
	authorize?: (request: Request) => boolean | Promise<boolean>;
	fetch?: Fetch;
}

export class CutProError extends Error {
	readonly code: string;
	/** HTTP status, or 0 when the client raised it (`WAIT_TIMEOUT`, `API_KEY_IN_BROWSER`, `PROXY_REQUIRED_IN_BROWSER`, `INSECURE_BASE_URL`, or a generation that ended `failed`). */
	readonly status: number;
	readonly extra: Record<string, unknown> | undefined;

	constructor(code: string, status: number, extra?: Record<string, unknown>) {
		super(status ? `${status} ${code}` : code);
		this.name = "CutProError";
		this.code = code;
		this.status = status;
		this.extra = extra;
	}
}

interface Call extends RequestOptions {
	query?: Record<string, string | number | undefined>;
	body?: object | FormData;
	auth?: boolean;
	retry?: boolean;
}

const inBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";
const envApiKey = () => (typeof process !== "undefined" ? process.env?.CUTPRO_API_KEY : undefined);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

// A relative base resolves against the page in a browser; anything else must be https, except a local server.
function resolveBase(baseURL: string): string {
	const base = new URL(baseURL, inBrowser() ? window.location.origin : undefined);
	const local = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
	if (base.protocol !== "https:" && !(local && base.protocol === "http:")) throw new CutProError("INSECURE_BASE_URL", 0, { base_url: baseURL });
	return base.href.replace(/\/+$/, "");
}

function retryAfterMs(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : RETRY_BASE_MS * 2 ** attempt;
}

export class CutPro {
	readonly models: Models;
	readonly generations: Generations;
	readonly media: MediaLibrary;
	readonly #apiKey: string | undefined;
	readonly #baseURL: string;
	readonly #direct: boolean;
	readonly #workspaceId: string | undefined;
	readonly #timeoutMs: number;
	readonly #fetch: Fetch;
	readonly #headers: Record<string, string>;

	constructor(options: CutProOptions = {}) {
		const browser = inBrowser();
		this.#apiKey = options.apiKey ?? (browser ? undefined : envApiKey());
		if (browser && !options.dangerouslyAllowBrowser) {
			if (this.#apiKey) throw new CutProError("API_KEY_IN_BROWSER", 0);
			// The API answers no other site's browser, so a page talks to its own server's `proxy()`.
			if (options.baseURL === undefined) throw new CutProError("PROXY_REQUIRED_IN_BROWSER", 0);
		}
		this.#baseURL = resolveBase(options.baseURL ?? `${API_ORIGIN}${API_PATH}`);
		this.#direct = options.baseURL === undefined;
		this.#workspaceId = options.workspaceId;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#headers = options.headers ?? {};
		this.models = new Models(this);
		this.generations = new Generations(this);
		this.media = new MediaLibrary(this);
	}

	/** @internal */
	async request<T>(method: string, path: string, call: Call = {}): Promise<T> {
		// The public price list lives outside /api/v1; a proxy serves it at /prices.
		const target = path === "/prices" && this.#direct ? `${API_ORIGIN}${PRICES_PATH}` : `${this.#baseURL}${path}`;
		const url = new URL(target);
		for (const [key, value] of Object.entries(call.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));

		const headers: Record<string, string> = { Accept: "application/json", ...this.#headers, ...call.headers };
		if (call.auth !== false && this.#apiKey) headers["X-Api-Key"] = this.#apiKey;
		if (call.auth !== false && this.#workspaceId) headers["X-Workspace-Id"] = this.#workspaceId;
		let body: string | FormData | undefined;
		if (call.body instanceof FormData) body = call.body;
		else if (call.body) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(call.body);
		}

		const signal = call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs);
		for (let attempt = 0; ; attempt++) {
			const response = await this.#fetch(url, { method, headers, body, signal, redirect: "error" });
			if (response.ok) return response.json();
			if (call.retry !== false && attempt < MAX_RETRIES && RETRYABLE.has(response.status)) {
				await response.body?.cancel();
				await sleep(retryAfterMs(response, attempt), signal);
				continue;
			}
			const payload: { code?: unknown; extra?: Record<string, unknown> } | null = await response.json().catch(() => null);
			throw new CutProError(typeof payload?.code === "string" ? payload.code : "UNEXPECTED_RESPONSE", response.status, payload?.extra);
		}
	}
}

class Models {
	readonly #client: CutPro;
	constructor(client: CutPro) {
		this.#client = client;
	}

	/** Every model with its modes, resolutions, seconds, voices and prices in credits, dollars and reais. */
	list(filter: ModelFilter = {}, options: RequestOptions = {}): Promise<ModelList> {
		return this.#client.request("GET", "/models", { ...options, query: { ...filter } });
	}

	/** Only the strongest models of each kind. */
	featured(filter: ModelFilter = {}, options: RequestOptions = {}): Promise<ModelList> {
		return this.#client.request("GET", "/models/featured", { ...options, query: { ...filter } });
	}

	/** Public price list of the image, video and voice models in credits, dollars and reais. Needs no key. */
	prices(options: RequestOptions = {}): Promise<PriceList> {
		return this.#client.request("GET", "/prices", { ...options, auth: false });
	}
}

class Generations {
	readonly #client: CutPro;
	constructor(client: CutPro) {
		this.#client = client;
	}

	/** The exact total of a request, in credits. Free, generates nothing. */
	quote(request: GenerationRequest, options: RequestOptions = {}): Promise<Quote> {
		return this.#client.request("POST", "/generations/quote", { ...options, body: request });
	}

	/** Starts a generation. Without `credits`, it quotes first and agrees to that total. Safe to retry: the idempotency key never charges twice. */
	async create(request: CreateGenerationRequest, options: CreateOptions = {}): Promise<Generation> {
		const { credits, webhook_url, ...quoted } = request;
		const total = credits ?? (await this.quote(quoted, options)).credits;
		return this.#client.request("POST", "/generations", {
			signal: options.signal,
			headers: { ...options.headers, "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID() },
			query: { wait: options.wait },
			body: { ...quoted, credits: total, webhook_url },
		});
	}

	get(id: string, options: RequestOptions & { wait?: number } = {}): Promise<Generation> {
		return this.#client.request("GET", `/generations/${encodeURIComponent(id)}`, { ...options, query: { wait: options.wait } });
	}

	/** Polls until the generation is `ready` or `failed` and returns it either way. */
	async wait(id: string, options: WaitOptions = {}): Promise<Generation> {
		const { intervalMs = DEFAULT_INTERVAL_MS, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, ...request } = options;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const seconds = Math.min(MAX_SERVER_WAIT_SECONDS, Math.max(0, Math.floor((deadline - Date.now()) / 1000)));
			const generation = await this.get(id, { ...request, wait: seconds });
			if (generation.status !== "processing") return generation;
			if (Date.now() + intervalMs >= deadline) throw new CutProError("WAIT_TIMEOUT", 0, { id });
			await sleep(intervalMs, request.signal);
		}
	}

	/** Quotes, creates and waits. Throws `CutProError` with the generation's `error_code` when it fails. */
	async generate(request: CreateGenerationRequest, options: GenerateOptions = {}): Promise<Generation> {
		const { intervalMs, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, ...create } = options;
		const started = await this.create(request, { ...create, wait: Math.min(MAX_SERVER_WAIT_SECONDS, Math.floor(timeoutMs / 1000)) });
		const generation = started.status === "processing" ? await this.wait(started.id, { signal: options.signal, headers: options.headers, intervalMs, timeoutMs }) : started;
		if (generation.status === "failed") throw new CutProError(generation.error_code ?? "GENERATION_FAILED", 0, { id: generation.id });
		return generation;
	}

	/** The secret that signs this key's webhooks, for `verifyWebhook()`. Keep it on the server. */
	webhookSecret(options: RequestOptions = {}): Promise<{ secret: string }> {
		return this.#client.request("GET", "/generations/webhook-secret", options);
	}

	/** Full quality link, valid for 6 hours. After downloading, the credits can no longer be asked back. */
	download(id: string, options: RequestOptions = {}): Promise<{ url: string }> {
		return this.#client.request("GET", `/generations/${encodeURIComponent(id)}/download`, options);
	}
}

class MediaLibrary {
	readonly #client: CutPro;
	constructor(client: CutPro) {
		this.#client = client;
	}

	/** Uploads an image, video or sound (up to 100 MB), or reads one from a public link, for `image_ids`, `audio_ids` or `video_id`. */
	upload(input: Blob | { url: string }, options: RequestOptions & { filename?: string } = {}): Promise<Media> {
		const { filename, ...request } = options;
		if (!(input instanceof Blob)) return this.#client.request("POST", "/generations/media", { ...request, body: { url: input.url } });
		const form = new FormData();
		form.append("file", input, filename ?? "upload");
		return this.#client.request("POST", "/generations/media", { ...request, body: form, retry: false });
	}
}

const WEBHOOK_TOLERANCE_SECONDS = 300;

/** True when `CutPro-Signature` signs this exact raw body with your secret and is under five minutes old. Pass the body before any `JSON.parse`. */
export async function verifyWebhook(rawBody: string, signature: string | null, secret: string, toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS): Promise<boolean> {
	const parts = new Map((signature ?? "").split(",").map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)]));
	const t = Number(parts.get("t"));
	const v1 = parts.get("v1") ?? "";
	if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds || !/^[0-9a-f]{64}$/.test(v1)) return false;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
	const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	// Every character is compared, so the time taken says nothing about where a forged signature goes wrong.
	let difference = 0;
	for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ v1.charCodeAt(index);
	return difference === 0;
}

/**
 * A route for your own server that lets a browser app use the SDK without ever seeing the key.
 * Works with Bun.serve, Next.js route handlers, Hono, Cloudflare Workers and Deno: `(request) => proxy(request, { prefix: "/api/cutpro", authorize })`.
 */
export async function proxy(request: Request, options: ProxyOptions = {}): Promise<Response> {
	const apiKey = options.apiKey ?? envApiKey();
	if (!apiKey) return Response.json({ code: "API_KEY_MISSING" }, { status: 500 });
	const url = new URL(request.url);
	const prefix = options.prefix?.replace(/\/+$/, "") ?? "";
	const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : "";
	if (!PROXIED.some(([method, pattern]) => method === request.method && pattern.test(path))) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
	if (options.authorize && !(await options.authorize(request))) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
	const body = request.method === "GET" ? undefined : await request.arrayBuffer();
	if (body && body.byteLength > MAX_PROXY_BODY_BYTES) return Response.json({ code: "PAYLOAD_TOO_LARGE" }, { status: 413 });

	const target = path === "/prices" ? new URL(PRICES_PATH, API_ORIGIN) : new URL(`${API_PATH}${path}`, API_ORIGIN);
	target.search = url.search;
	const headers = new Headers({ Accept: "application/json", "X-Api-Key": apiKey });
	for (const name of ["content-type", "idempotency-key"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const upstream = await (options.fetch ?? fetch)(target, { method: request.method, headers, body, redirect: "error" });
	return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" } });
}

export type GenerationKind = "image" | "video" | "speech" | "music" | "audio" | "avatar" | "model3d" | "tool" | "videoedit" | "story";
export type ModelKind = GenerationKind | "text" | "embedding";
export type ModelEndpoint = "generations" | "chat_completions" | "embeddings";
export type GenerationMode = "text" | "image" | "frames" | "references" | "edit" | "control";
export type AspectRatio = "21:9" | "16:9" | "3:2" | "4:3" | "5:4" | "1:1" | "4:5" | "3:4" | "2:3" | "9:16";
export type Preset = "fast" | "balanced" | "best";
export type OptionValue = string | number | boolean | string[];

export interface GenerationRequest {
	/** `image`, `video` or `speech`; needed when `model` is left out or `auto`. */
	kind?: "image" | "video" | "speech";
	/** A model `id` from `models.list()`, such as `bytedance/seedance-2.5`, or `auto`. */
	model?: string;
	preset?: Preset;
	mode?: GenerationMode;
	/** One of the model's `resolutions`, such as `720p`. */
	resolution?: string;
	/** What to make, in any language, or the text a voice reads. */
	prompt?: string;
	/** The model's own fields from `parameters` in `models.list()`. */
	options?: Record<string, OptionValue>;
	/** Length of a video, one of the model's `seconds`. */
	seconds?: number;
	aspect_ratio?: AspectRatio;
	/** `false` leaves the sound out of a video whose model has `audio: "optional"`. */
	audio?: boolean;
	/** Required for a voice: one of the model's `voices[].id`. */
	voice?: string;
	image_ids?: string[];
	/** Public image links, read in place of an upload. */
	image_urls?: string[];
	audio_ids?: string[];
	audio_urls?: string[];
	video_id?: string;
	orientation?: "image" | "video";
	seed?: number;
}

export interface CreateGenerationRequest extends GenerationRequest {
	/** The quoted total. Left out, `generations.create()` quotes first and sends that total. */
	credits?: number;
	/** Public `https` address that gets a signed POST once the generation is `ready` or `failed`. */
	webhook_url?: string;
}

export interface Quote {
	/** Total price in credits: what `generations.create()` sends as `credits`. */
	credits: number;
	model: string;
	kind: GenerationKind;
	mode: GenerationMode | null;
	resolution: string | null;
	seconds: number | null;
	aspect_ratio: AspectRatio | null;
	audio: boolean | null;
	/** Fields that will not go as sent, such as `seconds` moved to the nearest the model draws. */
	warnings: string[];
}

export type GenerationStatus = "processing" | "ready" | "failed";

export type GenerationErrorCode =
	| "MEDIA_REJECTED"
	| "COPYRIGHT_BLOCKED"
	| "REAL_FACES_BLOCKED"
	| "SAFETY_BLOCKED"
	| "MEDIA_FAILED"
	| "MEDIA_UNAVAILABLE"
	| "INSUFFICIENT_CREDITS"
	| "TIMEOUT"
	| "OUTPUT_CHECK_FAILED"
	| "TARGET_NOT_A_PERSON";

export interface GenerationOutput {
	image_id: string | null;
	video_id: string | null;
	audio_id: string | null;
	/** Signed preview link, valid for 6 hours; an MP3 for a voice. */
	url: string;
	thumbnail_url: string | null;
}

export interface GenerationFile {
	kind: "image" | "video" | "audio" | "file";
	url: string;
	media_type: string | null;
	bytes: number;
	media_id: string | null;
	file_name: string | null;
}

export interface Generation {
	id: string;
	kind: GenerationKind;
	status: GenerationStatus;
	model: string;
	model_name: string;
	mode: GenerationMode | null;
	resolution: string | null;
	seconds: number | null;
	aspect_ratio: AspectRatio | null;
	voice: string | null;
	prompt: string | null;
	audio: boolean | null;
	voice_name: string | null;
	image_ids: string[];
	audio_ids: string[];
	video_id: string | null;
	seed: number | null;
	credits_charged: number;
	error_code: GenerationErrorCode | null;
	edit_id: string | null;
	output: GenerationOutput | null;
	outputs: GenerationFile[];
	text: string | null;
	options: Record<string, OptionValue> | null;
	expected_seconds: number | null;
	feedback: "up" | "down" | null;
	feedback_reason: string | null;
	refund_status: "requested" | "approved" | "denied" | null;
	downloaded: boolean;
	removed: boolean;
	created_at: string;
}

export interface ModelFilter {
	kind?: ModelKind;
	endpoint?: ModelEndpoint;
	/** Part of the id or the name. */
	q?: string;
	id?: string;
}

export interface ModelPricing {
	unit: "image" | "second" | "minute" | "1k_characters" | "run" | "megapixel" | "1m_input_tokens" | "1m_output_tokens" | "1m_tokens";
	credits: number;
	mode: GenerationMode | null;
	resolution: string | null;
	silent_credits: number | null;
	usd?: number | null;
	brl?: number | null;
}

export interface ModelParameter {
	type?: string;
	enum?: (string | number | boolean)[];
	default?: string | number | boolean;
	minimum?: number;
	maximum?: number;
	maxItems?: number;
	items?: string;
	description?: string;
}

export interface Voice {
	id: string;
	name: string;
	style: string | null;
	gender: "female" | "male" | null;
	age: "young" | "mature" | null;
	language: string | null;
	preview_url: string | null;
	portrait_url: string | null;
}

export interface Model {
	id: string;
	name: string;
	maker: string;
	kind: ModelKind;
	endpoint: ModelEndpoint;
	featured: boolean;
	pricing: ModelPricing[];
	priced_by_request: boolean;
	parameters: { properties: Record<string, ModelParameter>; required: string[] } | null;
	supported_parameters: string[];
	context_length: number | null;
	max_output_tokens: number | null;
	input_modalities: string[];
	modes: GenerationMode[];
	resolutions: string[];
	seconds: number[];
	mode_seconds: { mode: GenerationMode; seconds: number[] }[];
	aspect_ratios: AspectRatio[];
	audio: "always" | "optional" | null;
	max_images: number;
	max_audios: number;
	max_video_seconds: number | null;
	refuses: ("real_faces" | "minors" | "public_figures")[];
	voices: Voice[];
	scores: { mode: GenerationMode; points: number }[];
	typical_seconds: number | null;
	success_rate: number | null;
}

export interface PresetModel {
	id: Preset;
	model: string;
	resolution: string;
}

export interface ModelList {
	models: Model[];
	presets: { video: PresetModel[]; image: PresetModel[]; speech: PresetModel[] };
	prompt_max: number;
	max_running: number;
	improve_credits: number;
}

export interface Money {
	credits: number;
	usd: number;
	brl: number;
}

export interface PublicPrice extends Money {
	mode: string;
	resolution: string;
	/** The price without sound, for a video whose model has `audio: "optional"`. */
	silent: Money | null;
	lowest: boolean;
}

export interface PublicModel {
	id: string;
	name: string;
	maker: string;
	kind: "video" | "image" | "speech";
	/** What each price is per: a second of video, an image, or 1,000 characters of voice. */
	unit: "second" | "image" | "1k_characters";
	modes: string[];
	resolutions: string[];
	seconds: number[];
	aspect_ratios: string[];
	audio: string | null;
	max_images: number;
	max_video_seconds: number | null;
	prices: PublicPrice[];
}

export interface PriceList {
	updated_at: string;
	/** What one credit costs on the cheapest pack. */
	credit: { usd: number; brl: number };
	models: PublicModel[];
}

export interface Media {
	/** Library id, for `image_ids`, `audio_ids` or `video_id`. */
	id: string;
	kind: "image" | "video" | "audio";
	seconds: number | null;
}
