import { describe, expect, it } from "vitest";
import { CutPro, CutProError, type Generation } from "../src/index";

type Sent = { method: string; url: URL; headers: Record<string, string>; body: string | FormData | undefined };

function mockFetch(replies: Array<[number, object]>) {
	const sent: Sent[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		sent.push({
			method: init?.method ?? "GET",
			url: new URL(String(input)),
			headers: Object.fromEntries(new Headers(init?.headers)),
			body: init?.body instanceof FormData ? init.body : init?.body?.toString(),
		});
		const reply = replies.shift();
		if (!reply) throw new Error("unexpected request");
		return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { "Content-Type": "application/json" } });
	};
	return { fetcher, sent };
}

function generation(status: Generation["status"], extra: Partial<Generation> = {}): Generation {
	return {
		id: "741",
		kind: "video",
		status,
		model: "bytedance/seedance-2.5",
		model_name: "Seedance 2.5",
		mode: "text",
		resolution: "720p",
		seconds: 5,
		aspect_ratio: "16:9",
		voice: null,
		prompt: "a dog surfing",
		audio: true,
		voice_name: null,
		image_ids: [],
		audio_ids: [],
		video_id: null,
		seed: 1,
		credits_charged: 225,
		error_code: null,
		edit_id: null,
		output: status === "ready" ? { image_id: null, video_id: "9", audio_id: null, url: "https://files.example/v.mp4", thumbnail_url: null } : null,
		outputs: [],
		text: null,
		options: null,
		expected_seconds: 90,
		feedback: null,
		feedback_reason: null,
		refund_status: null,
		downloaded: false,
		removed: false,
		created_at: "2026-11-06T00:00:00.000Z",
		...extra,
	};
}

const QUOTE = { credits: 225, model: "bytedance/seedance-2.5", kind: "video", mode: "text", resolution: "720p", seconds: 5, aspect_ratio: "16:9", audio: true, warnings: [] };

describe("CutPro", () => {
	it("sends the key and filters on models.list", async () => {
		const { fetcher, sent } = mockFetch([[200, { models: [], presets: { video: [], image: [], speech: [] }, prompt_max: 2000, max_running: 5, improve_credits: 1 }]]);
		const client = new CutPro({ apiKey: "key", fetch: fetcher });
		await client.models.list({ kind: "video", endpoint: "generations" });
		expect(sent[0]?.url.toString()).toBe("https://api.cut.pro/api/v1/models?kind=video&endpoint=generations");
		expect(sent[0]?.headers["x-api-key"]).toBe("key");
	});

	it("reads the public price list without a key", async () => {
		const { fetcher, sent } = mockFetch([[200, { updated_at: "x", credit: { usd: 0.0179, brl: 0.0599 }, models: [] }]]);
		const prices = await new CutPro({ apiKey: "key", fetch: fetcher }).models.prices();
		expect(sent[0]?.url.toString()).toBe("https://api.cut.pro/public/generations/models");
		expect(sent[0]?.headers["x-api-key"]).toBeUndefined();
		expect(prices.credit.brl).toBe(0.0599);
	});

	it("quotes, then creates with the quoted credits", async () => {
		const { fetcher, sent } = mockFetch([[200, QUOTE], [201, generation("processing")]]);
		const client = new CutPro({ apiKey: "key", fetch: fetcher });
		await client.generations.create({ model: "bytedance/seedance-2.5", prompt: "a dog surfing", seconds: 5, webhook_url: "https://app.example/hook" }, { idempotencyKey: "abc" });
		expect(sent[0]?.url.pathname).toBe("/api/v1/generations/quote");
		expect(JSON.parse(String(sent[0]?.body))).toEqual({ model: "bytedance/seedance-2.5", prompt: "a dog surfing", seconds: 5 });
		expect(sent[1]?.url.pathname).toBe("/api/v1/generations");
		expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ credits: 225, webhook_url: "https://app.example/hook" });
		expect(sent[1]?.headers["idempotency-key"]).toBe("abc");
	});

	it("skips the quote when credits are given", async () => {
		const { fetcher, sent } = mockFetch([[201, generation("processing")]]);
		await new CutPro({ apiKey: "key", fetch: fetcher }).generations.create({ model: "bytedance/seedance-2.5", prompt: "x", credits: 225 });
		expect(sent).toHaveLength(1);
	});

	it("throws CutProError with code, status and extra", async () => {
		const { fetcher } = mockFetch([[409, { code: "PRICE_CHANGED", extra: { credits: 240 } }]]);
		const error = await new CutPro({ apiKey: "key", fetch: fetcher }).generations.create({ prompt: "x", credits: 225 }).catch((caught) => caught);
		expect(error).toBeInstanceOf(CutProError);
		expect(error).toMatchObject({ code: "PRICE_CHANGED", status: 409, extra: { credits: 240 } });
	});

	it("generate holds the create, then long-polls until ready", async () => {
		const { fetcher, sent } = mockFetch([[200, QUOTE], [201, generation("processing")], [200, generation("ready")]]);
		const result = await new CutPro({ apiKey: "key", fetch: fetcher }).generations.generate({ model: "bytedance/seedance-2.5", prompt: "x" }, { intervalMs: 0 });
		expect(sent[1]?.url.searchParams.get("wait")).toBe("60");
		expect(sent[2]?.url.pathname).toBe("/api/v1/generations/741");
		expect(sent[2]?.url.searchParams.get("wait")).toBe("60");
		expect(result.output?.url).toBe("https://files.example/v.mp4");
	});

	it("generate throws the error_code of a failed generation", async () => {
		const { fetcher } = mockFetch([[200, QUOTE], [201, generation("failed", { error_code: "SAFETY_BLOCKED" })]]);
		const error = await new CutPro({ apiKey: "key", fetch: fetcher }).generations.generate({ prompt: "x" }).catch((caught) => caught);
		expect(error).toMatchObject({ code: "SAFETY_BLOCKED", status: 0, extra: { id: "741" } });
	});

	it("wait gives up at the timeout", async () => {
		const { fetcher, sent } = mockFetch([[200, generation("processing")]]);
		const error = await new CutPro({ apiKey: "key", fetch: fetcher }).generations.wait("741", { timeoutMs: 500, intervalMs: 1000 }).catch((caught) => caught);
		expect(sent[0]?.url.searchParams.get("wait")).toBe("0");
		expect(error).toMatchObject({ code: "WAIT_TIMEOUT" });
	});

	it("uploads a file as multipart and a link as JSON", async () => {
		const { fetcher, sent } = mockFetch([[201, { id: "1", kind: "image", seconds: null }], [201, { id: "2", kind: "image", seconds: null }]]);
		const client = new CutPro({ apiKey: "key", workspaceId: "ws", fetch: fetcher });
		await client.media.upload(new Blob(["x"], { type: "image/png" }), { filename: "a.png" });
		await client.media.upload({ url: "https://img.example/a.png" });
		expect(sent[0]?.body).toBeInstanceOf(FormData);
		expect(sent[0]?.headers["content-type"]).toBeUndefined();
		expect(sent[0]?.headers["x-workspace-id"]).toBe("ws");
		expect(JSON.parse(String(sent[1]?.body))).toEqual({ url: "https://img.example/a.png" });
	});
});
