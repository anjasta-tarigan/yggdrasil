export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CustomToolExecution =
  | {
      type: "http";
      url: string;
      method: HttpMethod;
      headers?: Record<string, string>;
      timeoutMs?: number;
      allowLoopback?: boolean;
    }
  | {
      type: "javascript";
      code: string;
      timeoutMs?: number;
    };

export interface CustomToolConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schema: Record<string, unknown>;
  execution: CustomToolExecution;
  createdAt: number;
  updatedAt: number;
}

export type CustomToolSummary = Omit<CustomToolConfig, "execution"> & {
  execution: {
    type: "http";
    url: string;
    method: HttpMethod;
    timeoutMs: number;
    headers?: Record<string, string>;
    hasSecrets: boolean;
  };
};

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
