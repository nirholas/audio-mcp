#!/usr/bin/env node
// @three-ws/audio-mcp — MCP server entry point.
//
// The voice and animation layer for three.ws 3D agents over stdio:
//   • text_to_speech       — synthesize speech from text (free Magpie, OpenAI backstop)
//   • speech_to_text       — transcribe spoken audio (free NVIDIA Riva)
//   • audio_to_face        — turn speech into an ARKit blendshape lipsync track (Audio2Face-3D)
//   • motion_capture_clips — browse the stored motion-capture clip library
//   • motion_capture_clip  — fetch one clip's full per-frame animation track
//
// A thin wrapper over the three.ws API. No on-chain signer. The TTS/ASR/A2F
// lanes are free and metered; an optional THREE_WS_API_KEY raises the rate
// limits and unlocks your own private mocap clips — without it the whole public
// surface still works. Point THREE_WS_BASE at a deployment and go.
//
// Run standalone:
//   node packages/audio-mcp/src/index.js
//
// Or wire into Claude Code / Cursor — see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as textToSpeech } from './tools/text-to-speech.js';
import { def as speechToText } from './tools/speech-to-text.js';
import { def as audioToFace } from './tools/audio-to-face.js';
import { def as motionCaptureClips } from './tools/motion-capture-clips.js';
import { def as motionCaptureClip } from './tools/motion-capture-clip.js';

// Single source of truth for the advertised server version — package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [
	textToSpeech,
	speechToText,
	audioToFace,
	motionCaptureClips,
	motionCaptureClip,
];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'audio-mcp', title: 'three.ws Audio', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Audio MCP — give a 3D agent a voice and a face. text_to_speech synthesizes spoken audio from text ' +
				'(free NVIDIA Magpie, OpenAI backstop) and returns it as a base64 data URL. speech_to_text transcribes spoken ' +
				'audio to text with the free NVIDIA Riva recognizer. audio_to_face turns speech — text you pass, or audio you ' +
				'already have — into a per-frame ARKit blendshape lipsync track via Audio2Face-3D, so the avatar\'s mouth matches ' +
				'the words. motion_capture_clips browses the stored motion-capture library (face/pose/hand/VMC) and ' +
				'motion_capture_clip fetches one clip\'s full per-frame track to play back on an avatar. The synthesis/recognition ' +
				'lanes are free and metered; set THREE_WS_API_KEY for higher limits and access to your own private mocap clips. ' +
				'Every tool is read-only — they transform input or read live data, never mutating platform state.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
			},
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
					return { content: [{ type: 'text', text }] };
				} catch (err) {
					const payload = {
						ok: false,
						error: err?.code || 'unhandled',
						message: err?.message || String(err),
						...(err?.status ? { status: err.status } : {}),
					};
					return {
						content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}

async function main() {
	const server = buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[audio-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
}

// Connect stdio ONLY when this file is the process entry point. Importing the
// module (tests, embedding) must not grab the transport. realpath both sides:
// npm bin shims are symlinks, so argv[1] may differ from import.meta.url.
function isProcessEntryPoint() {
	if (!process.argv[1]) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isProcessEntryPoint()) {
	main().catch((err) => {
		console.error('[audio-mcp] fatal:', err);
		process.exit(1);
	});
}
