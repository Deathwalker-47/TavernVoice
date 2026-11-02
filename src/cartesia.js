// Browser client for Cartesia text to speech.
// api.cartesia.ai answers CORS preflights with "*", so these calls go straight from the browser.

import { CARTESIA_LANGUAGES, CARTESIA_VERSION, DEFAULT_CARTESIA_BASE } from './constants.js';
import { ApiError, fetchWithRetry } from './http.js';

const GENDERS = { masculine: 'male', feminine: 'female', gender_neutral: 'neutral' };

/** "ml" -> "Malayalam". */
function languageName(code) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

export class CartesiaClient {
    /**
     * @param {() => Promise<{key: string, base?: string, model?: string}>} getConfig Resolved per request
     */
    constructor(getConfig) {
        this.getConfig = getConfig;
    }

    async #config() {
        const { key, base, model } = await this.getConfig();
        if (!key) throw new ApiError('No Cartesia API key. Add one in Extensions → TavernVoice.', 401);
        return { key, base: (base || DEFAULT_CARTESIA_BASE).replace(/\/+$/, ''), model: model || 'sonic-3.6' };
    }

    /**
     * Text to speech. Returns MP3 bytes.
     * @returns {Promise<ArrayBuffer>}
     */
    async tts({ text, voice, language = 'auto', speed = 1, signal }) {
        const { key, base, model } = await this.#config();
        const json = {
            model_id: model,
            transcript: text,
            voice: { id: voice },
            output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
        };
        // Auto-detect sends no language and leaves it to Cartesia's default.
        const lang = !language || language === 'auto' ? '' : String(language).split('-')[0].toLowerCase();
        if (CARTESIA_LANGUAGES.has(lang)) json.language = lang;
        const s = Number(speed);
        if (s && s !== 1) json.generation_config = { speed: Math.max(0.6, Math.min(1.5, s)) };
        const res = await fetchWithRetry(`${base}/tts/bytes`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify(json),
            signal,
        }, { label: 'Cartesia' });
        return await res.arrayBuffer();
    }

    /** One filtered listing of GET /voices, paged. */
    async #list(key, base, filter) {
        const out = [];
        let after = '';
        for (let page = 0; page < 5; page++) {
            const q = new URLSearchParams({ limit: '100', ...filter });
            if (after) q.set('starting_after', after);
            const res = await fetchWithRetry(`${base}/voices?${q}`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': CARTESIA_VERSION },
            }, { label: 'Cartesia', retries: 0 });
            const data = await res.json();
            out.push(...(data?.data ?? []));
            after = data?.next_page || data?.data?.at(-1)?.id;
            if (!data?.has_more || !after) break;
        }
        return out;
    }

    /**
     * Your own voices, then the public voices Cartesia suggests for each language.
     * The public library has well over a thousand voices, so it is never listed whole.
     * @param {string[]} languages Codes or English names, e.g. ['ml', 'Tamil']
     */
    async voices(languages = []) {
        const { key, base } = await this.#config();
        const found = new Map();
        for (const v of await this.#list(key, base, { is_owner: 'true' })) found.set(v.id, v);
        for (const code of languageCodes(languages)) {
            for (const v of await this.#list(key, base, { language: code })) if (!found.has(v.id)) found.set(v.id, v);
        }
        return [...found.values()].map(v => {
            const codes = [v.language, ...(v.accents ?? []).map(a => a?.locale)].filter(Boolean).map(c => String(c).split(/[-_]/)[0].toLowerCase());
            return {
                voice_id: v.id,
                name: v.name || v.id,
                description: String(v.tagline || v.description || '').slice(0, 120),
                gender: GENDERS[v.gender] ?? v.gender ?? '',
                language: [...new Set(codes)].map(languageName).join(', '),
                custom: !!v.is_owner,
            };
        });
    }
}

/** ['Malayalam', 'ta', 'Klingon'] -> ['ml', 'ta']: the ones Cartesia speaks, as its codes. */
export function languageCodes(languages) {
    const byName = new Map([...CARTESIA_LANGUAGES].map(c => [languageName(c).toLowerCase(), c]));
    const codes = languages.map(l => String(l).trim().toLowerCase()).map(l => (CARTESIA_LANGUAGES.has(l) ? l : byName.get(l)));
    return [...new Set(codes.filter(Boolean))];
}
