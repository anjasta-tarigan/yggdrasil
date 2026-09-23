import { z } from "zod";
import { env } from "@/env";
import type { UserAgentMode } from "./types";

export type AdapterErrorCode =
  | "invalid_request"
  | "session_rejected"
  | "rate_limited"
  | "unsupported_protocol"
  | "upstream_timeout"
  | "network_error"
  | "feature_disabled"
  | "protocol_error";

export interface ClassifiedFailure {
  code: AdapterErrorCode;
  httpStatus: number;
  message: string;
}

export const ERROR_MAPPING: Record<AdapterErrorCode, { status: number; message: string }> = {
  invalid_request: { status: 400, message: "The request is invalid." },
  session_rejected: { status: 401, message: "The session was rejected. Your credentials were not saved." },
  rate_limited: { status: 429, message: "Too many attempts. Try again after the cooldown." },
  unsupported_protocol: { status: 502, message: "DeepSeek Web is not supported by this adapter version." },
  upstream_timeout: { status: 504, message: "DeepSeek Web did not respond in time." },
  network_error: { status: 502, message: "DeepSeek Web could not be reached." },
  feature_disabled: { status: 404, message: "Experimental Web Providers are currently disabled." },
  protocol_error: { status: 502, message: "DeepSeek Web returned an unsupported response." },
};

const CandidateSchema = z.object({
  userToken: z.string().trim(),
  userAgentMode: z.enum(["browser", "server-default", "custom"]).default("browser"),
  userAgent: z.string().max(env.YGGDRASIL_WEB_PROVIDER_MAX_USER_AGENT_CHARS).optional(),
});

export function parseSessionCandidate(input: unknown): {
  ok: true;
  data: { userToken: string; userAgentMode: UserAgentMode; userAgent?: string };
} | { ok: false; error: string } {
  const result = CandidateSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? "Invalid candidate format" };
  }

  let token = result.data.userToken;
  const prefix = "userToken=";
  if (token.startsWith(prefix)) {
    token = token.slice(prefix.length).trim();
  }

  if (token.length === 0) {
    return { ok: false, error: "Token cannot be empty" };
  }

  if (token.length > env.YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS) {
    return { ok: false, error: `Token exceeds maximum length of ${env.YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS}` };
  }

  if (/[\r\n\x00-\x1F]/.test(token)) {
    return { ok: false, error: "Token must not contain control characters or newlines" };
  }

  if (result.data.userAgent && /[\r\n\x00-\x1F]/.test(result.data.userAgent)) {
    return { ok: false, error: "User-Agent must not contain control characters or newlines" };
  }

  return {
    ok: true,
    data: {
      userToken: token,
      userAgentMode: result.data.userAgentMode as UserAgentMode,
      userAgent: result.data.userAgent,
    },
  };
}

export function classifyFailure(errorOrResponse: unknown): ClassifiedFailure {
  if (errorOrResponse instanceof Response) {
    const status = errorOrResponse.status;
    if (status === 401 || status === 403) {
      return { code: "session_rejected", httpStatus: 401, message: ERROR_MAPPING.session_rejected.message };
    }
    if (status === 429) {
      return { code: "rate_limited", httpStatus: 429, message: ERROR_MAPPING.rate_limited.message };
    }
    if (status >= 300 && status < 400) {
      return { code: "unsupported_protocol", httpStatus: 502, message: ERROR_MAPPING.unsupported_protocol.message };
    }
    if (status === 504 || status === 408) {
      return { code: "upstream_timeout", httpStatus: 504, message: ERROR_MAPPING.upstream_timeout.message };
    }
    return { code: "protocol_error", httpStatus: 502, message: ERROR_MAPPING.protocol_error.message };
  }

  if (errorOrResponse instanceof Error) {
    if (errorOrResponse.name === "AbortError" || errorOrResponse.message.includes("aborted")) {
      return { code: "upstream_timeout", httpStatus: 504, message: ERROR_MAPPING.upstream_timeout.message };
    }
    return { code: "network_error", httpStatus: 502, message: ERROR_MAPPING.network_error.message };
  }

  return { code: "protocol_error", httpStatus: 502, message: ERROR_MAPPING.protocol_error.message };
}
