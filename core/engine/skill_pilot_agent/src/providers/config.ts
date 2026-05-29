import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig, ProvidersFile, ResolvedProvider } from './types';

let _registry: Map<string, ProviderConfig> | null = null;
let _defaultProviderId: string | null = null;

export function loadProviderConfig(configPath?: string): void {
  const resolvedPath = configPath || path.resolve(__dirname, '../../providers.json');

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Provider config not found at ${resolvedPath}`);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    console.error(`Error: Cannot read provider config at ${resolvedPath}`);
    process.exit(1);
  }

  let data: ProvidersFile;
  try {
    data = JSON.parse(raw) as ProvidersFile;
  } catch {
    console.error(`Error: Invalid JSON in provider config at ${resolvedPath}`);
    process.exit(1);
  }

  if (!data.providers || data.providers.length === 0) {
    console.error('Error: No providers defined in config.');
    process.exit(1);
  }

  _registry = new Map();
  for (const provider of data.providers) {
    if (!provider.id || !provider.base_url || !provider.api_key_env || !provider.protocol) {
      console.error(`Error: Provider entry missing required fields (id, base_url, api_key_env, protocol).`);
      process.exit(1);
    }
    for (const model of provider.models) {
      _registry.set(model, provider);
    }
  }

  _defaultProviderId = data.default || data.providers[0].id;
}

export function resolveModel(model: string): ResolvedProvider {
  if (!_registry) {
    console.error('Error: Provider config not loaded. Call loadProviderConfig() first.');
    process.exit(1);
  }

  const provider = _registry.get(model);
  if (!provider) {
    const allModels = Array.from(_registry.keys()).join(', ');
    console.error(`Error: Unknown model '${model}'. Available models: ${allModels}`);
    process.exit(1);
  }

  return { provider, model };
}

export function checkApiKey(resolved: ResolvedProvider): void {
  const apiKey = process.env[resolved.provider.api_key_env];
  if (!apiKey) {
    console.error(
      `Error: ${resolved.provider.api_key_env} not set. Required by provider '${resolved.provider.id}' for model '${resolved.model}'.`
    );
    process.exit(1);
  }
}

export function getDefaultModel(): string | null {
  if (!_registry || !_defaultProviderId) return null;
  for (const [model, provider] of _registry) {
    if (provider.id === _defaultProviderId) {
      return model;
    }
  }
  return null;
}

export function listModels(): string[] {
  if (!_registry) return [];
  return Array.from(_registry.keys());
}

export function getProviderById(id: string): ProviderConfig | undefined {
  if (!_registry) return undefined;
  for (const provider of _registry.values()) {
    if (provider.id === id) return provider;
  }
  return undefined;
}
