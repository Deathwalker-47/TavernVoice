// The people on a story card who can answer a call, each with their own voice and brief.
// Stored on the card as tavern_voice.cast = [{ name, voice, about, notes }].

import { parseCallees } from './prompt.js';

/** "Ask me each time I call" in the Who answers dropdown. */
export const ASK = 'ask';

const clean = (p) => ({
    name: String(p?.name ?? '').trim(),
    voice: String(p?.voice ?? '').trim(),
    about: String(p?.about ?? '').trim(),
    notes: String(p?.notes ?? '').trim(),
});

/** The card's people, reading the older comma-separated "callees" text when there is no list yet. */
export function castOf(cfg) {
    const list = Array.isArray(cfg?.cast) && cfg.cast.length
        ? cfg.cast
        : parseCallees(cfg?.callees).map(name => ({ name }));
    const seen = new Set();
    return list.map(clean).filter((p) => {
        const key = p.name.toLowerCase();
        if (!p.name || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Everyone who could pick up, in the order the call popup offers them: the card's own character
 * first, then the rest of the story. The card is always a choice. A cast entry carrying the
 * card's own name is that same character, so it lends the card's choice its voice and brief
 * rather than appearing a second time.
 */
export function calleeChoices(cfg, cardName = '') {
    const cast = castOf(cfg);
    const self = String(cardName ?? '').trim();
    const own = cast.find(p => p.name.toLowerCase() === self.toLowerCase()) || null;
    return [{ name: self, person: own, card: true },
        ...cast.filter(p => p !== own).map(p => ({ name: p.name, person: p, card: false }))];
}

const answered = (choice) => (choice?.person ? { person: choice.person } : {});

/**
 * Who picks up: { ask: true } to choose at call time, { person } for someone on the list,
 * or {} for the card itself. One side character is still a question, because the card's own
 * character is the other answer: it used to pick up every call on a card whose own character
 * could then never be reached.
 */
export function whoAnswers(cfg, cardName = '') {
    const choices = calleeChoices(cfg, cardName);
    const setting = String(cfg?.answers ?? ASK);
    if (setting === '') return answered(choices[0]);
    if (setting !== ASK) {
        const named = choices.find(ch => !ch.card && ch.name.toLowerCase() === setting.toLowerCase());
        if (named) return answered(named);
    }
    return choices.length > 1 ? { ask: true } : answered(choices[0]);
}

/** The card's voice settings with one person's own voice and notes on top. */
export function voiceFor(cfg, person) {
    if (!person) return cfg;
    return { ...cfg, voice: person.voice || cfg?.voice || '', notes: person.notes || cfg?.notes || '' };
}

/**
 * Adds people found by the helper to the list. What the user already wrote is kept;
 * only empty fields are filled in.
 */
export function mergeCast(current, found) {
    const out = castOf({ cast: current });
    for (const raw of found ?? []) {
        const p = clean({ ...raw, notes: raw?.notes ?? raw?.sound });
        if (!p.name) continue;
        const have = out.find(x => x.name.toLowerCase() === p.name.toLowerCase());
        if (!have) {
            out.push(p);
            continue;
        }
        for (const key of ['voice', 'about', 'notes']) have[key] ||= p[key];
    }
    return out;
}
