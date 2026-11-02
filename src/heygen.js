// Browser client for HeyGen text to speech (v3 voices API).
// api.heygen.com and its audio hosts (files.heygen.ai, resource2.heygen.ai) allow browser origins (CORS).

import { DEFAULT_HEYGEN_BASE } from './constants.js';
import { ApiError, fetchWithRetry } from './http.js';

/**
 * What HeyGen Voice (Orca) can speak, from its API errors (Nov 2026). Every public voice uses
 * Orca, so a public voice can't speak anything else, Malayalam included.
 */
const ORCA_LANGUAGES = 'ar be bg ca cs da de el en es fa fi fr he hi hr hu id it ja ko mk ms nl pl pt ro ru sk sl sr sv ta th tl tr uk vi zh'.split(' ');

function languageName(code) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

const ORCA_NAMES = new Set(ORCA_LANGUAGES.map(c => languageName(c).toLowerCase()));

/**
 * The engine to ask for with one of your own voices. None means its saved engine, which the API
 * uses when it can. A saved engine the API lacks (Cartesia, Fish) or none at all falls back to
 * ElevenLabs, the only one here that speaks Malayalam, then HeyGen Voice.
 */
function ownEngine(v) {
    const allowed = v.available_engines ?? [];
    if (v.default_engine && allowed.includes(v.default_engine)) return '';
    return ['elevenlabs', 'orca', 'starfish'].find(e => allowed.includes(e)) || '';
}

export class HeyGenClient {
    /**
     * @param {() => Promise<{key: string, base?: string}>} getConfig Resolved per request
     */
    constructor(getConfig) {
        this.getConfig = getConfig;
        /** @type {Map<string, string>} your voices' engine, filled when voices are listed */
        this.engines = new Map();
    }

    async #config() {
        const { key, base } = await this.getConfig();
        if (!key) throw new ApiError('No HeyGen API key. Add one in Extensions → TavernVoice.', 401);
        return { key, base: (base || DEFAULT_HEYGEN_BASE).replace(/\/+$/, '') };
    }

    /**
     * Text to speech. HeyGen answers with a link to an MP3, which is fetched next.
     * The voice's own default engine is used (HeyGen Voice for most catalog voices, else Starfish).
     * @returns {Promise<ArrayBuffer>}
     */
    async tts({ text, voice, language = 'auto', speed = 1, signal }) {
        const { key, base } = await this.#config();
        const json = { text, voice_id: voice };
        this.ownListed ??= this.voices([]).catch(() => []);     // your voices' engines, if not listed yet
        await this.ownListed;
        const engine = this.engines.get(voice);
        if (engine) json.engine = engine;
        const lang = !language || language === 'auto' ? '' : String(language).split('-')[0].toLowerCase();
        if (lang) json.language = lang;
        const s = Number(speed);
        if (s && s !== 1) json.speed = Math.max(0.5, Math.min(2, s));
        const res = await fetchWithRetry(`${base}/v3/voices/speech`, {
            method: 'POST',
            headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify(json),
            signal,
        }, { label: 'HeyGen' });
        const url = (await res.json())?.data?.audio_url;
        if (!url) throw new ApiError('HeyGen did not return any audio');
        const audio = await fetchWithRetry(url, { method: 'GET', signal }, { label: 'HeyGen audio' });
        return await audio.arrayBuffer();
    }

    /**
     * Your own voices (clones and designs), then HeyGen's public voices in the given languages
     * ("Malayalam", "English"). The public library has thousands of voices and its language filter
     * only sorts them, so a public voice is kept only when it was made for that language, or is a
     * multilingual one and Orca speaks the language.
     * @param {string[]} languages
     */
    async voices(languages = []) {
        const { key, base } = await this.#config();
        const list = async (params, keep) => {
            const found = [];
            let token = '';
            for (let page = 0; page < 5; page++) {
                const q = new URLSearchParams({ ...params, limit: '100' });
                if (token) q.set('token', token);
                const res = await fetchWithRetry(`${base}/v3/voices?${q}`, { method: 'GET', headers: { 'X-Api-Key': key } }, { label: 'HeyGen', retries: 0 });
                const data = await res.json();
                found.push(...(data?.data ?? []).filter(v => v.voice_id && (v.available_engines ?? ['any']).length && keep(v)));
                token = data?.next_token;
                if (!data?.has_more || !token) break;
            }
            return found;
        };
        const out = [];
        const seen = new Set();
        const add = (v, extra) => {
            if (seen.has(v.voice_id)) return;
            seen.add(v.voice_id);
            out.push({ voice_id: v.voice_id, name: v.name || v.voice_id, gender: v.gender, language: v.language || '', ...extra });
        };
        // Your own voices are few. A failure here still leaves the public ones.
        const own = await list({ type: 'private' }, () => true).catch(() => []);
        const engines = new Map();
        for (const v of own) {
            const engine = ownEngine(v);
            if (engine) engines.set(v.voice_id, engine);
            add(v, { description: ['your voice', v.language].filter(Boolean).join(', '), custom: true });
        }
        this.engines = engines;
        this.ownListed = Promise.resolve();
        for (const language of languages.map(l => String(l).trim()).filter(Boolean)) {
            const wanted = language.toLowerCase();
            const multilingual = ORCA_NAMES.has(wanted);
            const fits = (v) => {
                const l = String(v.language || '').toLowerCase();
                return l === wanted || (multilingual && l === 'multilingual');
            };
            for (const v of await list({ type: 'public', language }, fits)) add(v, { description: v.language || language });
        }
        return out;
    }
}
