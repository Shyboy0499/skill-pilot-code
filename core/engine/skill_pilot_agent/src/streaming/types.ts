export interface ToolChunk {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  data?: string;
  code?: number;
}

export interface StreamOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd: string;
}

export type ToolOutput = string | AsyncIterable<ToolChunk>;
