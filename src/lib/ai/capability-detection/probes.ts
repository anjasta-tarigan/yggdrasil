import { ProviderKind } from "@/lib/ai/provider-config/schema";

export type ProbeModality = "image" | "audio" | "video";

export type ProbeErrorClass =
  | "modality_not_supported"
  | "auth"
  | "rate_limit"
  | "5xx"
  | "unknown";

export type ProbeResult = {
  supported: boolean | null;
  errorClass: ProbeErrorClass;
};

// 1x1 transparent PNG in base64
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ~0.1s silent WAV in base64
const TINY_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

// Tiny 1-frame MP4 in base64
const TINY_MP4_DATA_URL =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAB5tZGF0AAACAAEAAP//";

const MODALITY_UNSUPPORTED_REGEX =
  /not supported|unsupported|does not support.*(image|audio|video|vision)|vision.*not available|text.*only/i;

/**
 * Probe a provider endpoint for specific modality support.
 * 200 OK -> { supported: true, errorClass: "unknown" }
 * Regex error match -> { supported: false, errorClass: "modality_not_supported" }
 * 401/403 -> { supported: null, errorClass: "auth" }
 * 429 -> { supported: null, errorClass: "rate_limit" }
 * 500-599 -> { supported: null, errorClass: "5xx" }
 * other/timeout -> { supported: null, errorClass: "unknown" }
 */
export async function probeModality(opts: {
  baseUrl: string;
  apiKey?: string;
  kind: ProviderKind;
  modelId: string;
  modality: ProbeModality;
}): Promise<ProbeResult> {
  const normalizedBase = opts.baseUrl.replace(/\/$/, "");

  let payload: Record<string, unknown>;
  if (opts.modality === "image") {
    payload = {
      model: opts.modelId,
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
            { type: "text", text: "describe" },
          ],
        },
      ],
    };
  } else if (opts.modality === "audio") {
    payload = {
      model: opts.modelId,
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: TINY_WAV_DATA_URL.split(",")[1], format: "wav" },
            },
            { type: "text", text: "describe" },
          ],
        },
      ],
    };
  } else {
    // video
    payload = {
      model: opts.modelId,
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            { type: "video_url", video_url: { url: TINY_MP4_DATA_URL } },
            { type: "text", text: "describe" },
          ],
        },
      ],
    };
  }

  try {
    const res = await fetch(`${normalizedBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      return { supported: true, errorClass: "unknown" };
    }

    const responseText = await res.text().catch(() => "");

    if (MODALITY_UNSUPPORTED_REGEX.test(responseText)) {
      return { supported: false, errorClass: "modality_not_supported" };
    }

    if (res.status === 401 || res.status === 403) {
      return { supported: null, errorClass: "auth" };
    }

    if (res.status === 429) {
      return { supported: null, errorClass: "rate_limit" };
    }

    if (res.status >= 500 && res.status <= 599) {
      return { supported: null, errorClass: "5xx" };
    }

    return { supported: null, errorClass: "unknown" };
  } catch {
    return { supported: null, errorClass: "unknown" };
  }
}
