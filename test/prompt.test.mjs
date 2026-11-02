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

test('a name with $ is inserted as written', () => {
    const out = buildCallPrompt({ template: '{{char}} here', tagLevel: 'none', callee: 'Ka$h' });
    assert.equal(out, 'Ka$h here');
});

test('the old default is recognised so untouched settings move to the new one', () => {
    assert.equal(PREVIOUS_CALL_PROMPTS.length, 1);
    assert.notEqual(PREVIOUS_CALL_PROMPTS[0], DEFAULT_CALL_PROMPT);
    assert.match(PREVIOUS_CALL_PROMPTS[0], /^\[Live voice call\]/);
});
