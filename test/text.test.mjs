import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSpeechText, takeChunks, balanceTags, SpeechTurn, normalizeTagName, captionHtml, isSpeakable, decorateTagsHtml } from '../src/text.js';

test('strips actions, converts audible ones to tags', () => {
    const out = toSpeechText('*laughs softly* Oh my god. *walks to the window* You actually called!');
    assert.equal(out, '[laugh] Oh my god. You actually called!');
});

test('mode=all reads narration', () => {
    assert.equal(toSpeechText('*She smiles.* Hi.', { mode: 'all' }), 'She smiles. Hi.');
});

test('mode=quotes keeps only quoted speech, falls back when none', () => {
    assert.equal(toSpeechText('She leans in. "Hey there." She waits. "Miss me?"', { mode: 'quotes' }), 'Hey there.\nMiss me?');
    assert.equal(toSpeechText('No quotes at all here.', { mode: 'quotes' }), 'No quotes at all here.');
    assert.equal(toSpeechText('She leans in and', { mode: 'quotes', final: false }), '');
});

test('normalizes tag spellings and drops unknown brackets', () => {
    assert.equal(normalizeTagName('Laughs'), 'laugh');
    assert.equal(normalizeTagName('long pause'), 'long-pause');
    assert.equal(normalizeTagName('WHISPERS'), 'whisper');
    const out = toSpeechText('Wait [sighs] okay. [OOC: be nice] <Whispers>secret</Whispers> [smiling] done.');
    assert.equal(out, 'Wait [sigh] okay. <whisper>secret</whisper> done.');
});

test('tag level subtle drops non-subtle tags; none drops all', () => {
    assert.equal(toSpeechText('Ha [giggle] <sing-song>la la</sing-song> [laugh]', { tagLevel: 'subtle' }), 'Ha la la [laugh]');
    assert.equal(toSpeechText('Ha [laugh] <whisper>hi</whisper>', { tagLevel: 'none' }), 'Ha hi');
});

test('removes markdown, code, links, emoji, think blocks, name prefix', () => {
    const raw = '<think>plan the reply</think>Seraphina: **Hello** there! 😊 Check [this](http://x.y) and `code`.\n```js\nlet a=1\n```\n# Done';
    assert.equal(toSpeechText(raw, { charName: 'Seraphina' }), 'Hello there! Check this and code.\nDone');
});

test('streaming holds back unclosed action, tag, and think block', () => {
    assert.equal(toSpeechText('Hello. *looks aw', { final: false }), 'Hello. ');
    assert.equal(toSpeechText('Hello. <whisp', { final: false }), 'Hello. ');
    assert.equal(toSpeechText('Hello. [lau', { final: false }), 'Hello. ');
    assert.equal(toSpeechText('<think>hmm', { final: false }), '');
});

test('takeChunks: short first chunk, longer later chunks, flush on final', () => {
    const text = 'Hey there, stranger! It has been such a long time since we last talked, you know? I missed you. Tell me everything.';
    const a = takeChunks(text, { first: true, final: false });
    assert.deepEqual(a.chunks[0], 'Hey there, stranger!');
    const rest = text.slice(a.consumed);
    const b = takeChunks(rest, { final: true });
    assert.equal([...a.chunks, ...b.chunks].join(' '), text);
});

test('takeChunks does not split on abbreviations or decimals while streaming', () => {
    const r = takeChunks('Ask Mr. Smith about 3.5 percent. Then', { first: true, final: false });
    assert.deepEqual(r.chunks, ['Ask Mr. Smith about 3.5 percent.']);
});

test('takeChunks splits very long runs without punctuation', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const r = takeChunks(long, { final: false, maxChars: 100 });
    assert.ok(r.chunks.length >= 4);
    assert.ok(r.chunks.every(c => c.length <= 101));
});

test('balanceTags carries open wrapping tags across chunks', () => {
    const a = balanceTags('<whisper>It is a secret.', []);
    assert.equal(a.text, '<whisper>It is a secret.</whisper>');
    const b = balanceTags('Nobody knows.</whisper> Okay?', a.stack);
    assert.equal(b.text, '<whisper>Nobody knows.</whisper> Okay?');
    assert.deepEqual(b.stack, []);
    assert.equal(balanceTags('stray</soft> end', []).text, 'stray end');
});

test('SpeechTurn: streaming tokens produce each sentence exactly once', () => {
    const full = 'Oh! *giggles* You called. I was just thinking about you, actually. <whisper>Don\'t tell anyone.</whisper> So, what\'s up?';
    const turn = new SpeechTurn({});
    const spoken = [];
    for (let i = 1; i <= full.length; i += 3) spoken.push(...turn.update(full.slice(0, i)));
    spoken.push(...turn.update(full, true));
    assert.equal(spoken.join(' '), 'Oh! [giggle] You called. I was just thinking about you, actually. <whisper>Don\'t tell anyone.</whisper> So, what\'s up?');
    assert.deepEqual(turn.update(full + ' more', true), []);
});

test('SpeechTurn: re-anchors when final text differs from streamed text', () => {
    const turn = new SpeechTurn({});
    const first = turn.update('Hello there, my friend. How are', false);
    assert.deepEqual(first, ['Hello there, my friend.']);
    const rest = turn.update('Hello there, my friend! How are you doing today?', true);
    assert.deepEqual(rest, ['How are you doing today?']);
});

test('SpeechTurn: a reply streamed with "..." and saved with "…" loses no characters', () => {
    // Seen live: the second chunk began "ന്നായി", two characters short.
    const streamed = 'വീണ്ടും? അഞ്ചാമത്തെ വിളിയാണിതേ... നന്നായി പറഞ്ഞു കേട്കൂ, എന്താ';
    const saved = 'വീണ്ടും? അഞ്ചാമത്തെ വിളിയാണിതേ… നന്നായി പറഞ്ഞു കേട്കൂ, എന്താ വിഷമം?';
    const turn = new SpeechTurn({});
    const spoken = [];
    for (let i = 1; i <= streamed.length; i += 2) spoken.push(...turn.update(streamed.slice(0, i)));
    spoken.push(...turn.update(saved, true));
    assert.deepEqual(spoken, ['വീണ്ടും? അഞ്ചാമത്തെ വിളിയാണിതേ…', 'നന്നായി പറഞ്ഞു കേട്കൂ, എന്താ വിഷമം?']);
    assert.equal(toSpeechText('Wait.... what...?', { final: true }), 'Wait… what…?');
});

test('captionHtml escapes text and renders tags', () => {
    assert.equal(captionHtml('a <b> [laugh] <whisper>x</whisper>'), 'a &lt;b&gt; <span class="tv-tag">laugh</span> <span class="tv-wrap tv-wrap-whisper" title="whisper">x</span>');
});

test('decorateTagsHtml styles tags in rendered HTML, skips code and unknown tags', () => {
    const html = '<p><em>sighs</em> Honestly? [laughs] <whisper>But hearing you helps.</whisper> <b>ok</b> [OOC] &lt;soft&gt;hi&lt;/soft&gt;</p><pre><code>[laugh]</code></pre>';
    assert.equal(
        decorateTagsHtml(html),
        '<p><em>sighs</em> Honestly? <span class="tv-tag" title="Grok voice tag">laugh</span> <span class="tv-wrap" title="whisper">But hearing you helps.</span> <b>ok</b> [OOC] <span class="tv-wrap" title="soft">hi</span></p><pre><code>[laugh]</code></pre>',
    );
});

test('isSpeakable', () => {
    assert.ok(isSpeakable('[laugh]'));
    assert.ok(isSpeakable('Hi'));
    assert.ok(!isSpeakable('...'));
    assert.ok(!isSpeakable('<whisper></whisper>'));
});
