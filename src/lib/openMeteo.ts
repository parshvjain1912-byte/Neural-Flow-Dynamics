/**
 * Shared request layer for Open-Meteo.
 *
 * - Caches successful JSON responses (per URL, with a TTL).
 * - Deduplicates identical in-flight requests (one network call, many callers).
 * - Lets each caller cancel its own wait without killing the shared request.
 * - Enforces a global cool-down after an HTTP 429 (no blind retries).
 */

export class RateLimitError extends Error {
    retryAt: number;

    constructor(retryAt: number) {
        super("Weather provider rate limit reached.");
        this.name = "RateLimitError";
        this.retryAt = retryAt;
    }
}

export class HttpError extends Error {
    status: number;

    constructor(status: number) {
        super(`Weather provider returned HTTP ${status}.`);
        this.name = "HttpError";
        this.status = status;
    }
}

type CacheEntry = {
    expires: number;
    data: unknown;
};

const MAX_CACHE_ENTRIES = 60;
const REQUEST_TIMEOUT_MS = 15_000;
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

let blockedUntil = 0;
let strikes = 0;

/** Timestamp (ms) until which the provider must not be called, or 0. */
export function getRateLimitedUntil(): number {
    return blockedUntil > Date.now() ? blockedUntil : 0;
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}

function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;

    const seconds = Number(header);

    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }

    const date = Date.parse(header);

    return Number.isFinite(date)
        ? Math.max(0, date - Date.now())
        : null;
}

function remember(key: string, data: unknown, ttlMs: number) {
    cache.delete(key);
    cache.set(key, {
        expires: Date.now() + ttlMs,
        data
    });

    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;

        if (oldest === undefined) break;

        cache.delete(oldest);
    }
}

async function networkFetch(
    url: string,
    ttlMs: number
): Promise<unknown> {
    const now = Date.now();

    if (blockedUntil > now) {
        throw new RateLimitError(blockedUntil);
    }

    const controller = new AbortController();

    const timer = window.setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
    );

    try {
        const response = await fetch(url, {
            signal: controller.signal
        });

        if (response.status === 429) {
            const wait = parseRetryAfter(response.headers.get("Retry-After"))
                ?? Math.min(
                    BASE_COOLDOWN_MS * 2 ** strikes,
                    MAX_COOLDOWN_MS
                );

            strikes = Math.min(strikes + 1, 10);

            blockedUntil = Date.now() + Math.min(wait, MAX_COOLDOWN_MS);

            throw new RateLimitError(blockedUntil);
        }

        if (!response.ok) {
            throw new HttpError(response.status);
        }

        const data: unknown = await response.json();

        strikes = 0;

        remember(url, data, ttlMs);

        return data;
    } catch (error) {
        // The only abort on this controller is our own timeout.
        if (isAbortError(error)) {
            throw new Error("Weather provider timed out.", {
                cause: error
            });
        }

        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

/**
 * Rejects with an AbortError as soon as `signal` aborts.
 * The shared request itself keeps running for other callers.
 */
function waitWithSignal<T>(
    promise: Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    if (!signal) return promise;

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(new DOMException("Aborted", "AbortError"));
        };

        if (signal.aborted) {
            return onAbort();
        }

        signal.addEventListener("abort", onAbort, {
            once: true
        });

        promise.then(
            value => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
}

export type FetchOptions = {
    /** How long a successful response stays fresh. */
    ttlMs: number;

    /** Cancels this caller's wait, not the shared request. */
    signal?: AbortSignal;

    /** Skip the cache; the rate-limit cooldown still applies. */
    force?: boolean;
};

export function fetchJsonCached<T>(
    url: string,
    options: FetchOptions
): Promise<T> {
    const {
        ttlMs,
        signal,
        force = false
    } = options;

    if (!force) {
        const hit = cache.get(url);

        if (hit && hit.expires > Date.now()) {
            return Promise.resolve(hit.data as T);
        }
    }

    let shared = inflight.get(url);

    if (!shared) {
        shared = networkFetch(url, ttlMs)
            .finally(() => inflight.delete(url));

        inflight.set(url, shared);
    }

    return waitWithSignal(shared as Promise<T>, signal);
}

export { isAbortError };