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

function closestMatch(input: string, candidates: string[]): string | null {
  let best = null;
  let bestDist = Infinity;
  const lower = input.toLowerCase();
  for (const c of candidates) {
    const dist = levenshtein(lower, c.toLowerCase());
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function resolveModel(model: string): ResolvedProvider {
  if (!_registry) {
    console.error('Error: Provider config not loaded. Call loadProviderConfig() first.');
    process.exit(1);
  }

  const provider = _registry.get(model);
  if (!provider) {
    const allModels = Array.from(_registry.keys());
    const suggestion = closestMatch(model, allModels);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    console.error(`Error: Unknown model '${model}'.${hint} Available models: ${allModels.join(', ')}`);
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
