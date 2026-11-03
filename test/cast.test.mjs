import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK, calleeChoices, castOf, mergeCast, voiceFor, whoAnswers } from '../src/cast.js';
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
