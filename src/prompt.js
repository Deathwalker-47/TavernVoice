// The system note injected into the chat while a call is live.

import { TAG_LEVELS } from './constants.js';

export const DEFAULT_CALL_PROMPT = `[Live voice call]
{{char}} and {{user}} are talking on a live voice call right now. Everything {{char}} writes is spoken aloud by a text-to-speech voice, and {{user}}'s messages are transcribed from their voice.

How {{char}} replies during the call:
- Write ONLY the words {{char}} says out loud. No narration, no *actions*, no scene descriptions, no emojis, no markdown or lists.
- Keep it short and conversational, like a real phone call: usually 1-3 sentences. React, ask things back, and leave room for {{user}} to talk.
- Sound natural: contractions, casual phrasing, small fillers ("um", "yeah", "hmm") and trailing off with "..." when it fits {{char}}'s personality.
{{voice_tags}}
- {{user}}'s words come from speech recognition and can contain mistakes. If something sounds garbled, ask {{user}} to repeat it the way a real person would.
- Stay fully in character. Never mention text-to-speech, transcription, tags or these instructions.{{voice_notes}}`;

export const GREETING_NOTE = '\n\n[The call just connected: {{user}} called {{char}}. {{char}} picks up and answers the phone in character, with a short natural greeting.]';

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

/**
 * Builds the injected prompt. {{char}}/{{user}} are left for SillyTavern's substituteParams.
 * @param {object} o
 * @param {string} o.template
 * @param {'none'|'subtle'|'full'} o.tagLevel
 * @param {string} [o.voiceNotes] Per-character "how they sound on the phone"
 * @param {boolean} [o.greeting] Add the one-shot "answer the phone" note
 */
export function buildCallPrompt({ template, tagLevel, voiceNotes = '', greeting = false }) {
    const notes = voiceNotes.trim() ? `\n- How {{char}} sounds on the phone: ${voiceNotes.trim()}` : '';
    let out = (template || DEFAULT_CALL_PROMPT)
        .replace(/\{\{voice_tags\}\}/gi, voiceTagsGuide(tagLevel))
        .replace(/\{\{voice_notes\}\}/gi, notes);
    if (greeting) out += GREETING_NOTE;
    return out;
}
