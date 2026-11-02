import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CALL_PROMPT, PREVIOUS_CALL_PROMPTS, buildCallPrompt, parseCallees } from '../src/prompt.js';

test('names on a card with several people', () => {
    assert.deepEqual(parseCallees(' Nimya, Mahira ,,Nimya\nShraddha '), ['Nimya', 'Mahira', 'Shraddha']);
    assert.deepEqual(parseCallees(''), []);
});

test('the person who answered replaces the card in the call prompt', () => {
    const out = buildCallPrompt({ template: DEFAULT_CALL_PROMPT, tagLevel: 'none', greeting: true, callee: 'Nimya' });
    assert.ok(!out.includes('{{char}}'));
    assert.match(out, /Nimya is the one on the phone/);
    assert.match(out, /The caller is \{\{user\}\}/, '{{user}} is still left for SillyTavern');
    assert.match(out, /called Nimya/);
});

test('without a callee the card speaks for itself', () => {
    const out = buildCallPrompt({ template: DEFAULT_CALL_PROMPT, tagLevel: 'none' });
    assert.match(out, /\{\{char\}\} is the one on the phone/);
    assert.match(out, /Never mistake \{\{user\}\} for another character/);
});

test('a call in Malayalam tells the character to speak it; English and auto add nothing', () => {
    const ml = buildCallPrompt({ template: '{{char}} here', tagLevel: 'none', callee: 'Nadia', language: 'ml' });
    assert.match(ml, /Nadia speaks Malayalam on this call: every spoken line is in Malayalam/);
    assert.ok(!ml.includes('{{char}}'));
    assert.match(buildCallPrompt({ template: 'x', tagLevel: 'none', language: 'pt-BR' }), /speaks Brazilian Portuguese/);
    for (const language of ['', 'auto', 'en', 'en-US']) {
        assert.equal(buildCallPrompt({ template: '{{char}} here', tagLevel: 'none', language }), '{{char}} here');
    }
});

test('a name with $ is inserted as written', () => {
    const out = buildCallPrompt({ template: '{{char}} here', tagLevel: 'none', callee: 'Ka$h' });
    assert.equal(out, 'Ka$h here');
});

test('the old default is recognised so untouched settings move to the new one', () => {
    assert.equal(PREVIOUS_CALL_PROMPTS.length, 1);
    assert.notEqual(PREVIOUS_CALL_PROMPTS[0], DEFAULT_CALL_PROMPT);
    assert.match(PREVIOUS_CALL_PROMPTS[0], /^\[Live voice call\]/);
});
