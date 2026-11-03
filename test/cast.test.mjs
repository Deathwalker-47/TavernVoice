import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK, calleeChoices, callerChoices, castOf, mergeCast, voiceFor, whoAnswers } from '../src/cast.js';
import { DEFAULT_CALL_PROMPT, buildCallPrompt } from '../src/prompt.js';

const NADIA = { name: 'Nadia', voice: 'ara', about: 'Runs the inn.', notes: 'warm' };
const BRAM = { name: 'Bram', voice: '', about: 'The cook.', notes: '' };

test('the older "Who answers" text still gives a list', () => {
    assert.deepEqual(castOf({ callees: 'Nadia, Bram' }).map(p => p.name), ['Nadia', 'Bram']);
    assert.deepEqual(castOf({ cast: [NADIA, { name: ' nadia ' }, { name: '' }] }), [NADIA], 'blank and repeated names are dropped');
    assert.deepEqual(castOf({}), []);
});

test('the card itself is always one of the people you can call', () => {
    const choices = calleeChoices({ cast: [NADIA, BRAM] }, 'Seaside Inn');
    assert.deepEqual(choices.map(c => c.name), ['Seaside Inn', 'Nadia', 'Bram'], 'the card heads the list');
    assert.deepEqual(choices[0], { name: 'Seaside Inn', person: null, card: true });
    assert.deepEqual(choices[1], { name: 'Nadia', person: NADIA, card: false });
    assert.deepEqual(calleeChoices({}, 'Maya').map(c => c.name), ['Maya'], 'no cast: just the card');
});

test('a cast entry named after the card is the card, not a second person', () => {
    const MAYA = { name: 'Maya', voice: 'eve', about: 'The whole card.', notes: '' };
    const choices = calleeChoices({ cast: [MAYA, BRAM] }, 'maya');
    assert.deepEqual(choices.map(c => c.name), ['maya', 'Bram'], 'Maya is not offered twice');
    assert.deepEqual(choices[0].person, MAYA, 'her voice and brief still reach the call');
    assert.deepEqual(whoAnswers({ cast: [MAYA], answers: ASK }, 'Maya'), { person: MAYA },
        'an ordinary card with only itself on the list needs no question');
});

test('who picks up', () => {
    assert.deepEqual(whoAnswers({}), {}, 'no list: the card itself');
    assert.deepEqual(whoAnswers({ cast: [NADIA, BRAM] }), { ask: true }, 'asks by default');
    assert.deepEqual(whoAnswers({ cast: [NADIA, BRAM], answers: ASK }), { ask: true });
    assert.deepEqual(whoAnswers({ cast: [NADIA, BRAM], answers: 'bram' }), { person: BRAM });
    assert.deepEqual(whoAnswers({ cast: [NADIA, BRAM], answers: '' }), {}, 'the card itself was picked');
    assert.deepEqual(whoAnswers({ cast: [NADIA, BRAM], answers: 'Someone removed' }), { ask: true });
});

test('one side character is still a question, because the card is the other answer', () => {
    assert.deepEqual(whoAnswers({ cast: [NADIA], answers: ASK }, 'Seaside Inn'), { ask: true },
        'Nadia used to answer every call and the inn itself could never be reached');
    assert.deepEqual(whoAnswers({ cast: [NADIA], answers: '' }, 'Seaside Inn'), {}, 'the inn can be pinned');
    assert.deepEqual(whoAnswers({ cast: [NADIA], answers: 'Nadia' }, 'Seaside Inn'), { person: NADIA },
        'so can Nadia');
    assert.deepEqual(whoAnswers({ cast: [NADIA], answers: 'Gone' }, 'Seaside Inn'), { ask: true },
        'a name that is no longer on the list falls back to asking, not to Nadia');
});

test('a person has their own voice, or the card\'s', () => {
    const card = { voice: 'eve', notes: 'card notes', speed: '1.1' };
    assert.deepEqual(voiceFor(card, NADIA), { voice: 'ara', notes: 'warm', speed: '1.1' });
    assert.deepEqual(voiceFor(card, BRAM), { voice: 'eve', notes: 'card notes', speed: '1.1' });
    assert.equal(voiceFor(card, null), card);
});

test('people found by the helper are added without overwriting edits', () => {
    const found = [
        { name: 'nadia', voice: 'eve', about: 'Overwritten?', sound: 'husky' },
        { name: 'Bram', voice: 'rex', about: 'Gruff cook.', sound: 'gravelly' },
        { name: 'Ilse', voice: 'luna', about: 'A guest.', sound: '' },
    ];
    const out = mergeCast([NADIA, BRAM], found);
    assert.deepEqual(out[0], NADIA);
    assert.deepEqual(out[1], { name: 'Bram', voice: 'rex', about: 'The cook.', notes: 'gravelly' });
    assert.deepEqual(out[2], { name: 'Ilse', voice: 'luna', about: 'A guest.', notes: '' });
});

test('the call prompt says who answered and who is not on the call', () => {
    const out = buildCallPrompt({ template: DEFAULT_CALL_PROMPT, tagLevel: 'none', greeting: true, callee: 'Nadia', about: 'Runs the inn.', others: ['Nadia', 'Bram', 'Ilse'] });
    assert.match(out, /Who Nadia is: Runs the inn\./);
    assert.match(out, /Not on this call: Bram, Ilse\. Nadia can talk about them, but never speaks their lines/);
    assert.ok(out.indexOf('Not on this call') < out.indexOf('The call just connected'), 'the greeting note stays last');
    const plain = buildCallPrompt({ template: DEFAULT_CALL_PROMPT, tagLevel: 'none' });
    assert.doesNotMatch(plain, /Who \{\{char\}\} is|Not on this call/);
});

test('you can call as the persona, as someone in the story, or as anyone else', () => {
    const choices = callerChoices({
        persona: ' Anuj ',
        cardName: 'Seaside Inn',
        cast: [NADIA, BRAM],
        characters: [{ name: 'Bram', description: 'A second Bram.' }, { name: 'Ilse', description: 'A guest.' }],
    });
    assert.deepEqual(choices.map(c => c.name), ['Anuj', 'Seaside Inn', 'Nadia', 'Bram', 'Ilse'],
        'the persona, then the card and its people, then the rest');
    assert.deepEqual(choices[0], { name: 'Anuj', about: '', group: '', persona: true });
    assert.deepEqual(choices[1], { name: 'Seaside Inn', about: '', group: 'In this story', persona: false });
    assert.deepEqual(choices[2], { name: 'Nadia', about: 'Runs the inn.', group: 'In this story', persona: false });
    assert.deepEqual(choices[4], { name: 'Ilse', about: 'A guest.', group: 'Other characters', persona: false });
    assert.equal(choices[3].about, 'The cook.', 'the story\'s own Bram is the one offered');
});

test('nobody calls themselves', () => {
    const choices = callerChoices({ persona: 'Anuj', cardName: 'Nadia', cast: [NADIA, BRAM], answering: ' nadia ' });
    assert.deepEqual(choices.map(c => c.name), ['Anuj', 'Bram'], 'whoever picked up cannot also be calling');
    const same = callerChoices({ persona: 'nadia', cast: [NADIA], answering: 'Bram' });
    assert.deepEqual(same.map(c => c.name), ['nadia'], 'a character sharing the persona\'s name is the persona');
    const herself = callerChoices({ persona: 'Nadia', cast: [NADIA], answering: 'Nadia' });
    assert.deepEqual(herself.map(c => c.name), ['Nadia'], 'the persona heads the list even when she is the one picking up');
});

test('the caller list drops names it cannot offer', () => {
    const choices = callerChoices({ persona: '', cardName: '   ', cast: [{ name: '' }, { name: ' Bram ' }] });
    assert.deepEqual(choices[0], { name: '', about: '', group: '', persona: true }, 'an unnamed persona is still first');
    assert.deepEqual(choices.map(c => c.name), ['', 'Bram'], 'blank names go, and the rest keep their own spelling');
    const long = callerChoices({ persona: 'Anuj', characters: [{ name: 'Ilse', description: ` ${'x'.repeat(900)} ` }] });
    assert.equal(long[1].about.length, 600, 'a whole card description would crowd the prompt');
});

test('calling as someone else makes them {{user}} for the call', () => {
    const out = buildCallPrompt({
        template: DEFAULT_CALL_PROMPT, tagLevel: 'none', callee: 'Nimya', about: 'Runs the inn.',
        caller: 'Mahira', callerAbout: 'Her sister.', others: ['Nimya', 'Mahira', 'Bram'],
    });
    assert.match(out, /Who Mahira is: Her sister\./);
    assert.match(out, /the caller is Mahira\./, 'the chat still describes the persona, who is not on this call');
    assert.match(out, /Not on this call: Bram\./, 'Mahira is on the call, so she is not one of the others');
    assert.doesNotMatch(out, /\{\{user\}\}/, 'nothing is left for SillyTavern to fill in with the persona');
    assert.ok(out.indexOf('Not on this call') < out.indexOf('Who Mahira is'), 'the caller is introduced after the others');
});

test('a caller with no brief of their own is still placed in the story', () => {
    const out = buildCallPrompt({ template: DEFAULT_CALL_PROMPT, tagLevel: 'none', callee: 'Nimya', caller: ' Mahira ' });
    assert.match(out, /Who Mahira is: Mahira, from this story\./);
    const cash = buildCallPrompt({ template: '{{user}} calls.', tagLevel: 'none', caller: 'A$AP' });
    assert.match(cash, /^A\$AP calls\./, 'a dollar sign in a name is not a replacement pattern');
    const plain = buildCallPrompt({ template: DEFAULT_CALL_PROMPT, tagLevel: 'none', callee: 'Nimya' });
    assert.match(plain, /\{\{user\}\}/, 'an ordinary call is from the persona, so SillyTavern fills it in');
    assert.doesNotMatch(plain, /Who \{\{user\}\} is/);
});
