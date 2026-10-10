export function useApi() {
  const base = useRuntimeConfig().public.apiBase as string
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    return body
  }
  return {
    base,
    get: <T>(path: string) => call<T>(path),
    post: <T>(path: string, body?: unknown) =>
      call<T>(path, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  }
}
