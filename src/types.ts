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
