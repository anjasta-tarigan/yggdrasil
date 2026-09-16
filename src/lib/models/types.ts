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
  /** Present when the search was sorted by downloads (rank is 1-based). */
  rank?: number;
  /** Total onnx variants declared by the repo (search metadata only). */
  onnxVariants?: number;
  /** Quantized variant filenames available, best-first. */
  variants?: string[];
}

export class HfError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HfError";
  }
}
