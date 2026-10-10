// Real HTTP access to the three.ws audio/animation API. No mocks, no fixtures —
// every call is a live request to THREE_WS_BASE. Errors are normalized into a
// single shape so tool handlers can surface a clean message + status to the MCP
// client.
//
// Two transports because the pipeline has two response shapes:
//   • apiRequest()       — JSON in / JSON out (ASR, A2F, mocap clips).
//   • apiRequestBinary() — JSON in / raw audio bytes out (TTS speech synthesis,
//     which streams the encoded clip with a truthful content-type, not JSON).
// Both share the same base URL, timeout, user-agent, optional bearer auth, and
// error normalization — one HTTP client, two read modes.

import { THREE_WS_BASE, HTTP_TIMEOUT_MS, USER_AGENT, THREE_WS_API_KEY } from '../config.js';

function buildUrl(path, query) {
	const url = new URL(`${THREE_WS_BASE}${path}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null || value === '') continue;
			url.searchParams.set(key, String(value));
		}
	}
	return url;
}

function baseHeaders(extra) {
	return {
		'user-agent': USER_AGENT,
		...(THREE_WS_API_KEY ? { authorization: `Bearer ${THREE_WS_API_KEY}` } : {}),
		...extra,
	};
}

// Map a fetch-layer failure (abort/network) onto the normalized error shape.
function transportError(err, path) {
	if (err?.name === 'AbortError') {
		return Object.assign(new Error(`three.ws ${path} timed out after ${HTTP_TIMEOUT_MS}ms`), {
			code: 'timeout',
		});
	}
	return Object.assign(new Error(`three.ws ${path} request failed: ${err?.message || err}`), {
		code: 'network_error',
	});
}

/**
 * Call a three.ws JSON endpoint and return its parsed JSON body.
 *
 * @param {string} path  Endpoint path beginning with `/` (e.g. `/api/asr`).
 * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown }} [opts]
 * @returns {Promise<any>} Parsed JSON response.
 * @throws {Error} with `.code` ('timeout' | 'network_error' | 'upstream_error'),
 *   and on upstream errors `.status` + `.body`.
 */
export async function apiRequest(path, { method = 'GET', query, body } = {}) {
	const url = buildUrl(path, query);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(url, {
			method,
			headers: baseHeaders({
				accept: 'application/json',
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			}),
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		throw transportError(err, path);
	}
	clearTimeout(timer);

	const text = await res.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}

	if (!res.ok) {
		throw upstreamError(path, res.status, data);
	}
	return data;
}

// The three.ws API's standard error body is { error: <code>, error_description:
// <message> } (api/_lib/http.js). Prefer the human-readable description, fall
// back to the code, then to a generic HTTP line — so the MCP client always gets
// an actionable message, never a bare code or a numeric gRPC status.
function upstreamError(path, status, data) {
	const message =
		data?.error_description ||
		data?.message ||
		(typeof data?.error === 'string' ? data.error : null) ||
		`three.ws ${path} returned HTTP ${status}`;
	const code = typeof data?.error === 'string' ? data.error : 'upstream_error';
	return Object.assign(new Error(message), { code, status, body: data });
}

/**
 * Call a three.ws endpoint that returns raw bytes (audio) and return the buffer
 * plus the response metadata. On an error status the body is JSON — it is parsed
 * and surfaced through the same normalized error shape as apiRequest().
 *
 * @param {string} path  Endpoint path beginning with `/` (e.g. `/api/tts/speak`).
 * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown }} [opts]
 * @returns {Promise<{ buffer: Buffer, contentType: string, headers: Headers }>}
 * @throws {Error} with `.code` ('timeout' | 'network_error' | 'upstream_error').
 */
export async function apiRequestBinary(path, { method = 'POST', query, body } = {}) {
	const url = buildUrl(path, query);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(url, {
			method,
			headers: baseHeaders({
				accept: 'application/octet-stream, audio/*, application/json',
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			}),
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		throw transportError(err, path);
	}
	clearTimeout(timer);

	if (!res.ok) {
		// Error responses from the API are JSON ({ error, message }); parse for a
		// clean message rather than leaking raw bytes into the MCP client.
		let data;
		try {
			data = JSON.parse(await res.text());
		} catch {
			data = {};
		}
		throw upstreamError(path, res.status, data);
	}

	const buffer = Buffer.from(await res.arrayBuffer());
	return {
		buffer,
		contentType: res.headers.get('content-type') || 'application/octet-stream',
		headers: res.headers,
	};
}
