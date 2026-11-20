// JSON API client. Adds the CSRF header to state-changing requests and
// signals when the session has ended.
let csrfToken = null;

export function setCsrf(token) {
    csrfToken = token;
}

export class ApiError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

export async function api(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
    });
    let data = null;
    const text = await res.text();
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { error: text };
        }
    }
    if (!res.ok) {
        if (res.status === 401 && path !== '/api/auth/login') {
            window.dispatchEvent(new CustomEvent('auth-required'));
        }
        throw new ApiError(res.status, data?.error || res.statusText, data?.details);
    }
    return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);
