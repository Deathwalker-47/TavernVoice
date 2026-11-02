// fetch() with retries and readable errors, shared by every voice provider's client.

export class ApiError extends Error {
    constructor(message, status = 0, detail = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.detail = detail;
    }
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
});

/** The message in a provider's JSON error body, whichever shape it uses. */
export function errorMessage(detail, fallback = '') {
    const msg = detail?.error?.message ?? detail?.detail?.message ?? detail?.error ?? detail?.detail ?? detail?.message ?? fallback;
    return typeof msg === 'string' ? msg : JSON.stringify(msg);
}

/**
 * fetch() that retries network errors, 429 and 5xx with backoff, and turns any other
 * failure into an error saying which provider answered what.
 * @param {string} url
 * @param {RequestInit} init
 * @param {{label: string, retries?: number, ErrorClass?: typeof ApiError}} o
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init, { label, retries = 2, ErrorClass = ApiError }) {
    const { signal } = init;
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetch(url, init);
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            if (attempt < retries) {
                await sleep(400 * 2 ** attempt, signal);
                continue;
            }
            throw new ErrorClass(`Network error talking to ${label}: ${err?.message ?? err}`);
        }
        if (res.ok) return res;
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            await sleep(500 * 2 ** attempt, signal);
            continue;
        }
        let detail = null;
        try { detail = await res.json(); } catch { /* not JSON */ }
        throw new ErrorClass(`${label} ${res.status}: ${errorMessage(detail, res.statusText)}`, res.status, detail);
    }
}
