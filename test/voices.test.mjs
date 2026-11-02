import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTags } from '../src/text.js';
import { VoiceRouter, parseVoice, voiceRef } from '../src/voices.js';
import { ElevenLabsClient } from '../src/elevenlabs.js';
import { HeyGenClient } from '../src/heygen.js';
import { XaiClient } from '../src/xai.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('voice ids: unprefixed is xAI, others carry their provider', () => {
    assert.deepEqual(parseVoice('eve'), { provider: 'xai', id: 'eve' });
    assert.deepEqual(parseVoice('xai:ara'), { provider: 'xai', id: 'ara' });
    assert.deepEqual(parseVoice('elevenlabs:21m00Tcm4TlvDq8ikWAM'), { provider: 'elevenlabs', id: '21m00Tcm4TlvDq8ikWAM' });
    assert.deepEqual(parseVoice('heygen:abc:def'), { provider: 'heygen', id: 'abc:def' });
    assert.equal(voiceRef('xai', 'eve'), 'eve');
    assert.equal(voiceRef('heygen', 'abc'), 'heygen:abc');
});

test('tags: ElevenLabs spelling, with the voice back to normal after a wrapped phrase', () => {
    assert.equal(
        renderTags('Wait, really? [laugh] Okay... <whisper>I\'m impressed.</whisper> [sigh] <emphasis>Fine</emphasis>, you win.', 'eleven'),
        'Wait, really? [laughs] Okay... [whispers] I\'m impressed. [normally] [sighs] FINE, you win.',
    );
    assert.equal(renderTags('<loud>Get out!</loud>', 'eleven'), '[shouting] Get out!');
    assert.equal(renderTags('[long-pause] So.', 'eleven'), '[long pause] So.');
});

test('tags: plain drops them and keeps pauses as an ellipsis', () => {
    assert.equal(renderTags('Hmm [pause] okay [laugh] <whisper>fine</whisper>.', 'plain'), 'Hmm… okay fine.');
    assert.equal(renderTags('[laugh]', 'plain'), '');
    assert.equal(renderTags('No change [laugh] <soft>here</soft>', 'grok'), 'No change [laugh] <soft>here</soft>');
});

function fakeClients() {
    const calls = [];
    const make = (name) => ({
        tts: async (o) => { calls.push({ name, ...o }); return new ArrayBuffer(1); },
        voices: async (langs) => (name === 'heygen' ? langs.map(l => ({ voice_id: `h-${l}`, name: l })) : [{ voice_id: `${name}-1`, name: 'One' }]),
    });
    return { calls, clients: { xai: make('xai'), elevenlabs: make('elevenlabs'), heygen: make('heygen') } };
}

test('router: each provider gets the text in the form it reads', async () => {
    const { calls, clients } = fakeClients();
    let model = 'eleven_v4_turbo';
    const router = new VoiceRouter(clients, { elevenModel: () => model });
    const text = 'Oh [laugh] <whisper>hi</whisper>';
    await router.tts({ text, voice: 'eve', language: 'en', speed: 1 });
    await router.tts({ text, voice: 'elevenlabs:v1', language: 'ml', speed: 1.1 });
    model = 'eleven_flash_v2_5';
    await router.tts({ text, voice: 'elevenlabs:v1', language: 'ml', speed: 1 });
    await router.tts({ text, voice: 'heygen:h1', language: 'ml', speed: 1 });
    assert.deepEqual(calls.map(c => [c.name, c.voice, c.text]), [
        ['xai', 'eve', 'Oh [laugh] <whisper>hi</whisper>'],
        ['elevenlabs', 'v1', 'Oh [laughs] [whispers] hi'],
        ['elevenlabs', 'v1', 'Oh hi'],
        ['heygen', 'h1', 'Oh hi'],
    ]);
    assert.equal(calls[1].language, 'ml');
    assert.equal(calls[1].speed, 1.1);
    assert.equal(router.tagStyle('heygen:h1'), 'plain');
    assert.equal(router.tagStyle('eve'), 'grok');
});

test('router: a sound-only chunk is skipped quietly for a voice without tags', async () => {
    const { calls, clients } = fakeClients();
    const router = new VoiceRouter(clients);
    await assert.rejects(router.tts({ text: '[sigh]', voice: 'heygen:h1' }), (err) => err.name === 'AbortError');
    await router.tts({ text: '[sigh]', voice: 'eve' });
    assert.deepEqual(calls.map(c => c.name), ['xai']);
});

test('router: voices are tagged by provider and one failure does not hide the rest', async () => {
    const { clients } = fakeClients();
    clients.elevenlabs.voices = async () => { throw Object.assign(new Error('bad key'), { status: 401 }); };
    const router = new VoiceRouter(clients, { heygenLanguages: () => ['Malayalam'] });
    const out = await router.voices(['xai', 'elevenlabs', 'heygen']);
    assert.deepEqual(out[0].voices, [{ voice_id: 'xai-1', name: 'One', provider: 'xai' }]);
    assert.equal(out[1].error.status, 401);
    assert.deepEqual(out[2].voices, [{ voice_id: 'heygen:h-Malayalam', name: 'Malayalam', provider: 'heygen' }]);
});

test('ElevenLabs: TTS request, language only for models that take it, speed via voice_settings', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(new Uint8Array([1, 2]), { status: 200 });
    };
    let model = 'eleven_v4_turbo';
    const client = new ElevenLabsClient(async () => ({ key: 'sk_test', base: 'https://api.elevenlabs.io/', model }));
    const buf = await client.tts({ text: 'നമസ്കാരം', voice: 'abc', language: 'ml', speed: 1.4 });
    assert.equal(buf.byteLength, 2);
    assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/abc?output_format=mp3_44100_128');
    assert.equal(calls[0].init.headers['xi-api-key'], 'sk_test');
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'നമസ്കാരം', model_id: 'eleven_v4_turbo', language_code: 'ml', voice_settings: { speed: 1.2 } });
    model = 'eleven_multilingual_v2';
    await client.tts({ text: 'Hi', voice: 'abc', language: 'en', speed: 1 });
    assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'Hi', model_id: 'eleven_multilingual_v2' });
});

test('ElevenLabs: readable errors and a clear message without a key', async () => {
    globalThis.fetch = async () => json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401);
    const client = new ElevenLabsClient(async () => ({ key: 'sk_bad' }));
    await assert.rejects(client.tts({ text: 'x', voice: 'v' }), (err) => err.status === 401 && err.message === 'ElevenLabs 401: Invalid API key');
    await assert.rejects(new ElevenLabsClient(async () => ({ key: '' })).voices(), /No ElevenLabs API key/);
});

test('ElevenLabs: voices page through the library', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
        urls.push(url);
        return url.includes('next_page_token')
            ? json({ voices: [{ voice_id: 'b', name: 'Bea', category: 'cloned', labels: { gender: 'female' } }], has_more: false })
            : json({
                voices: [{ voice_id: 'a', name: 'Arun', category: 'premade', labels: { gender: 'male', accent: 'indian', description: 'warm' }, verified_languages: [{ language: 'ml', model_id: 'eleven_v3' }, { language: 'en', model_id: 'eleven_v3' }] }],
                has_more: true, next_page_token: 'p2',
            });
    };
    const voices = await new ElevenLabsClient(async () => ({ key: 'k' })).voices();
    assert.equal(urls.length, 2);
    assert.match(urls[1], /next_page_token=p2/);
    assert.deepEqual(voices, [
        { voice_id: 'a', name: 'Arun', description: 'warm, indian', gender: 'male', language: 'Malayalam, English', custom: false },
        { voice_id: 'b', name: 'Bea', description: '', gender: 'female', language: '', custom: true },
    ]);
});

test('HeyGen: speech is made, then its MP3 is fetched', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        if (url.includes('/v3/voices?')) return json({ data: [], has_more: false });     // your voices, listed once
        calls.push({ url, init });
        if (url.endsWith('/v3/voices/speech')) return json({ data: { audio_url: 'https://files.heygen.ai/audio/x.mp3', duration: 1.2 } });
        return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    };
    const client = new HeyGenClient(async () => ({ key: 'hg' }));
    const buf = await client.tts({ text: 'ഹലോ', voice: 'v1', language: 'ml', speed: 3 });
    assert.equal(buf.byteLength, 3);
    assert.equal(calls[0].url, 'https://api.heygen.com/v3/voices/speech');
    assert.equal(calls[0].init.headers['X-Api-Key'], 'hg');
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'ഹലോ', voice_id: 'v1', language: 'ml', speed: 2 });
    assert.equal(calls[1].url, 'https://files.heygen.ai/audio/x.mp3');

    globalThis.fetch = async () => json({ data: {} });
    await assert.rejects(client.tts({ text: 'x', voice: 'v1', language: 'auto' }), /did not return any audio/);
});

test('HeyGen: voices are listed per language, without duplicates', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
        if (new URL(url).searchParams.get('type') === 'private') return json({ data: [], has_more: false });
        urls.push(url);
        const lang = new URL(url).searchParams.get('language');
        if (lang === 'Malayalam' && !url.includes('token=')) {
            return json({ data: [{ voice_id: 'm1', name: 'Meera', language: 'Malayalam', gender: 'female', available_engines: ['starfish'] }], has_more: true, next_token: 't2' });
        }
        if (lang === 'Malayalam') return json({ data: [{ voice_id: 'm2', name: 'Manu', language: 'Malayalam', gender: 'male', available_engines: [] }], has_more: false });
        return json({ data: [{ voice_id: 'm1', name: 'Meera', language: 'Malayalam', gender: 'female', available_engines: ['starfish'] }], has_more: false });
    };
    const voices = await new HeyGenClient(async () => ({ key: 'k' })).voices(['Malayalam', ' English ']);
    assert.equal(urls.length, 3);
    assert.match(urls[0], /type=public&language=Malayalam&limit=100/);
    assert.match(urls[1], /token=t2/);
    // Manu has no engine that can speak, and Meera is listed once.
    assert.deepEqual(voices, [{ voice_id: 'm1', name: 'Meera', description: 'Malayalam', gender: 'female', language: 'Malayalam' }]);
});

test('HeyGen: your own voices come first, and public ones only in a language they can speak', async () => {
    globalThis.fetch = async (url) => {
        const q = new URL(url).searchParams;
        if (q.get('type') === 'private') {
            return json({ data: [
                { voice_id: 'own1', name: 'Queen Niya', language: 'Malayalam', gender: 'female', available_engines: ['starfish', 'orca', 'elevenlabs'], default_engine: null },
                { voice_id: 'own2', name: 'Niya', language: 'Malayalam', gender: 'female', available_engines: ['starfish', 'orca', 'elevenlabs'], default_engine: 'elevenlabs' },
            ], has_more: false });
        }
        // The language filter only sorts: other languages come back too.
        return json({ data: [
            { voice_id: 'p1', name: 'Gail', language: 'Multilingual', gender: 'female', available_engines: ['orca'] },
            { voice_id: 'p2', name: 'Tom', language: 'English', gender: 'male', available_engines: ['orca'] },
            { voice_id: 'p3', name: 'Kavya', language: 'Tamil', gender: 'female', available_engines: ['orca'] },
        ], has_more: false });
    };
    const client = new HeyGenClient(async () => ({ key: 'k' }));
    const ids = async (langs) => (await client.voices(langs)).map(v => v.voice_id);
    // Orca can't speak Malayalam, so no public voice is offered for it.
    assert.deepEqual(await ids(['Malayalam']), ['own1', 'own2']);
    // Tamil: a voice made for it, and the multilingual one, since Orca speaks Tamil.
    assert.deepEqual(await ids(['Tamil']), ['own1', 'own2', 'p1', 'p3']);
    const [queen] = await client.voices([]);
    assert.deepEqual(queen, { voice_id: 'own1', name: 'Queen Niya', gender: 'female', language: 'Malayalam', description: 'your voice, Malayalam', custom: true });
});

test('HeyGen: your voice with no saved engine the API can use speaks through ElevenLabs', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
        if (url.includes('/v3/voices?')) {
            return json({ data: [
                { voice_id: 'own1', name: 'Queen Niya', available_engines: ['starfish', 'orca', 'elevenlabs'], default_engine: null },
                { voice_id: 'own2', name: 'Niya', available_engines: ['starfish', 'orca', 'elevenlabs'], default_engine: 'elevenlabs' },
                { voice_id: 'own3', name: 'Cartesia only in the app', available_engines: ['orca'], default_engine: 'cartesia' },
            ], has_more: false });
        }
        if (url.endsWith('/v3/voices/speech')) {
            bodies.push(JSON.parse(init.body));
            return json({ data: { audio_url: 'https://resource2.heygen.ai/x.wav' } });
        }
        return new Response(new Uint8Array([1]), { status: 200 });
    };
    // No listing first: the first speech lists your voices once.
    const client = new HeyGenClient(async () => ({ key: 'k' }));
    for (const voice of ['own1', 'own2', 'own3', 'public1']) await client.tts({ text: 'ഹലോ', voice, language: 'ml' });
    assert.deepEqual(bodies.map(b => b.engine), ['elevenlabs', undefined, 'orca', undefined]);
});

test('xAI: languages Grok cannot speak or hear fall back to auto-detect', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return url.endsWith('/stt') ? json({ text: 'hi' }) : new Response(new Uint8Array([1]), { status: 200 });
    };
    const client = new XaiClient(async () => ({ key: 'k' }));
    await client.tts({ text: 'hi', voice: 'eve', language: 'ml' });
    assert.equal(JSON.parse(calls[0].init.body).language, 'auto');
    await client.stt({ audio: new ArrayBuffer(8), language: 'ml' });
    assert.equal(calls[1].init.body.get('language'), null);
    await client.stt({ audio: new ArrayBuffer(8), language: 'hi' });
    assert.equal(calls[2].init.body.get('language'), 'hi');
});
