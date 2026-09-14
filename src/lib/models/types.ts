export type ModelKind = "embedding" | "reranker";

export interface HfTreeEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  oid?: string;
  lfs?: {
    oid: string; // sha256
    size: number;
    pointerSize: number;
  };
}

export interface HfModelInfo {
  id: string;
  tags?: string[];
  siblings?: Array<{ rfilename: string }>;
  pipeline_tag?: string;
}

export interface HfSearchResult {
  id: string;
  downloads: number;
  likes: number;
  pipeline_tag?: string;
  tags?: string[];
  siblings?: Array<{ rfilename: string }>;
}

export class HfError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HfError";
  }
}
