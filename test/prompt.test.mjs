import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CALL_PROMPT, HUNG_UP_NOTE, PREVIOUS_CALL_PROMPTS, buildCallPrompt, parseCallees } from '../src/prompt.js';

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

test('hanging up leaves a note that the phone style is over', () => {
    // The call's own turns stay in the chat as bare spoken lines, so something has to say that
    // they are not the pattern to follow any more.
    assert.match(HUNG_UP_NOTE, /no longer on a call/);
    assert.match(HUNG_UP_NOTE, /narration, actions and description/);
    assert.match(HUNG_UP_NOTE, /\{\{char\}\}/, 'left for SillyTavern to fill in, like the other notes');
    assert.match(HUNG_UP_NOTE, /\{\{user\}\}/);
});

test('every earlier default is recognised so untouched settings move to the new one', () => {
    // Counting them only breaks the next time the default is reworded. What has to hold is that
    // each entry is a real former default and none has drifted into matching the current one,
    // which would make the swap a no-op and strand everyone who never edited the template.
    assert.ok(PREVIOUS_CALL_PROMPTS.length >= 1);
    for (const old of PREVIOUS_CALL_PROMPTS) {
        assert.notEqual(old, DEFAULT_CALL_PROMPT);
        assert.match(old, /^\[Live voice call\]/);
    }
});
