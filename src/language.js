// What language a line is actually in, so the voice is told the truth about the text in front of it.
//
// The Language setting says what a character usually speaks. It is not always what they just said:
// a card set to Malayalam still gets the odd English sentence, and a wrong code is worse than none,
// because the voice pronounces the letters by the rules of a language they were not written in.

/**
 * Scripts that settle the question by themselves. A script is not a language, so each one lists
 * every language commonly written in it, most common first. When the setting already names one of
 * them it wins, being the more specific of the two: Marathi and Hindi share Devanagari, and
 * answering "Hindi" to a card set to Marathi would be worse than the answer it was given.
 */
const SCRIPTS = [
    ['ml', /[\u0D00-\u0D7F]/g],
    ['ta', /[\u0B80-\u0BFF]/g],
    ['te', /[\u0C00-\u0C7F]/g],
    ['kn', /[\u0C80-\u0CFF]/g],
    ['si', /[\u0D80-\u0DFF]/g],
    ['bn as', /[\u0980-\u09FF]/g],
    ['gu', /[\u0A80-\u0AFF]/g],
    ['pa', /[\u0A00-\u0A7F]/g],
    ['or', /[\u0B00-\u0B7F]/g],
    ['hi mr ne sa kok mai bho', /[\u0900-\u097F]/g],
    ['ar fa ur ps sd ku ug', /[\u0600-\u06FF\u0750-\u077F]/g],
    ['he yi', /[\u0590-\u05FF]/g],
    ['ru uk bg sr mk be kk ky mn tg', /[\u0400-\u04FF]/g],
    ['el', /[\u0370-\u03FF]/g],
    ['th', /[\u0E00-\u0E7F]/g],
    ['ka', /[\u10A0-\u10FF]/g],
    ['hy', /[\u0530-\u058F]/g],
    ['ko', /[\uAC00-\uD7AF\u1100-\u11FF]/g],
    ['ja', /[\u3040-\u30FF]/g],
    ['zh', /[\u4E00-\u9FFF]/g],
];

const KANA = /[\u3040-\u30FF]/g;

/** Every language above: the ones a line in Latin letters cannot simply be. */
const NON_LATIN = new Set(SCRIPTS.flatMap(([codes]) => codes.split(' ')));

/**
 * Function words, not vocabulary. Romanised Indian-language speech is full of English nouns
 * ("school", "car", "office"), so counting those would call it English; nobody borrows "the".
 */
const ENGLISH = new Set(('a an and are as at be been but by can could did do does for from had has have he her him his '
    + 'how i if in is it its just me my not of on or our she should so that the their them then there these they this '
    + 'to was we were what when where which who why will with would you your').split(' '));

export const baseLanguage = (code) => String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];

/** Whether a line in Latin letters reads as English rather than as something romanised. */
export function readsAsEnglish(text) {
    const words = String(text ?? '').toLowerCase().match(/[a-z']+/g) || [];
    if (words.length < 5) return false;          // too short to tell, and a wrong guess is costly
    return words.filter(w => ENGLISH.has(w)).length / words.length >= 0.3;
}

/**
 * The language code to hand the voice for this line, given what the character is set to speak.
 *
 * Returns `configured` unchanged, spelling and region and all, whenever the text does not clearly
 * say otherwise. It can correct a line; it never invents a language for one.
 *
 * @param {string} text The line about to be spoken, speech tags and all
 * @param {string} [configured] The character's Language setting, e.g. "ml" or "pt-BR"
 * @returns {string}
 */
export function spokenLanguage(text, configured = '') {
    const clean = String(text ?? '').replace(/\[[^\]]*\]|<[^>]*>/g, ' ');
    const letters = (clean.match(/\p{L}/gu) || []).length;
    if (letters < 4) return configured;
    const base = baseLanguage(configured);

    let best = '';
    let most = 0;
    for (const [codes, re] of SCRIPTS) {
        const n = (clean.match(re) || []).length;
        if (n > most) [best, most] = [codes, n];
    }
    if (most / letters >= 0.2) {
        // Japanese is mostly kanji, which is the block Chinese uses; any kana settles it.
        const family = (best === 'zh' && (clean.match(KANA) || []).length >= 2 ? 'ja' : best).split(' ');
        return family.includes(base) ? configured : family[0];
    }

    // Latin letters. They are either English or something written in them, and only a setting for
    // a language with its own script makes that an open question worth answering.
    if (!NON_LATIN.has(base)) return configured;
    return readsAsEnglish(clean) ? 'en' : configured;
}
