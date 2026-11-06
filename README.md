# Cut.Pro SDK for Node.js and edge: Seedance, Wan, Kling, Veo and Nano Banana API

[![npm](https://img.shields.io/npm/v/@cutpro/sdk)](https://www.npmjs.com/package/@cutpro/sdk) [![license](https://img.shields.io/npm/l/@cutpro/sdk)](LICENSE)

One API key for video, image and voice models: Seedance 2.5, Wan 3, Kling O3, Veo 3.1, Gemini Omni Flash, Nano Banana Pro, Seedream 5, Qwen Image, GPT Image, Grok Imagine, MiniMax and Gemini TTS voices. Priced per second of video, per image or per 1,000 characters of voice, in reais and dollars: see the [live price list](https://cut.pro/en/models). Pay with Pix or card; companies get an invoice.

Typed, zero dependencies, native `fetch`. Works on Node 18+, Bun, Deno, Cloudflare Workers and Vercel Edge.

```bash
npm install @cutpro/sdk
```

## Quickstart

Create a key at [cut.pro/studio/me/api-keys](https://cut.pro/studio/me/api-keys). Every account starts with free credits.

```ts
import { CutPro } from "@cutpro/sdk";

const cutpro = new CutPro({ apiKey: process.env.CUTPRO_API_KEY });

const video = await cutpro.generations.generate({
	model: "bytedance/seedance-2.5",
	prompt: "a golden retriever surfing a wave at sunset, cinematic",
	seconds: 5,
	resolution: "720p",
	aspect_ratio: "16:9",
});

console.log(video.output?.url, `${video.credits_charged} credits`);
```

`generate()` quotes the request, starts it with the quoted total and waits until it is ready. Each step is also its own call.

## Seedance API in Node.js, step by step

```ts
const quote = await cutpro.generations.quote({ model: "bytedance/seedance-2.5", prompt: "a dog surfing", seconds: 5 });
console.log(`${quote.credits} credits`); // show the price and wait for a yes

const started = await cutpro.generations.create(
	{ model: "bytedance/seedance-2.5", prompt: "a dog surfing", seconds: 5, credits: quote.credits },
	{ idempotencyKey: crypto.randomUUID() },
);

const done = await cutpro.generations.wait(started.id, { timeoutMs: 10 * 60_000 });
if (done.status === "ready") console.log(done.output?.url);
```

- `create()` without `credits` quotes first and agrees to that total. With `credits`, the price is checked on the server: if it changed, nothing is charged and you get `PRICE_CHANGED` with the new total in `extra.credits`.
- `idempotencyKey`: repeating the same request with the same key within 24 hours never charges twice.
- `webhook_url` in the request gets a signed POST when the generation ends, instead of waiting.

## Wan 3 image to video

```ts
const clip = await cutpro.generations.generate({
	model: "alibaba/wan-3",
	mode: "image",
	image_urls: ["https://your-cdn.com/product.jpg"],
	prompt: "the camera slowly orbits the product, soft studio light",
	seconds: 5,
	resolution: "720p",
});
```

Local file? Upload it first: `const { id } = await cutpro.media.upload(new Blob([bytes]), { filename: "product.jpg" })` and send `image_ids: [id]`.

## Nano Banana Pro image with references

```ts
const image = await cutpro.generations.generate({
	model: "google/nano-banana-pro",
	mode: "references",
	image_urls: ["https://your-cdn.com/person.jpg", "https://your-cdn.com/jacket.jpg"],
	prompt: "the person from the first image wearing the jacket from the second, street photo",
	aspect_ratio: "4:5",
});
```

## Gemini TTS voice

```ts
const { models } = await cutpro.models.list({ id: "google/gemini-3.1-flash-tts" });
console.log(models[0]?.voices.map((voice) => voice.id));

const voice = await cutpro.generations.generate({
	model: "google/gemini-3.1-flash-tts",
	voice: "Kore",
	prompt: "Welcome to Cut.Pro. Your video is ready.",
});
console.log(voice.output?.url); // MP3
```

## Models and prices

```ts
const { models, presets } = await cutpro.models.list({ kind: "video", endpoint: "generations" });
const featured = await cutpro.models.featured({ kind: "image" });

// Public price list, no key needed: credits, dollars and reais per unit.
const prices = await new CutPro().models.prices();
```

| Kind | Model ids |
|---|---|
| Video | [`bytedance/seedance-2.5`](https://cut.pro/en/models/seedance-2-5), [`bytedance/seedance-2`](https://cut.pro/en/models/seedance-2), [`alibaba/wan-3`](https://cut.pro/en/models/wan-3), [`kling/kling-o3-pro`](https://cut.pro/en/models/kling-o3-pro), [`kling/kling-3-pro`](https://cut.pro/en/models/kling-3-pro), [`google/veo-3.1`](https://cut.pro/en/models/veo-3-1), [`google/gemini-omni-flash-1.1`](https://cut.pro/en/models/gemini-omni-flash-1-1), [`xai/grok-imagine-video-1.5`](https://cut.pro/en/models/grok-imagine-video-1-5), [`minimax/h3`](https://cut.pro/en/models/h3) |
| Image | [`google/nano-banana-pro`](https://cut.pro/en/models/nano-banana-pro), [`bytedance/seedream-5-pro`](https://cut.pro/en/models/seedream-5-pro), [`alibaba/qwen-image-3-pro`](https://cut.pro/en/models/qwen-image-3-pro), [`openai/gpt-image-2.5`](https://cut.pro/en/models/gpt-image-2-5), [`xai/grok-imagine-image-2`](https://cut.pro/en/models/grok-imagine-image-2) |
| Voice | [`google/gemini-3.1-flash-tts`](https://cut.pro/en/models/gemini-3-1-flash-tts), [`minimax/speech-2.8-hd`](https://cut.pro/en/models/speech-2-8-hd) |

The full catalog (every image, video and voice model, plus music, sound, avatars and 3D) is in `models.list()` and at [cut.pro/en/models](https://cut.pro/en/models). Prices change: read them from the API, never hard-code them.

## Errors

Every error is a `CutProError` with a stable `code`, the HTTP `status` and `extra` when there is something to act on.

```ts
import { CutProError } from "@cutpro/sdk";

try {
	await cutpro.generations.generate({ model: "bytedance/seedance-2.5", prompt: "a dog surfing", seconds: 3 });
} catch (error) {
	if (!(error instanceof CutProError)) throw error;
	switch (error.code) {
		case "INSUFFICIENT_CREDITS":
			console.log("Top up at", error.extra?.top_up_url);
			break;
		case "SECONDS_INVALID":
			console.log("Allowed seconds:", error.extra?.allowed);
			break;
		case "SAFETY_BLOCKED":
			console.log("The model refused the prompt; credits are already back.");
			break;
		default:
			throw error;
	}
}
```

`status` is `0` for errors raised by the client: `WAIT_TIMEOUT`, or a generation that ended `failed` (its `error_code` becomes `code`, and the credits come back on their own). Full list in the [error catalog](https://cut.pro/docs/en/errors).

## Options

```ts
new CutPro({
	apiKey: "...", // defaults to process.env.CUTPRO_API_KEY
	workspaceId: "...", // only for a key that reaches more than one workspace
	baseURL: "https://api.cut.pro/api/v1",
	fetch: customFetch,
	headers: { "X-Trace": "1" },
});
```

Every method takes `{ signal }` to cancel. Keep the key on the server: it spends credits.

## Links

- [Generation guide](https://cut.pro/docs/en/generations) and [API reference](https://cut.pro/docs/reference)
- [Python SDK](https://github.com/getcutpro/sdk-python), [Vercel AI SDK provider](https://github.com/getcutpro/ai-sdk-provider), [n8n node](https://github.com/getcutpro/n8n-nodes-cutpro), [examples](https://github.com/getcutpro/examples)

## Em português

SDK oficial da Cut.Pro para Node.js: uma chave de API para Seedance 2.5, Wan 3, Kling O3, Veo 3.1, Nano Banana Pro, Seedream 5, GPT Image, Grok Imagine, MiniMax e vozes do Gemini TTS. Preço por segundo de vídeo, por imagem ou por 1.000 caracteres de voz, em reais: veja a [tabela de preços ao vivo](https://cut.pro/pt-BR/models). Pague com Pix ou cartão, com nota fiscal para empresas. Toda conta começa com créditos grátis.

```ts
import { CutPro } from "@cutpro/sdk";

const cutpro = new CutPro({ apiKey: process.env.CUTPRO_API_KEY });
const video = await cutpro.generations.generate({ model: "bytedance/seedance-2.5", prompt: "um cachorro surfando no pôr do sol", seconds: 5 });
console.log(video.output?.url);
```

Crie a chave em [cut.pro/studio/me/api-keys](https://cut.pro/studio/me/api-keys). Guia em português: [cut.pro/docs/generations](https://cut.pro/docs/generations). Página de cada modelo, com preço e exemplos: [Seedance 2.5](https://cut.pro/pt-BR/models/seedance-2-5), [Wan 3](https://cut.pro/pt-BR/models/wan-3), [Nano Banana Pro](https://cut.pro/pt-BR/models/nano-banana-pro), [Gemini 3.1 Flash TTS](https://cut.pro/pt-BR/models/gemini-3-1-flash-tts).

## License

MIT
