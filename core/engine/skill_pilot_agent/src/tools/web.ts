import { URL } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// safeUrl — block file://, internal IPs, and localhost
// ---------------------------------------------------------------------------

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

function isPrivateIP(hostname: string): boolean {
  // IPv4 private / loopback ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // IPv6 loopback
  if (hostname === '::1') return true;
  return false;
}

function safeUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  // Block file:// and other non-http schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme "${parsed.protocol}//": only http and https are allowed.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(hostname) || hostname === 'localhost.localdomain') {
    throw new Error(`Blocked URL: ${hostname} is not allowed.`);
  }

  if (isPrivateIP(hostname)) {
    throw new Error(`Blocked URL: ${hostname} is a private/internal address.`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// webFetchTool
// ---------------------------------------------------------------------------

export const webFetchTool = {
  type: 'function' as const,
  name: 'web_fetch',
  description:
    'Fetch content from a URL and return as text. Strips HTML tags from web pages.',
  parameters: z.object({
    url: z.string().describe('The URL to fetch content from.'),
    max_length: z
      .number()
      .optional()
      .default(50000)
      .describe('Maximum number of characters to return. Default 50000.'),
  }),
  run: async (args: { url: string; max_length?: number }) => {
    const maxLen = args.max_length ?? 50000;

    // Validate URL safety
    let target: URL;
    try {
      target = safeUrl(args.url);
    } catch (e: any) {
      return `Error: ${e.message}`;
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    try {
      response = await fetch(target.href, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SkillPilotAgent/1.0' },
        redirect: 'follow',
      });
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        return `Error: Request to ${args.url} timed out after 15 seconds.`;
      }
      return `Error: Network error fetching ${args.url}: ${e.message}`;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText} for ${args.url}`;
    }

    const contentType = response.headers.get('content-type') ?? 'unknown';
    let body: string;
    try {
      body = await response.text();
    } catch (e: any) {
      return `Error: Failed to read response body from ${args.url}: ${e.message}`;
    }

    // Strip HTML tags if content looks like HTML
    let text: string;
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      text = body.replace(/<[^>]*>/g, '');
    } else {
      text = body;
    }

    // Trim whitespace
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    // Truncate to max_length
    const truncated = text.length > maxLen ? text.substring(0, maxLen) + '\n\n... [truncated]' : text;

    return [
      `URL: ${args.url}`,
      `Content-Type: ${contentType}`,
      `Content-Length: ${body.length} bytes`,
      '',
      truncated,
    ].join('\n');
  },
};

// ---------------------------------------------------------------------------
// webSearchTool
// ---------------------------------------------------------------------------

export const webSearchTool = {
  type: 'function' as const,
  name: 'web_search',
  description:
    'Search the web using DuckDuckGo (no API key needed). Returns titles, URLs, and snippets.',
  parameters: z.object({
    query: z.string().describe('The search query.'),
    max_results: z
      .number()
      .optional()
      .default(10)
      .describe('Maximum number of results to return. Default 10.'),
  }),
  run: async (args: { query: string; max_results?: number }) => {
    const maxResults = args.max_results ?? 10;

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    try {
      response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SkillPilotAgent/1.0' },
      });
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        return `Error: Search request timed out after 15 seconds.`;
      }
      return `Error: Network error during search: ${e.message}`;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return `Error: Search returned HTTP ${response.status} ${response.statusText}`;
    }

    let html: string;
    try {
      html = await response.text();
    } catch (e: any) {
      return `Error: Failed to read search response: ${e.message}`;
    }

    // Parse DuckDuckGo HTML results
    // Results have class "result__title" for the link/title and "result__snippet" for the snippet
    const results: string[] = [];

    // Split by result containers — each result has a result__title <a> and a result__snippet element
    const titleRegex = /<a[^>]*class="result__title"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\//gi;

    // We need to pair titles with snippets.  Let's do a simpler approach:
    // Find all result__body containers and extract title + snippet from each.
    const bodyRegex = /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result__body|$)/gi;

    let bodyMatch;
    while ((bodyMatch = bodyRegex.exec(html)) !== null && results.length < maxResults) {
      const chunk = bodyMatch[1];

      // Extract title link
      const titleMatch = /<a[^>]*class="result__title"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
      const snippetMatch = /<[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\//i.exec(chunk);

      if (titleMatch) {
        const rawUrl = titleMatch[1];
        const title = titleMatch[2].replace(/<[^>]*>/g, '').trim();
        const snippet = snippetMatch
          ? snippetMatch[1].replace(/<[^>]*>/g, '').trim()
          : 'No snippet available.';

        // Decode HTML entities in title and snippet
        const decode = (s: string) =>
          s
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'");

        results.push(
          `${results.length + 1}. ${decode(title)}\n   URL: ${decode(rawUrl)}\n   Snippet: ${decode(snippet)}`,
        );
      }
    }

    if (results.length === 0) {
      return `No results found for "${args.query}".`;
    }

    return results.join('\n\n');
  },
};
