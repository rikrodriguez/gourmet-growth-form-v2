function normalizedApiBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const gourmetApiBaseUrl = normalizedApiBaseUrl(import.meta.env.VITE_GOURMET_API_BASE_URL);
