// Patch tool parameter schemas to accept JSON string arguments from
// Chat Completions APIs (DeepSeek, Groq, etc.). The @openai/agents SDK
// calls tool.parameters.parse(rawArgs) where rawArgs is a JSON string
// from Chat Completions, but zod schemas reject strings.
//
// This patches parse/safeParse on every tool's parameters after creation.

export function patchToolParameters(tools: any[]): void {
  for (const tool of tools) {
    const params = tool.parameters;
    if (!params) continue;

    // Patch parse
    if (typeof params.parse === 'function' && !(params as any).__patched) {
      const origParse = params.parse.bind(params);
      params.parse = function patchedParse(data: unknown, ...rest: any[]) {
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { /* pass */ }
        }
        return origParse(data, ...rest);
      };
      (params as any).__patched = true;
    }

    // Patch safeParse
    if (typeof params.safeParse === 'function' && !(params as any).__patchedSafe) {
      const origSafeParse = params.safeParse.bind(params);
      params.safeParse = function patchedSafeParse(data: unknown, ...rest: any[]) {
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { /* pass */ }
        }
        return origSafeParse(data, ...rest);
      };
      (params as any).__patchedSafe = true;
    }
  }
}
