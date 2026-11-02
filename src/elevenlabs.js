// Browser client for ElevenLabs text to speech.
// api.elevenlabs.io answers CORS preflights with "*", so these calls go straight from the browser.

import { DEFAULT_ELEVEN_BASE } from './constants.js';
import { ApiError, fetchWithRetry } from './http.js';

/** Models that take a language_code. Multilingual v2 rejects it and Flash v2 is English only. */
const LANGUAGE_MODELS = /^eleven_(v[34]|flash_v2_5|turbo_v2_5)/;

/** ElevenLabs' own voice categories that a user made rather than picked from the defaults. */
const OWN_CATEGORIES = new Set(['cloned', 'generated', 'professional']);

/** "ml" -> "Malayalam", the way HeyGen names its voice languages. */
function languageName(code) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

export class ElevenLabsClient {
    /**
     * @param {() => Promise<{key: string, base?: string, model?: string}>} getConfig Resolved per request
     */
    constructor(getConfig) {
        this.getConfig = getConfig;
    }

    async #config() {
        const { key, base, model } = await this.getConfig();
        if (!key) throw new ApiError('No ElevenLabs API key. Add one in Extensions → TavernVoice.', 401);
        return { key, base: (base || DEFAULT_ELEVEN_BASE).replace(/\/+$/, ''), model: model || 'eleven_v4_turbo' };
    }

    /**
     * Text to speech. Returns MP3 bytes.
     * @returns {Promise<ArrayBuffer>}
     */
    async tts({ text, voice, language = 'auto', speed = 1, signal }) {
        const { key, base, model } = await this.#config();
        const json = { text, model_id: model };
        const lang = !language || language === 'auto' ? '' : String(language).split('-')[0].toLowerCase();
        if (lang && LANGUAGE_MODELS.test(model)) json.language_code = lang;
        // Sending voice_settings replaces the voice's saved settings, so only for a speed change.
        const s = Number(speed);
        if (s && s !== 1) json.voice_settings = { speed: Math.max(0.7, Math.min(1.2, s)) };
        const res = await fetchWithRetry(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify(json),
            signal,
        }, { label: 'ElevenLabs' });
        return await res.arrayBuffer();
    }

    /** The voices in the user's ElevenLabs library: defaults, clones and ones saved from the community. */
    async voices() {
        const { key, base } = await this.#config();
        const out = [];
        let token = '';
        for (let page = 0; page < 5; page++) {
            const q = new URLSearchParams({ page_size: '100' });
            if (token) q.set('next_page_token', token);
            const res = await fetchWithRetry(`${base}/v2/voices?${q}`, { method: 'GET', headers: { 'xi-api-key': key } }, { label: 'ElevenLabs', retries: 0 });
            const data = await res.json();
            for (const v of data?.voices ?? []) {
                const labels = v.labels ?? {};
                const languages = [...new Set((v.verified_languages ?? []).map(l => l.language).filter(Boolean).map(languageName))];
                out.push({
                    voice_id: v.voice_id,
                    name: v.name || v.voice_id,
                    description: [labels.description || labels.descriptive || v.description, labels.accent, labels.age, labels.use_case]
                        .filter(Boolean).join(', ').slice(0, 120),
                    gender: labels.gender,
                    language: languages.join(', '),
                    custom: OWN_CATEGORIES.has(v.category),
                });
            }
            token = data?.next_page_token;
            if (!data?.has_more || !token) break;
        }
        return out;
    }
}
