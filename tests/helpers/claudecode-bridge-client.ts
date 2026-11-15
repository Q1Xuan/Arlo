/** Bootstrap a current attachment for contract tests unrelated to stale traffic. */
export async function fetchCurrentBridge(url: string, init: RequestInit = {}): Promise<Response> {
  if (url.endsWith('/status')) return fetch(url, init);
  const headers = new Headers(init.headers);
  if (!headers.has('x-bridge-instance')) {
    const status = await fetch(new URL('/api/v1/bridge/status', url), { headers });
    if (!status.ok) return status;
    const identity = await status.json() as { instanceId: string; generation: number };
    headers.set('x-bridge-instance', identity.instanceId);
    headers.set('x-bridge-generation', String(identity.generation));
  }
  return fetch(url, { ...init, headers });
}
