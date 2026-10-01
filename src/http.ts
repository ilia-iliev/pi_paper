export function httpGet(url: string | URL): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "pi-paper/0.1" },
  });
}
