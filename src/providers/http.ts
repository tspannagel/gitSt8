import { AuthError } from './types';

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

/** JSON request with consistent auth, timeout and error handling. */
export async function requestJson<T>(url: string, auth: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method || 'GET',
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'User-Agent': 'gitSt8-vscode',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new Error(`${new URL(url).host} did not answer within ${TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  const type = res.headers.get('content-type') || '';
  if (res.status === 401 || res.status === 403) {
    // GitHub uses 403 for rate limits too; that is not a credentials problem.
    if (res.headers.get('x-ratelimit-remaining') === '0') throw new HttpError('API rate limit reached. Try again later.', 429);
    if (res.status === 401) throw new AuthError('Credentials rejected (401): sign in again or replace the expired/invalid token.');
    throw new HttpError('Insufficient permissions (403): check repository access, token scopes and organization SSO authorization.', 403);
  }
  // Azure DevOps answers an invalid token with 203 and an HTML sign-in page.
  if (res.status === 203 || (res.ok && !type.includes('json'))) {
    throw new AuthError('Not authorized: the service returned a sign-in page instead of data.');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(`${res.status} ${res.statusText}: ${shorten(detail)}`, res.status);
  }
  return (await res.json()) as T;
}

function shorten(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine;
}
