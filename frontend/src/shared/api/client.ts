type ApiRequestOptions = {
  token?: string | null;
  headers?: Record<string, string>;
};

type ApiErrorPayload = {
  detail?: string | Array<{ msg?: string }>;
};

const resolveApiUrl = (): string => {
  const explicitApiUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (explicitApiUrl && explicitApiUrl.trim().length > 0) {
    return explicitApiUrl;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000/api`;
  }

  return 'http://localhost:8000/api';
};

const API_URL = resolveApiUrl().replace(/\/+$/, '');

const getStoredToken = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem('auth_token');
};

const extractErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const typed = payload as ApiErrorPayload;
  const detail = typed.detail;
  if (!detail) {
    return null;
  }
  if (typeof detail === 'string') {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail[0]?.msg ?? null;
  }
  return null;
};

export class ApiClientError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
  }
}

const request = async <TResponse>(
  path: string,
  init: RequestInit,
  options?: ApiRequestOptions,
): Promise<TResponse> => {
  const resolvedPath = path.startsWith('/') ? path : `/${path}`;
  const targetUrl = `${API_URL}${resolvedPath}`;

  const token = options?.token ?? getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers ?? {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(targetUrl, {
    ...init,
    headers,
  });

  const rawText = await response.text();
  let data: unknown = null;
  if (rawText.length > 0) {
    try {
      data = JSON.parse(rawText) as unknown;
    } catch {
      data = rawText;
    }
  }

  if (!response.ok) {
    const detail = extractErrorMessage(data) || `API error (${response.status})`;
    throw new ApiClientError(detail, response.status);
  }

  return data as TResponse;
};

export const apiClient = {
  get: <TResponse>(path: string, options?: ApiRequestOptions) =>
    request<TResponse>(path, { method: 'GET' }, options),
  post: <TResponse>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<TResponse>(path, { method: 'POST', body: JSON.stringify(body) }, options),
  patch: <TResponse>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<TResponse>(path, { method: 'PATCH', body: JSON.stringify(body) }, options),
};
