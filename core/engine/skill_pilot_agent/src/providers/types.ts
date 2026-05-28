export interface ProviderConfig {
  id: string;
  base_url: string;
  api_key_env: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  models: string[];
  effort_levels: string[];
}

export interface ProvidersFile {
  providers: ProviderConfig[];
  default: string;
}

export interface ResolvedProvider {
  provider: ProviderConfig;
  model: string;
}

export interface AdapterStreamEvent {
  type: 'text_delta' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  error?: string;
}
