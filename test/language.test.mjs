import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLanguage, readsAsEnglish, spokenLanguage } from '../src/language.js';

// Romanised Malayalam, as a call actually came back: Latin letters, English nouns, not English.
const MANGLISH = 'Da, Ponnuye school-il nee vidikkuka? Ayyo, athu nannayirikkum... pakshe aa falt-il '
    + 'ninte car ille, daivame, aarum kanumo enikku bhayam aanu.';

test('a line written in its own script is taken at its word', () => {
    assert.equal(spokenLanguage('എനിക്ക് ഭയം ആണ്', 'en'), 'ml', 'Malayalam text beats a card set to English');
    assert.equal(spokenLanguage('Привет, как дела у тебя', 'en'), 'ru');
    assert.equal(spokenLanguage('こんにちは、元気ですか', 'en'), 'ja', 'kana settles it against the shared kanji block');
    assert.equal(spokenLanguage('我今天很好谢谢你', 'en'), 'zh');
});

test('a script shared by several languages leaves the setting alone', () => {
    // Devanagari is Hindi, Marathi and more, so a setting naming one of them is the better answer.
    assert.equal(spokenLanguage('मला तुझी आठवण येते', 'mr'), 'mr');
    assert.equal(spokenLanguage('मला तुझी आठवण येते', 'en'), 'hi', 'with nothing better to go on, the usual one');
});

test('romanised speech keeps the language it was romanised from', () => {
    assert.equal(spokenLanguage(MANGLISH, 'ml'), 'ml', 'reading this as English would be noise');
    assert.equal(spokenLanguage(MANGLISH, 'ml-IN'), 'ml-IN', 'the setting comes back exactly as it went in');
});

test('an English line overrides a setting for a language with its own script', () => {
    assert.equal(spokenLanguage('Okay, see you at six then.', 'ml'), 'en');
    assert.equal(spokenLanguage('I am at the house with her right now.', 'ml'), 'en');
    assert.equal(spokenLanguage('Okay, see you at six then.', 'de'), 'de',
        'German is written in the same letters, so one English-looking line proves nothing');
});

test('it corrects a line and never invents a language for one', () => {
    assert.equal(spokenLanguage('Hi.', 'ml'), 'ml', 'too short to tell');
    assert.equal(spokenLanguage('', 'ml'), 'ml');
    assert.equal(spokenLanguage(MANGLISH, ''), '', 'no setting, nothing claimed');
    assert.equal(spokenLanguage('[laugh] <whisper>', 'ml'), 'ml', 'speech tags are not the line');
});

test('speech tags do not tip the count towards English', () => {
    assert.equal(spokenLanguage(`[laugh] ${MANGLISH} <whisper>athu sheriyaanu</whisper>`, 'ml'), 'ml');
});

test('English is judged on function words, not on borrowed nouns', () => {
    assert.equal(readsAsEnglish(MANGLISH), false, 'school, car and falt are loanwords, not English');
    assert.equal(readsAsEnglish('I am at the house with her right now.'), true);
    assert.equal(readsAsEnglish('See you'), false, 'four words or fewer is a coin toss');
});

test('a region keeps its base for comparison', () => {
    assert.equal(baseLanguage('pt-BR'), 'pt');
    assert.equal(baseLanguage('ML_IN'), 'ml');
    assert.equal(baseLanguage(''), '');
});
