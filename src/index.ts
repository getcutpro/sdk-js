import type { CreateGenerationRequest, Generation, GenerationRequest, Media, ModelFilter, ModelList, PriceList, Quote } from "./types";

export type * from "./types";

const DEFAULT_BASE_URL = "https://api.cut.pro/api/v1";
const MAX_SERVER_WAIT_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 1000;

export interface CutProOptions {
	/** Defaults to the `CUTPRO_API_KEY` environment variable. Get one at https://cut.pro/studio/me/api-keys */
	apiKey?: string;
	baseURL?: string;
	/** Only for a key that reaches more than one workspace. */
	workspaceId?: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
}

export interface RequestOptions {
	signal?: AbortSignal;
	headers?: Record<string, string>;
}

export interface CreateOptions extends RequestOptions {
	/** Any unique string: the same key within 24 hours answers the first result and never charges twice. */
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

export class CutProError extends Error {
	readonly code: string;
	/** HTTP status, or 0 when the client raised it (`WAIT_TIMEOUT`, or a generation that ended `failed`). */
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
}

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

function envApiKey(): string | undefined {
	return typeof process !== "undefined" ? process.env?.CUTPRO_API_KEY : undefined;
}

export class CutPro {
	readonly models: Models;
	readonly generations: Generations;
	readonly media: MediaLibrary;
	private readonly apiKey: string | undefined;
	private readonly baseURL: string;
	private readonly workspaceId: string | undefined;
	private readonly fetcher: typeof fetch;
	private readonly headers: Record<string, string>;

	constructor(options: CutProOptions = {}) {
		this.apiKey = options.apiKey ?? envApiKey();
		this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.workspaceId = options.workspaceId;
		this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
		this.headers = options.headers ?? {};
		this.models = new Models(this);
		this.generations = new Generations(this);
		this.media = new MediaLibrary(this);
	}

	/** @internal */
	async request<T>(method: string, path: string, call: Call = {}): Promise<T> {
		const url = new URL(path.startsWith("/public/") ? path : `${this.baseURL}${path}`, this.baseURL);
		for (const [key, value] of Object.entries(call.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));

		const headers: Record<string, string> = { Accept: "application/json", ...this.headers, ...call.headers };
		if (call.auth !== false && this.apiKey) headers["X-Api-Key"] = this.apiKey;
		if (call.auth !== false && this.workspaceId) headers["X-Workspace-Id"] = this.workspaceId;
		let body: string | FormData | undefined;
		if (call.body instanceof FormData) body = call.body;
		else if (call.body) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(call.body);
		}

		const response = await this.fetcher(url, { method, headers, body, signal: call.signal });
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			const code = typeof payload?.code === "string" ? payload.code : "UNEXPECTED_RESPONSE";
			throw new CutProError(code, response.status, payload?.extra ?? undefined);
		}
		return payload;
	}
}

class Models {
	constructor(private readonly client: CutPro) {}

	/** Every model with its modes, resolutions, seconds, voices and prices in credits. */
	list(filter: ModelFilter = {}, options: RequestOptions = {}): Promise<ModelList> {
		return this.client.request("GET", "/models", { ...options, query: { ...filter } });
	}

	/** Only the strongest models of each kind. */
	featured(filter: ModelFilter = {}, options: RequestOptions = {}): Promise<ModelList> {
		return this.client.request("GET", "/models/featured", { ...options, query: { ...filter } });
	}

	/** Public price list of the image, video and voice models in credits, dollars and reais. Needs no key. */
	prices(options: RequestOptions = {}): Promise<PriceList> {
		return this.client.request("GET", "/public/generations/models", { ...options, auth: false });
	}
}

class Generations {
	constructor(private readonly client: CutPro) {}

	/** The exact total of a request, in credits. Free, generates nothing. */
	quote(request: GenerationRequest, options: RequestOptions = {}): Promise<Quote> {
		return this.client.request("POST", "/generations/quote", { ...options, body: request });
	}

	/** Starts a generation. Without `credits`, it quotes first and agrees to that total. */
	async create(request: CreateGenerationRequest, options: CreateOptions = {}): Promise<Generation> {
		const { credits, webhook_url, ...quoted } = request;
		const total = credits ?? (await this.quote(quoted, options)).credits;
		const headers = options.idempotencyKey ? { ...options.headers, "Idempotency-Key": options.idempotencyKey } : options.headers;
		return this.client.request("POST", "/generations", {
			signal: options.signal,
			headers,
			query: { wait: options.wait },
			body: { ...quoted, credits: total, webhook_url },
		});
	}

	get(id: string, options: RequestOptions & { wait?: number } = {}): Promise<Generation> {
		return this.client.request("GET", `/generations/${encodeURIComponent(id)}`, { ...options, query: { wait: options.wait } });
	}

	/** Polls until the generation is `ready` or `failed` and returns it either way. */
	async wait(id: string, options: WaitOptions = {}): Promise<Generation> {
		const { intervalMs = DEFAULT_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, ...request } = options;
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
		const { intervalMs, timeoutMs = DEFAULT_TIMEOUT_MS, ...create } = options;
		const started = await this.create(request, { ...create, wait: Math.min(MAX_SERVER_WAIT_SECONDS, Math.floor(timeoutMs / 1000)) });
		const generation = started.status === "processing" ? await this.wait(started.id, { signal: options.signal, headers: options.headers, intervalMs, timeoutMs }) : started;
		if (generation.status === "failed") throw new CutProError(generation.error_code ?? "GENERATION_FAILED", 0, { id: generation.id });
		return generation;
	}

	/** Full quality link, valid for 6 hours. After downloading, the credits can no longer be asked back. */
	download(id: string, options: RequestOptions = {}): Promise<{ url: string }> {
		return this.client.request("GET", `/generations/${encodeURIComponent(id)}/download`, options);
	}
}

class MediaLibrary {
	constructor(private readonly client: CutPro) {}

	/** Uploads an image, video or sound (up to 100 MB), or reads one from a public link, for `image_ids`, `audio_ids` or `video_id`. */
	upload(input: Blob | { url: string }, options: RequestOptions & { filename?: string } = {}): Promise<Media> {
		const { filename, ...request } = options;
		if (!(input instanceof Blob)) return this.client.request("POST", "/generations/media", { ...request, body: { url: input.url } });
		const form = new FormData();
		form.append("file", input, filename ?? "upload");
		return this.client.request("POST", "/generations/media", { ...request, body: form });
	}
}
