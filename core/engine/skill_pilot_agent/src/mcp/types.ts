export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ListToolsResult {
  tools: MCPToolDef[];
}

export interface CallToolResult {
  content: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface MCPClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
