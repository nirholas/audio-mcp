// Centralized env + HTTP base for the audio MCP.
//
// This server is a thin wrapper over the three.ws audio/animation pipeline:
//   • /api/tts/speak  — text-to-speech (free NVIDIA Magpie, OpenAI backstop)
//   • /api/asr        — speech-to-text (free NVIDIA Riva)
//   • /api/a2f        — audio-to-face lipsync (free NVIDIA Audio2Face-3D)
//   • /api/mocap/*    — the stored motion-capture clip library (face/pose/hand)
//
// It signs nothing on-chain. The endpoints are metered: anonymous callers get a
// tight per-IP budget, authenticated callers a higher per-user one — and the
// mocap clip library only returns your private clips when you authenticate. So
// the one optional secret is a three.ws API key (bearer token); without it the
// server still works against everything public, exactly like intel-mcp.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Base URL of the three.ws API. Override only when self-hosting or pointing at a
// preview deployment.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// Optional three.ws API key (bearer token). When set it is sent as
// `Authorization: Bearer <key>` on every call, which raises the metered TTS/ASR/
// A2F rate limits and unlocks your own private/unlisted mocap clips. Leave it
// unset to use the public surface anonymously.
export const THREE_WS_API_KEY = env('THREE_WS_API_KEY');

// Per-request timeout (ms). Audio synthesis, recognition, and Audio2Face are
// real upstream model calls (gRPC to NVIDIA NIM, OpenAI on the backstop) — a
// long line of TTS or a 4-minute ASR clip needs headroom, so this is generous.
export const HTTP_TIMEOUT_MS = (() => {
	const raw = env('THREE_WS_TIMEOUT_MS');
	if (raw === undefined) return 60000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`THREE_WS_TIMEOUT_MS must be a positive number (got "${raw}")`), {
			code: 'bad_config',
		});
	}
	return n;
})();

// Identifies this client to the API in request logs.
export const USER_AGENT = '@three-ws/audio-mcp';
