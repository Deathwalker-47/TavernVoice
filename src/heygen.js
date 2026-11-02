// Browser client for HeyGen text to speech (v3 voices API).
// api.heygen.com and its audio host files.heygen.ai both allow browser origins (CORS).

import { DEFAULT_HEYGEN_BASE } from './constants.js';
import { ApiError, fetchWithRetry } from './http.js';

export class HeyGenClient {
    /**
     * @param {() => Promise<{key: string, base?: string}>} getConfig Resolved per request
     */
    constructor(getConfig) {
        this.getConfig = getConfig;
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
     * HeyGen's public voices in the given languages ("Malayalam", "English"). The library has
     * thousands of voices, so it is only listed one language at a time.
     * @param {string[]} languages
     */
    async voices(languages = []) {
        const { key, base } = await this.#config();
        const out = [];
        const seen = new Set();
        for (const language of languages.map(l => String(l).trim()).filter(Boolean)) {
            let token = '';
            for (let page = 0; page < 5; page++) {
                const q = new URLSearchParams({ type: 'public', language, limit: '100' });
                if (token) q.set('token', token);
                const res = await fetchWithRetry(`${base}/v3/voices?${q}`, { method: 'GET', headers: { 'X-Api-Key': key } }, { label: 'HeyGen', retries: 0 });
                const data = await res.json();
                for (const v of data?.data ?? []) {
                    if (!v.voice_id || seen.has(v.voice_id) || !(v.available_engines ?? ['any']).length) continue;
                    seen.add(v.voice_id);
                    out.push({
                        voice_id: v.voice_id,
                        name: v.name || v.voice_id,
                        description: v.language || language,
                        gender: v.gender,
                        language: v.language || language,
                    });
                }
                token = data?.next_token;
                if (!data?.has_more || !token) break;
            }
        }
        return out;
    }
}
