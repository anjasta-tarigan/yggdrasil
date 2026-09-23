export type SessionStatus =
  | "not-configured"
  | "verified"
  | "expired"
  | "rejected"
  | "rate-limited"
  | "degraded"
  | "unsupported";

export type UserAgentMode = "browser" | "server-default" | "custom";

export interface DecryptedSessionPayload {
  version: 1;
  userToken: string;
  selectedUserAgent?: string;
}

export interface WebProviderSession {
  id: string;
  providerId: string;
  userToken: string;
  selectedUserAgent?: string;
  status: SessionStatus;
  lastCheckedAt: Date | null;
  lastFailureCode: string | null;
  userAgentMode: UserAgentMode | null;
  capturedAt: Date | null;
  sessionVersion: number;
}

export interface WebProviderSessionView {
  providerId: string;
  status: SessionStatus;
  lastCheckedAt: Date | null;
  userAgentMode: UserAgentMode | null;
  capturedAt: Date | null;
}
