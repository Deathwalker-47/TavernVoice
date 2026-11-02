// Browser client for the xAI Grok voice APIs (TTS, STT, streaming STT).
// api.x.ai answers CORS preflights with "*", so these calls go straight from the browser.

import { DEFAULT_API_BASE, STT_MODEL, LANGUAGES, STT_LANGUAGES } from './constants.js';
import { ApiError, fetchWithRetry } from './http.js';

export class XaiError extends ApiError {
    constructor(message, status = 0, detail = null) {
        super(message, status, detail);
        this.name = 'XaiError';
    }
}

/** "pt-BR" -> "pt": STT wants a plain language code, and one it knows. Anything else is auto-detected. */
const sttLanguage = (lang) => {
    const base = (!lang || lang === 'auto') ? '' : String(lang).split('-')[0].toLowerCase();
    return STT_LANGUAGES.has(base) ? base : '';
};

/** Grok voices speak the languages in LANGUAGES. Others (Malayalam, Tamil, ...) fall back to auto. */
const XAI_TTS_LANGUAGES = new Set(LANGUAGES.map(([code]) => code));

export class XaiClient {
    /**
     * @param {() => Promise<{key: string, base?: string}>} getConfig Resolves the API key and base URL per request
     */
    constructor(getConfig) {
        this.getConfig = getConfig;
    }

    async #config() {
        const { key, base } = await this.getConfig();
        if (!key) throw new XaiError('No xAI API key. Add one in Extensions → TavernVoice.', 401);
        return { key, base: (base || DEFAULT_API_BASE).replace(/\/+$/, '') };
    }

    /**
     * fetch() with auth, error decoding, and retry with backoff on 429/5xx.
     * @returns {Promise<Response>}
     */
    async request(path, { method = 'POST', json, form, signal, retries = 2 } = {}) {
        const { key, base } = await this.#config();
        const headers = { Authorization: `Bearer ${key}` };
        let body;
        if (json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(json);
        } else if (form) {
            body = form;
        }
        return fetchWithRetry(`${base}${path}`, { method, headers, body, signal }, { label: 'xAI', retries, ErrorClass: XaiError });
    }

    /**
     * Text to speech. Returns MP3 bytes (browsers can't decode raw PCM from decodeAudioData).
     * @returns {Promise<ArrayBuffer>}
     */
    async tts({ text, voice = 'eve', language = 'auto', speed = 1, signal }) {
        const json = {
            text,
            voice_id: voice || 'eve',
            language: XAI_TTS_LANGUAGES.has(language) ? language : 'auto',
            output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
        };
        const s = Number(speed);
        if (s && s !== 1) json.speed = Math.max(0.7, Math.min(1.5, s));
        try {
            const res = await this.request('/tts', { json, signal });
            return await res.arrayBuffer();
        } catch (err) {
            // Custom voices are scoped to the xAI team that created them.
            if (err?.status === 404 && /voice/i.test(err.message)) {
                throw new XaiError(`${err.message}. Custom voice IDs only work with an API key from the xAI team that created the voice.`, 404, err.detail);
            }
            throw err;
        }
    }

    /**
     * Batch speech to text.
     * @param {object} o
     * @param {ArrayBuffer|Blob} o.audio WAV (or any container format xAI accepts)
     * @returns {Promise<{text: string, language?: string, duration?: number}>}
     */
    async stt({ audio, language, keyterms = [], signal }) {
        const form = new FormData();
        form.append('model', STT_MODEL);
        const lang = sttLanguage(language);
        if (lang) {
            form.append('language', lang);
            form.append('format', 'true');
        }
        for (const term of keyterms.filter(Boolean).slice(0, 100)) form.append('keyterm', String(term).slice(0, 50));
        // xAI requires `file` to be the LAST multipart field.
        const blob = audio instanceof Blob ? audio : new Blob([audio], { type: 'audio/wav' });
        form.append('file', blob, 'speech.wav');
        const res = await this.request('/stt', { form, signal });
        return await res.json();
    }

    /** Built-in voices plus the team's custom voices (flagged `custom`). */
    async voices() {
        const res = await this.request('/tts/voices', { method: 'GET', retries: 0 });
        const data = await res.json();
        const list = (data?.voices ?? []).map(v => ({ voice_id: v.voice_id, name: v.name || v.voice_id, gender: v.gender, language: v.language }));
        try {
            const custom = await (await this.request('/custom-voices?limit=200', { method: 'GET', retries: 0 })).json();
            for (const v of custom?.voices ?? []) {
                if (list.some(x => x.voice_id === v.voice_id)) continue;
                list.push({
                    voice_id: v.voice_id,
                    name: v.name || v.voice_id,
                    description: [v.description, v.gender, v.accent, v.tone].filter(Boolean).join(', '),
                    gender: v.gender,
                    language: v.language,
                    custom: true,
                });
            }
        } catch { /* custom voices are optional (and US-only at xAI) */ }
        return list;
    }

    /** Short-lived token for browser WebSocket auth. */
    async clientSecret(seconds = 600) {
        const res = await this.request('/realtime/client_secrets', { json: { expires_after: { seconds } }, retries: 0 });
        const data = await res.json();
        if (!data?.value) throw new XaiError('xAI did not return a client secret');
        return data.value;
    }

    async wsBase() {
        const { base } = await this.#config();
        return base.replace(/^http/, 'ws');
    }

    async apiKey() {
        return (await this.#config()).key;
    }
}

/**
 * Turns streaming `transcript.partial` events into live captions and finished utterances.
 * is_final=false: interim text; is_final=true: a locked ~3 s chunk; speech_final=true: turn over.
 */
export class UtteranceAssembler {
    constructor() {
        this.committed = [];
    }

    /** @returns {{interim: string, utterance?: string}} */
    push({ text = '', is_final: isFinal = false, speech_final: speechFinal = false }) {
        const clean = String(text).trim();
        const joined = this.committed.join(' ');
        if (speechFinal) {
            // Utterance-final events carry the stitched utterance. Guard against a server that
            // only sends the last chunk by prepending committed chunks it doesn't contain.
            let full = clean;
            if (joined && !clean.toLowerCase().includes(this.committed[0].toLowerCase().slice(0, 20))) {
                full = `${joined} ${clean}`.trim();
            }
            this.committed = [];
            return { interim: '', utterance: full || undefined };
        }
        if (isFinal) {
            if (clean) this.committed.push(clean);
            return { interim: this.committed.join(' ') };
        }
        const display = joined && !clean.startsWith(joined) ? `${joined} ${clean}` : clean;
        return { interim: display.trim() };
    }
}

/**
 * Streaming STT over wss://api.x.ai/v1/stt.
 * Browsers can't set an Authorization header on WebSockets, so credentials travel in the
 * Sec-WebSocket-Protocol header as `xai-client-secret.<token>` (documented for the realtime API).
 *
 * Emits (via callbacks):
 *  onInterim(text)  live caption of the current utterance
 *  onUtterance(text) the speaker finished a turn
 *  onError(err), onClose()
 */
export class SttStream {
    static workingAuth = null; // 'secret' | 'key', remembered after the first success

    constructor(client, { language, smartTurn = true, endpointing = 600, keyterms = [], onInterim, onUtterance, onError, onClose } = {}) {
        this.client = client;
        this.opts = { language, smartTurn, endpointing, keyterms };
        this.onInterim = onInterim ?? (() => {});
        this.onUtterance = onUtterance ?? (() => {});
        this.onError = onError ?? (() => {});
        this.onClose = onClose ?? (() => {});
        this.ws = null;
        this.assembler = new UtteranceAssembler();
        this.ready = false;
        this.closedByUs = false;
    }

    async #url() {
        const p = new URLSearchParams({
            model: STT_MODEL,
            sample_rate: '16000',
            encoding: 'pcm',
            interim_results: 'true',
            endpointing: String(this.opts.endpointing),
        });
        const lang = sttLanguage(this.opts.language);
        if (lang) {
            p.set('language', lang);
            p.set('format', 'true');
        }
        if (this.opts.smartTurn) {
            p.set('smart_turn', '0.6');
            p.set('smart_turn_timeout', '2500');
        }
        for (const term of this.opts.keyterms.filter(Boolean).slice(0, 100)) p.append('keyterm', String(term).slice(0, 50));
        return `${await this.client.wsBase()}/stt?${p}`;
    }

    #openWith(url, token, timeoutMs) {
        return new Promise((resolve, reject) => {
            let ws;
            try {
                ws = new WebSocket(url, [`xai-client-secret.${token}`]);
            } catch (err) {
                reject(err);
                return;
            }
            ws.binaryType = 'arraybuffer';
            const timer = setTimeout(() => {
                ws.close();
                reject(new XaiError('Streaming STT timed out while connecting'));
            }, timeoutMs);
            ws.onmessage = (e) => {
                let msg;
                try { msg = JSON.parse(e.data); } catch { return; }
                if (msg.type === 'transcript.created') {
                    clearTimeout(timer);
                    resolve(ws);
                } else if (msg.type === 'error') {
                    clearTimeout(timer);
                    ws.close();
                    reject(new XaiError(msg.message || 'Streaming STT error'));
                }
            };
            ws.onerror = () => {
                clearTimeout(timer);
                reject(new XaiError('Streaming STT connection refused'));
            };
            ws.onclose = () => {
                clearTimeout(timer);
                reject(new XaiError('Streaming STT connection closed'));
            };
        });
    }

    /** Connects, trying an ephemeral client secret first and the API key second. */
    async connect(timeoutMs = 7000) {
        const url = await this.#url();
        const order = SttStream.workingAuth === 'key' ? ['key', 'secret'] : ['secret', 'key'];
        let lastErr;
        for (const mode of order) {
            try {
                const token = mode === 'secret' ? await this.client.clientSecret(3600) : await this.client.apiKey();
                const ws = await this.#openWith(url, token, timeoutMs);
                SttStream.workingAuth = mode;
                this.#attach(ws);
                return;
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr ?? new XaiError('Streaming STT unavailable');
    }

    #attach(ws) {
        this.ws = ws;
        this.ready = true;
        ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (msg.type === 'transcript.partial') {
                const { interim, utterance } = this.assembler.push(msg);
                if (utterance) this.onUtterance(utterance);
                this.onInterim(interim);
            } else if (msg.type === 'error') {
                this.onError(new XaiError(msg.message || 'Streaming STT error'));
            }
        };
        ws.onerror = () => this.onError(new XaiError('Streaming STT connection error'));
        ws.onclose = () => {
            this.ready = false;
            if (!this.closedByUs) this.onClose();
        };
    }

    /** @param {Int16Array} pcm16 16 kHz mono */
    send(pcm16) {
        if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(pcm16.buffer.byteLength === pcm16.byteLength ? pcm16.buffer : pcm16.slice().buffer);
        }
    }

    /** Push-to-talk release: force the current utterance to finish now. */
    finalize() {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'finalize' }));
    }

    close() {
        this.closedByUs = true;
        this.ready = false;
        try {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'audio.done' }));
            this.ws?.close(1000);
        } catch { /* already closed */ }
        this.ws = null;
    }
}
