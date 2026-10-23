import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceAssembler, XaiClient, XaiError } from '../src/xai.js';
import { buildCallPrompt, voiceTagsGuide } from '../src/prompt.js';

test('assembler: interim -> chunk final -> utterance final (stitched)', () => {
    const a = new UtteranceAssembler();
    assert.deepEqual(a.push({ text: 'hey can', is_final: false }), { interim: 'hey can' });
    assert.deepEqual(a.push({ text: 'hey can you hear me', is_final: true }), { interim: 'hey can you hear me' });
    assert.deepEqual(a.push({ text: 'okay so', is_final: false }), { interim: 'hey can you hear me okay so' });
    assert.deepEqual(
        a.push({ text: 'hey can you hear me okay so listen', is_final: true, speech_final: true }),
        { interim: '', utterance: 'hey can you hear me okay so listen' },
    );
    assert.deepEqual(a.committed, []);
});

test('assembler: prepends committed chunks if the final only has the tail', () => {
    const a = new UtteranceAssembler();
    a.push({ text: 'first part of a long thought', is_final: true });
    assert.equal(a.push({ text: 'and the ending', is_final: true, speech_final: true }).utterance, 'first part of a long thought and the ending');
});

test('assembler: empty utterance final yields no utterance', () => {
    const a = new UtteranceAssembler();
    assert.equal(a.push({ text: '', is_final: true, speech_final: true }).utterance, undefined);
});

test('client: builds TTS request and surfaces API errors', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/tts')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        return new Response(JSON.stringify({ error: 'Incorrect API key provided' }), { status: 401 });
    };
    const client = new XaiClient(async () => ({ key: 'xai-test', base: 'https://api.x.ai/v1/' }));
    const buf = await client.tts({ text: 'Hi [laugh]', voice: 'ara', language: 'en', speed: 1.2 });
    assert.equal(buf.byteLength, 3);
    assert.equal(calls[0].url, 'https://api.x.ai/v1/tts');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer xai-test');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        text: 'Hi [laugh]', voice_id: 'ara', language: 'en',
        output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 }, speed: 1.2,
    });
    await assert.rejects(client.voices(), (err) => err instanceof XaiError && err.status === 401 && /Incorrect API key/.test(err.message));
});

test('client: STT puts the file last in the multipart form', async () => {
    let form;
    globalThis.fetch = async (_url, init) => {
        form = init.body;
        return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    };
    const client = new XaiClient(async () => ({ key: 'k' }));
    const res = await client.stt({ audio: new ArrayBuffer(8), language: 'pt-BR', keyterms: ['Seraphina'] });
    assert.equal(res.text, 'hello');
    const keys = [...form.keys()];
    assert.equal(keys.at(-1), 'file');
    assert.equal(form.get('language'), 'pt');
    assert.equal(form.get('keyterm'), 'Seraphina');
});

test('client: missing key is a clear error', async () => {
    const client = new XaiClient(async () => ({ key: '' }));
    await assert.rejects(client.tts({ text: 'x' }), /No xAI API key/);
});

test('prompt: fills tag guide, notes and greeting', () => {
    const p = buildCallPrompt({ template: undefined, tagLevel: 'full', voiceNotes: 'giggles a lot', greeting: true });
    assert.match(p, /\[Live voice call\]/);
    assert.match(p, /\[tongue-click\]/);
    assert.match(p, /<build-intensity>\.\.\.<\/build-intensity>/);
    assert.match(p, /How \{\{char\}\} sounds on the phone: giggles a lot/);
    assert.match(p, /The call just connected/);
    assert.doesNotMatch(p, /\{\{voice_tags\}\}|\{\{voice_notes\}\}/);
    assert.match(voiceTagsGuide('none'), /Do not use/);
});
