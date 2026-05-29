import { spawn, ChildProcess } from 'node:child_process';
import { z } from 'zod';

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  MCPToolDef,
  CallToolResult,
  MCPClientOptions,
} from './types.js';

export class MCPClient {
  private options: MCPClientOptions;
  private process: ChildProcess | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = '';

  constructor(options: MCPClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.process) {
      throw new Error('MCPClient is already connected');
    }

    this.process = spawn(this.options.command, this.options.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.options.env,
      cwd: this.options.cwd,
    });

    this.process.stdout?.on('data', (data: Buffer) => this.handleData(data));

    this.process.stderr?.on('data', (data: Buffer) => {
      // Log stderr for debugging but don't treat as fatal
      console.error(`[MCP stderr] ${data.toString()}`);
    });

    this.process.on('error', (err: Error) => {
      // Reject all pending requests on spawn/process error
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP process error: ${err.message}`));
      }
      this.pending.clear();
    });

    this.process.on('exit', (code: number | null) => {
      const msg = code !== 0 && code !== null
        ? `MCP process exited with code ${code}`
        : 'MCP process exited';
      for (const [, pending] of this.pending) {
        pending.reject(new Error(msg));
      }
      this.pending.clear();
    });

    // Send initialize request
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'skill-pilot-agent', version: '1.0.0' },
      capabilities: {},
    });
  }

  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.sendRequest('tools/list') as { tools: MCPToolDef[] };
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as CallToolResult;
    return result;
  }

  async disconnect(): Promise<void> {
    if (!this.process) {
      return;
    }

    // Reject all pending requests
    for (const [, pending] of this.pending) {
      pending.reject(new Error('MCPClient disconnected'));
    }
    this.pending.clear();

    this.process.kill();
    this.process = null;
    this.buffer = '';
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error('MCPClient is not connected'));
    }

    const id = ++this.nextId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      try {
        this.process!.stdin!.write(JSON.stringify(request) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(new Error(`Failed to send MCP request: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        console.error(`[MCP] Failed to parse JSON response: ${line}`);
        continue;
      }

      const pending = this.pending.get(response.id);
      if (!pending) {
        console.error(`[MCP] Unexpected response id: ${response.id}`);
        continue;
      }

      this.pending.delete(response.id);

      if (response.error) {
        pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
      } else {
        pending.resolve(response.result);
      }
    }
  }
}

// Wrap MCP tools as agent-compatible tool objects
export async function loadMCPTools(client: MCPClient): Promise<any[]> {
  const mcpToolDefs = await client.listTools();
  return mcpToolDefs.map(def => ({
    type: 'function' as const,
    name: 'mcp_' + def.name,
    description: def.description || ('MCP tool: ' + def.name),
    parameters: z.object({}).passthrough(),
    run: async (args: Record<string, unknown>) => {
      const result = await client.callTool(def.name, args);
      if (result.isError) {
        return 'MCP tool error: ' + result.content.map(c => c.text || '').join('\n');
      }
      return result.content.map(c => c.text || '').join('\n');
    },
  }));
}
