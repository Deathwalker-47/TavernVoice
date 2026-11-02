// One way to speak, whoever owns the voice. A voice ID says which provider speaks it:
// "eve" (xAI, the original unprefixed form), "elevenlabs:<id>", "heygen:<id>" or "cartesia:<id>".

import { renderTags } from './text.js';

export const PROVIDERS = { xai: 'xAI Grok', elevenlabs: 'ElevenLabs', heygen: 'HeyGen', cartesia: 'Cartesia' };

/** "heygen:abc" -> {provider: 'heygen', id: 'abc'}; "eve" -> {provider: 'xai', id: 'eve'}. */
export function parseVoice(ref) {
    const s = String(ref ?? '').trim();
    const m = /^(xai|elevenlabs|heygen|cartesia):(.+)$/.exec(s);
    return m ? { provider: m[1], id: m[2] } : { provider: 'xai', id: s };
}

export const voiceRef = (provider, id) => (provider === 'xai' ? id : `${provider}:${id}`);

export class VoiceRouter {
    /**
     * @param {{xai: object, elevenlabs: object, heygen: object, cartesia: object}} clients Each has tts() and voices()
     * @param {object} [o]
     * @param {() => string} [o.elevenModel] The ElevenLabs model in use
     * @param {() => string[]} [o.heygenLanguages] Languages to list HeyGen voices for
     * @param {() => string[]} [o.cartesiaLanguages] Languages to list public Cartesia voices for
     */
    constructor(clients, { elevenModel = () => '', heygenLanguages = () => [], cartesiaLanguages = () => [] } = {}) {
        this.clients = clients;
        this.elevenModel = elevenModel;
        this.heygenLanguages = heygenLanguages;
        this.cartesiaLanguages = cartesiaLanguages;
    }

    /** The languages a provider's voice list is limited to, or null when it lists everything. */
    listedLanguages(provider) {
        if (provider === 'heygen') return this.heygenLanguages();
        return provider === 'cartesia' ? this.cartesiaLanguages() : null;
    }

    /** How a voice takes speech tags: 'grok' as written, 'eleven' translated, or 'plain' without any. */
    tagStyle(ref) {
        const { provider } = parseVoice(ref);
        if (provider === 'elevenlabs') return /^eleven_v[34]/.test(this.elevenModel()) ? 'eleven' : 'plain';
        return provider === 'heygen' || provider === 'cartesia' ? 'plain' : 'grok';
    }

    /**
     * Speaks text written with Grok tags in any provider's voice.
     * @returns {Promise<ArrayBuffer>} audio bytes for SpeechPlayer
     */
    async tts({ text, voice, language, speed, signal }) {
        const { provider, id } = parseVoice(voice);
        const spoken = renderTags(text, this.tagStyle(voice));
        // A chunk that was only a sound tag is empty for a voice without tags. AbortError makes the player skip it quietly.
        if (!/[\p{L}\p{N}[]/u.test(spoken)) throw new DOMException('Nothing to say', 'AbortError');
        return this.clients[provider].tts({ text: spoken, voice: id, language, speed, signal });
    }

    /**
     * Lists each provider's voices with provider-tagged IDs. One provider failing doesn't hide the others.
     * @param {string[]} providers
     * @returns {Promise<{provider: string, voices: object[], error?: Error}[]>}
     */
    async voices(providers) {
        const load = (p) => {
            const languages = this.listedLanguages(p);
            return languages ? this.clients[p].voices(languages) : this.clients[p].voices();
        };
        const results = await Promise.allSettled(providers.map(load));
        return providers.map((provider, i) => {
            const r = results[i];
            if (r.status === 'rejected') return { provider, voices: [], error: r.reason };
            return { provider, voices: r.value.map(v => ({ ...v, voice_id: voiceRef(provider, v.voice_id), provider })) };
        });
    }
}
