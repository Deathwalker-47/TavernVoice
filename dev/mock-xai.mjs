// Local stand-in for api.x.ai so the full call loop can be tested without an xAI key.
//
//   node dev/mock-xai.mjs            (listens on http://localhost:8787)
//
// In TavernVoice settings set "API base URL" to http://localhost:8787/v1 and any API key.
// It also serves an OpenAI-compatible streaming chat endpoint, so SillyTavern can use
// Chat Completion -> Custom (OpenAI-compatible) -> http://localhost:8787/v1 as the "LLM".

import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);

const GREETING = '*picks up on the second ring* Oh! Hey, you actually called. [laugh] I was literally just thinking about you.';
const REPLIES = [
    'Wait, really? [chuckle] Okay, tell me everything. Don\'t leave out the good parts.',
    '*sighs* Honestly? It\'s been a long day. <whisper>But hearing your voice helps.</whisper> What about you?',
    'Hmm... [pause] I don\'t know, that sounds a little risky. But I\'m kind of into it. When do we start?',
    'No way. [laugh] You\'re making that up! Okay, okay, I believe you. Mostly.',
];
const STT_LINES = ['Hey, can you hear me okay?', 'I had the weirdest day today.', 'Tell me something nice.', 'Okay, I should probably go soon.'];
let replyIdx = 0;
let sttIdx = 0;
let tokenDelayMs = 25; // POST /mock/config {"tokenDelayMs": 150} to simulate a slow LLM

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
}

function readBody(req) {
    return new Promise((resolve) => {
        const parts = [];
        req.on('data', (c) => parts.push(c));
        req.on('end', () => resolve(Buffer.concat(parts)));
    });
}

/** A hummed "voice": a few harmonics with a syllable-rate envelope. Length tracks the text. */
function fakeSpeechWav(text) {
    const rate = 24000;
    const seconds = Math.min(8, Math.max(0.6, text.length * 0.055));
    const n = Math.floor(rate * seconds);
    const pcm = new Int16Array(n);
    const f0 = 150 + (text.length % 7) * 12;
    for (let i = 0; i < n; i++) {
        const t = i / rate;
        const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.2 * t);
        const fade = Math.min(1, t * 20, (seconds - t) * 20);
        const pitch = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t));
        const s = Math.sin(2 * Math.PI * pitch * t) * 0.6 + Math.sin(4 * Math.PI * pitch * t) * 0.25 + Math.sin(6 * Math.PI * pitch * t) * 0.1;
        pcm[i] = s * syllable * fade * 0.25 * 32767;
    }
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    Buffer.from(pcm.buffer).copy(buf, 44);
    return buf;
}

async function streamChat(res, content, model) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const id = `chatcmpl-mock-${Date.now()}`;
    for (let i = 0; i < content.length; i += 3) {
        const delta = { content: content.slice(i, i + 3) };
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        await new Promise(r => setTimeout(r, tokenDelayMs));
        if (res.destroyed) return; // client aborted (e.g. barge-in stopped the generation)
    }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const body = await readBody(req);
    const auth = req.headers.authorization ? 'auth ok' : 'NO AUTH';
    const stamp = new Date().toISOString().slice(11, 19);

    if (url.pathname === '/mock/config' && req.method === 'POST') {
        const cfg = JSON.parse(body.toString() || '{}');
        if (cfg.tokenDelayMs !== undefined) tokenDelayMs = Number(cfg.tokenDelayMs);
        console.log(`[${stamp}] mock config: tokenDelayMs=${tokenDelayMs}`);
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tokenDelayMs }));
    }
    if (url.pathname === '/v1/tts/voices') {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            voices: ['eve', 'ara', 'rex', 'sal', 'leo', 'sirius'].map(v => ({ voice_id: v, name: v[0].toUpperCase() + v.slice(1), language: null })),
        }));
    }
    if (url.pathname === '/v1/custom-voices') {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ voices: [{ voice_id: 'mock1234', name: 'Mock Clone' }] }));
    }
    if (url.pathname === '/v1/tts' && req.method === 'POST') {
        const json = JSON.parse(body.toString() || '{}');
        console.log(`[${stamp}] TTS (${auth}) voice=${json.voice_id} lang=${json.language} speed=${json.speed ?? 1}: ${json.text}`);
        return res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(fakeSpeechWav(json.text ?? ''));
    }
    if (url.pathname === '/v1/stt' && req.method === 'POST') {
        const text = STT_LINES[sttIdx++ % STT_LINES.length];
        console.log(`[${stamp}] STT (${auth}) ${body.length} bytes, wav=${body.includes(Buffer.from('RIFF'))} -> "${text}"`);
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text, language: 'en', duration: 1.2, words: [] }));
    }
    if (url.pathname === '/v1/realtime/client_secrets') {
        console.log(`[${stamp}] client_secrets requested -> 404 (mock forces batch fallback)`);
        return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not in mock' }));
    }
    if (url.pathname === '/v1/models') {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'mock-roleplay', object: 'model' }] }));
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const json = JSON.parse(body.toString() || '{}');
        const all = (json.messages ?? []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
        const inCall = all.includes('[Live voice call]');
        const greeting = all.includes('[The call just connected');
        const content = greeting ? GREETING : REPLIES[replyIdx++ % REPLIES.length];
        const last = json.messages?.at(-1);
        console.log(`[${stamp}] LLM stream=${!!json.stream} callPrompt=${inCall} greeting=${greeting} last=${last?.role}: ${String(last?.content).slice(0, 80).replace(/\n/g, ' ')}`);
        if (json.stream) return streamChat(res, content, json.model);
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', model: json.model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }));
    }
    console.log(`[${stamp}] 404 ${req.method} ${url.pathname}`);
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.log(`Mock xAI + LLM listening on http://localhost:${PORT}/v1`));
