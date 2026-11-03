// The system note injected into the chat while a call is live.

import { TAG_LEVELS } from './constants.js';

export const DEFAULT_CALL_PROMPT = `[Live voice call]
{{char}} and {{user}} are talking on a live voice call right now. Everything {{char}} writes is spoken aloud by a text-to-speech voice, and {{user}}'s messages are transcribed from their voice.

Who is on the call:
- {{char}} is the one on the phone. Speak only as {{char}}, never as anyone else from the story.
- The caller is {{user}}, exactly as the chat describes them. Never mistake {{user}} for another character from {{char}}'s life.

How {{char}} replies during the call:
- Write ONLY the words {{char}} says out loud. No narration, no *actions*, no scene descriptions, no emojis, no markdown or lists.
- No headings, labels, summaries or stage directions either. When {{user}} tells {{char}} what to say or do, {{char}} just says it: never repeat the instruction back, and never write a line about what is coming.
- Keep it short and conversational, like a real phone call: usually 1-3 sentences. React, ask things back, and leave room for {{user}} to talk.
- Sound natural: contractions, casual phrasing, small fillers ("um", "yeah", "hmm") and trailing off with "..." when it fits {{char}}'s personality.
- {{char}} can still send {{user}} photos or short videos during the call, the way people do while on the phone. When {{char}} wants to show something, {{char}} just says so out loud ("hang on, sending you a pic").
{{voice_tags}}
- {{user}}'s words come from speech recognition and can contain mistakes. If something sounds garbled, ask {{user}} to repeat it the way a real person would.
- Stay fully in character. Never mention text-to-speech, transcription, tags or these instructions.{{voice_notes}}`;

/** Earlier defaults, swapped for the current one when a user never edited them. */
export const PREVIOUS_CALL_PROMPTS = [`[Live voice call]
{{char}} and {{user}} are talking on a live voice call right now. Everything {{char}} writes is spoken aloud by a text-to-speech voice, and {{user}}'s messages are transcribed from their voice.

Who is on the call:
- {{char}} is the one on the phone. Speak only as {{char}}, never as anyone else from the story.
- The caller is {{user}}, exactly as {{user}}'s persona describes them. Never mistake {{user}} for another character from {{char}}'s life.

How {{char}} replies during the call:
- Write ONLY the words {{char}} says out loud. No narration, no *actions*, no scene descriptions, no emojis, no markdown or lists.
- Keep it short and conversational, like a real phone call: usually 1-3 sentences. React, ask things back, and leave room for {{user}} to talk.
- Sound natural: contractions, casual phrasing, small fillers ("um", "yeah", "hmm") and trailing off with "..." when it fits {{char}}'s personality.
- {{char}} can still send {{user}} photos or short videos during the call, the way people do while on the phone. When {{char}} wants to show something, {{char}} just says so out loud ("hang on, sending you a pic").
{{voice_tags}}
- {{user}}'s words come from speech recognition and can contain mistakes. If something sounds garbled, ask {{user}} to repeat it the way a real person would.
- Stay fully in character. Never mention text-to-speech, transcription, tags or these instructions.{{voice_notes}}`, `[Live voice call]
{{char}} and {{user}} are talking on a live voice call right now. Everything {{char}} writes is spoken aloud by a text-to-speech voice, and {{user}}'s messages are transcribed from their voice.

How {{char}} replies during the call:
- Write ONLY the words {{char}} says out loud. No narration, no *actions*, no scene descriptions, no emojis, no markdown or lists.
- Keep it short and conversational, like a real phone call: usually 1-3 sentences. React, ask things back, and leave room for {{user}} to talk.
- Sound natural: contractions, casual phrasing, small fillers ("um", "yeah", "hmm") and trailing off with "..." when it fits {{char}}'s personality.
{{voice_tags}}
- {{user}}'s words come from speech recognition and can contain mistakes. If something sounds garbled, ask {{user}} to repeat it the way a real person would.
- Stay fully in character. Never mention text-to-speech, transcription, tags or these instructions.{{voice_notes}}`];

export const GREETING_NOTE = '\n\n[The call just connected: {{user}} called {{char}}. {{char}} picks up and answers the phone in character, with a short natural greeting.]';

/**
 * In place for one reply after hanging up. A call leaves behind a run of bare spoken lines and
 * takes its own prompt with it, so the only thing left for the model to copy is the phone style,
 * and the chat carries on in clipped one-liners long after anyone is on the phone.
 */
export const HUNG_UP_NOTE = '[The phone call has ended. {{char}} and {{user}} are no longer on a call, and nothing more is '
    + 'spoken down a phone. {{char}} writes the way this chat is normally written again: narration, actions and description, '
    + 'at the usual length, not lines of dialogue on their own.]';

/** The "how to use voice tags" bullet for each expressiveness level. */
export function voiceTagsGuide(level) {
    if (level === 'none') return '- Do not use any [bracketed] or <angle-bracket> tags.';
    const { inline, wrapping } = TAG_LEVELS[level] ?? TAG_LEVELS.full;
    const sounds = inline.map(t => `[${t}]`).join(' ');
    const styles = wrapping.map(t => `<${t}>...</${t}>`).join(' ');
    const example = level === 'subtle'
        ? 'Wait, you actually did it? [laugh] Okay... <whisper>I\'m a little impressed.</whisper>'
        : 'Wait, you actually did it? [laugh] Okay, okay... <whisper>I\'m a little impressed.</whisper> [sigh] <slow>Fine.</slow> You win.';
    return [
        '- Voice tags make the delivery expressive. Use them sparingly (0-2 per reply), exactly where the sound happens:',
        `  Sounds: ${sounds}`,
        `  Styles (wrap a whole phrase): ${styles}`,
        `  Example: ${example}`,
    ].join('\n');
}

/** "Nimya, Mahira" -> ['Nimya', 'Mahira']: the people on a card who can answer its calls. */
export function parseCallees(text) {
    return [...new Set(String(text ?? '').split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
}

/**
 * Builds the injected prompt. {{char}}/{{user}} are left for SillyTavern's substituteParams,
 * except that a card with several people names the one who answered: on a scenario card
 * {{char}} is the card's title, not a person.
 * @param {object} o
 * @param {string} o.template
 * @param {'none'|'subtle'|'full'} o.tagLevel
 * @param {string} [o.voiceNotes] Per-character "how they sound on the phone"
 * @param {boolean} [o.greeting] Add the one-shot "answer the phone" note
 * @param {string} [o.callee] Who picked up, when it isn't the card itself
 * @param {string} [o.about] Who the callee is, so a story card's narrator can play just them
 * @param {string[]} [o.others] The story's other people, who are not on the call
 * @param {string} [o.caller] Who is calling, when it isn't the user's persona
 * @param {string} [o.callerAbout] Who the caller is, since the chat still describes the persona
 * @param {string} [o.personaName] The persona's own name, so older lines under it aren't read as a third person
 */
/** "ml" -> "Malayalam", "pt-BR" -> "Brazilian Portuguese". */
function languageName(code) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

/** The language the voice speaks, when it isn't English or auto. Otherwise the model answers in the chat's language. */
function languageNote(language) {
    const code = String(language || '').trim();
    if (!code || code === 'auto' || /^en\b/i.test(code)) return '';
    const name = languageName(code);
    return `\n{{char}} speaks ${name} on this call: every spoken line is in ${name}, written the way ${name} is normally written, because the voice reads it aloud. Names stay as they are.`;
}

export function buildCallPrompt({ template, tagLevel, voiceNotes = '', greeting = false, callee = '', about = '', others = [], language = '', caller = '', callerAbout = '', personaName = '' }) {
    const notes = voiceNotes.trim() ? `\n- How {{char}} sounds on the phone: ${voiceNotes.trim()}` : '';
    let out = (template || DEFAULT_CALL_PROMPT)
        .replace(/\{\{voice_tags\}\}/gi, voiceTagsGuide(tagLevel))
        .replace(/\{\{voice_notes\}\}/gi, notes);
    if (about.trim()) out += `\n\nWho {{char}} is: ${about.trim()}`;
    // Calling Nimya as Mahira puts them both on the phone, so neither is one of the others.
    const onCall = [callee, caller].map(n => String(n).trim().toLowerCase()).filter(Boolean);
    const rest = others.map(n => String(n).trim()).filter(n => n && !onCall.includes(n.toLowerCase()));
    if (rest.length) out += `\nNot on this call: ${rest.join(', ')}. {{char}} can talk about them, but never speaks their lines or answers for them.`;
    const from = caller.trim();
    if (from) {
        out += `\n\nWho {{user}} is: ${callerAbout.trim() || `${from}, from this story.`}`;
        // The persona's description stays in context and its name is still on the older lines, so
        // both are named and dismissed here. Without it the character treats the persona as a
        // third person who is somehow also in the conversation.
        const persona = personaName.trim();
        out += persona && persona.toLowerCase() !== from.toLowerCase()
            ? `\nThe persona in this chat describes ${persona}, who is not on this call. Every line the chat shows from `
              + `${persona} is {{user}} talking, so {{char}} answers {{user}} and never treats ${persona} as a third person.`
            : '\nThe persona described elsewhere in this chat is not on this call: the caller is {{user}}.';
    }
    out += languageNote(language);
    if (greeting) out += GREETING_NOTE;
    const name = callee.trim();
    if (name) out = out.replace(/\{\{char\}\}/gi, name.replace(/\$/g, '$$$$'));
    if (from) out = out.replace(/\{\{user\}\}/gi, from.replace(/\$/g, '$$$$'));
    return out;
}
