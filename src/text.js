// Turns raw LLM output into text that Grok TTS should speak, and slices it into
// sentence-sized chunks while the reply is still streaming.
// Pure functions only: this module is unit-tested under Node (see test/).

import { TAG_LEVELS, TAG_ALIASES, ACTION_SOUNDS } from './constants.js';

const ALL_INLINE = new Set(TAG_LEVELS.full.inline);
const ALL_WRAPPING = new Set(TAG_LEVELS.full.wrapping);

/** Normalizes a tag name ("Laughs", "long pause", "WHISPERS") to its official spelling. */
export function normalizeTagName(name) {
    const key = String(name).trim().toLowerCase().replace(/[_\s]+/g, ' ');
    if (TAG_ALIASES[key]) return TAG_ALIASES[key];
    return key.replace(/ /g, '-');
}

/** Maps a roleplay action like "laughs softly" to an inline tag, or null. */
export function actionToTag(action) {
    for (const [re, tag] of ACTION_SOUNDS) {
        if (re.test(action)) return tag;
    }
    return null;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts raw message text into speakable text with Grok speech tags.
 *
 * @param {string} raw Raw message (may be a partial, still-streaming message)
 * @param {object} [opts]
 * @param {'auto'|'quotes'|'all'} [opts.mode='auto'] auto: skip *actions*, read the rest.
 *        quotes: only read "quoted" speech (falls back to auto when there are no quotes).
 *        all: read everything, narration included.
 * @param {boolean} [opts.actionSounds=true] Turn *laughs* into [laugh] etc.
 * @param {'none'|'subtle'|'full'} [opts.tagLevel='full'] Which speech tags survive.
 * @param {string} [opts.charName] Character name, stripped when used as a "Name:" prefix.
 * @param {boolean} [opts.final=true] When false, unfinished constructs at the end are held back.
 * @returns {string}
 */
export function toSpeechText(raw, opts = {}) {
    const { mode = 'auto', actionSounds = true, tagLevel = 'full', charName = '', final = true } = opts;
    const level = TAG_LEVELS[tagLevel] ?? TAG_LEVELS.full;
    const inlineOk = new Set(level.inline);
    const wrapOk = new Set(level.wrapping);

    let t = String(raw ?? '').replace(/\r\n?/g, '\n');

    // Reasoning blocks, comments, code. Unclosed ones swallow the rest of the text.
    t = t.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, ' ');
    t = t.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '');
    t = t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!--[\s\S]*$/, '');
    t = t.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/, '');
    t = t.replace(/`([^`\n]*)`/g, '$1');

    // Images, links, bare URLs.
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    t = t.replace(/\[([^\]\n]+)\]\((?:[^)]*)\)/g, '$1');
    t = t.replace(/https?:\/\/\S+/g, ' ');

    // "Name: hello" speaker prefixes.
    if (charName) {
        t = t.replace(new RegExp(`^\\s*${escapeRegex(charName)}\\s*:\\s*`, 'gim'), '');
    }

    // Markdown structure.
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    t = t.replace(/^\s*>\s?/gm, '');
    t = t.replace(/^\s*(?:[-+]|\*(?=\s)|\d+\.)\s+/gm, '');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/~~([^~]+)~~/g, '$1');
    t = t.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1$2');

    // *Roleplay actions*.
    t = t.replace(/\*([^*]+)\*/g, (_, inner) => {
        if (mode === 'all') return ` ${inner} `;
        if (actionSounds) {
            const tag = actionToTag(inner);
            if (tag && inlineOk.has(tag)) return ` [${tag}] `;
        }
        return ' ';
    });
    // An unclosed "*" while streaming means we are inside an action: hold the rest back.
    const strayStar = t.indexOf('*');
    if (strayStar !== -1) {
        t = final ? t.replace(/\*/g, '') : t.slice(0, strayStar);
    }

    // (OOC: ...) asides.
    t = t.replace(/\(\s*OOC\b[^)]*\)/gi, ' ');
    if (!final) t = t.replace(/\(\s*OOC\b[^)]*$/i, '');

    // Quoted speech only.
    if (mode === 'quotes') {
        const quoteRe = /"([^"]*)("|$)|“([^”]*)(”|$)|«([^»]*)(»|$)/g;
        const spans = [];
        let m;
        while ((m = quoteRe.exec(t)) !== null) {
            if (m[0] === '') { quoteRe.lastIndex++; continue; }
            spans.push(m[1] ?? m[3] ?? m[5] ?? '');
        }
        if (spans.length) {
            t = spans.join(' \n');
        } else if (!final) {
            t = ''; // No quote yet: wait, the speech may still be coming.
        }
    }

    // Hold back a half-received tag at the very end ("<whisp", "[lau").
    if (!final) {
        t = t.replace(/<[^<>\n]{0,30}$/, '').replace(/\[[^[\]\n]{0,40}$/, '');
    }

    // Wrapping tags: keep allowed ones (normalized), drop all other HTML tags but keep their text.
    t = t.replace(/<\s*(\/?)\s*([a-zA-Z][^<>]*?)\s*\/?\s*>/g, (_, slash, inner) => {
        const tag = /^[\w\s-]{1,30}$/.test(inner) ? normalizeTagName(inner) : '';
        return wrapOk.has(tag) ? `<${slash}${tag}>` : ' ';
    });

    // Inline tags: keep allowed ones; drop any other short [bracketed] aside (stage directions, OOC).
    t = t.replace(/\[([^\]\n]{1,300})\]/g, (_, name) => {
        const tag = normalizeTagName(name);
        return inlineOk.has(tag) ? ` [${tag}] ` : ' ';
    });

    // Quotes are formatting, not speech. Emoji and pictographs can't be voiced.
    t = t.replace(/["“”«»]/g, '');
    t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '');

    // Empty wrappers, whitespace, punctuation spacing.
    t = t.replace(/<([a-z-]+)>\s*<\/\1>/g, ' ');
    t = t.replace(/[ \t ]+/g, ' ');
    t = t.replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n');
    t = t.replace(/ +([,.!?;:…])/g, '$1');
    t = t.replace(/^\s+/, '');
    if (final) t = t.trim();
    return t;
}

/** True when a chunk has something audible: words, numbers or an inline sound tag. */
export function isSpeakable(chunk) {
    const withoutTags = chunk.replace(/<\/?[a-z-]+>/g, '');
    return /[\p{L}\p{N}]/u.test(withoutTags.replace(/\[[a-z-]+\]/g, '')) || /\[[a-z-]+\]/.test(withoutTags);
}

const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|jr|sr|prof|mt)\.$/i;

/**
 * Finds the indexes right after each sentence boundary in `text`.
 * While streaming, a boundary only counts once whitespace follows it,
 * so "3." in "3.5" or a half-streamed "Mr." is not split early.
 */
function sentenceBoundaries(text, final) {
    const out = [];
    const re = /[.!?…。！？]+["'”’)\]]*(?:<\/[a-z-]+>)?(?=\s|$)|\n/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const end = m.index + m[0].length;
        if (end === text.length && !final && m[0] !== '\n') continue;
        if (m[0] !== '\n' && ABBREVIATIONS.test(text.slice(Math.max(0, end - 6), end))) continue;
        out.push(end);
    }
    return out;
}

/**
 * Slices ready-to-speak chunks off the front of `text`.
 * The first chunk of a reply is kept short so audio starts fast; later chunks
 * are longer, which gives the TTS model more context for natural prosody.
 *
 * @returns {{chunks: string[], consumed: number}}
 */
export function takeChunks(text, { final = false, first = false, firstMinChars = 12, minChars = 70, maxChars = 280 } = {}) {
    const chunks = [];
    let start = 0;
    const bounds = sentenceBoundaries(text, final);
    const push = (end) => {
        const chunk = text.slice(start, end).replace(/\s*\n\s*/g, ' ').trim();
        if (chunk && isSpeakable(chunk)) chunks.push(chunk);
        start = end;
    };

    for (const b of bounds) {
        const min = first && chunks.length === 0 ? firstMinChars : minChars;
        if (b - start >= min) push(b);
    }

    // A long run with no sentence end: split at a comma or space so audio keeps flowing.
    while (text.length - start > maxChars) {
        const window = text.slice(start, start + maxChars);
        let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' — '));
        if (cut < maxChars / 3) cut = window.lastIndexOf(' ');
        if (cut <= 0) cut = maxChars;
        push(start + cut + 1);
    }

    if (final && start < text.length) push(text.length);
    return { chunks, consumed: start };
}

/**
 * Makes each chunk self-contained: a <whisper> opened in one chunk and closed in
 * the next is closed at the end of the first and re-opened at the start of the second.
 *
 * @param {string} chunk
 * @param {string[]} openStack Tags still open from the previous chunk
 * @returns {{text: string, stack: string[]}}
 */
export function balanceTags(chunk, openStack = []) {
    const stack = [...openStack];
    const body = chunk.replace(/<(\/?)([a-z-]+)>/g, (tag, slash, name) => {
        if (!slash) {
            stack.push(name);
            return tag;
        }
        const idx = stack.lastIndexOf(name);
        if (idx === -1) return ''; // closing a tag that was never opened
        stack.splice(idx, 1);
        return tag;
    });
    const prefix = openStack.map(n => `<${n}>`).join('');
    const suffix = [...stack].reverse().map(n => `</${n}>`).join('');
    return { text: prefix + body + suffix, stack };
}

/**
 * Tracks one assistant reply as it streams in and hands out new chunks to speak.
 * Call update() with the full text so far on every token, then once more with final=true.
 */
export class SpeechTurn {
    constructor(opts = {}) {
        this.opts = opts;
        this.emitted = 0;      // chars of cleaned text already handed out
        this.clean = '';       // cleaned text at the last update
        this.stack = [];       // wrapping tags open across chunk boundaries
        this.count = 0;        // chunks handed out
        this.done = false;
    }

    /**
     * @param {string} raw Full raw text so far
     * @param {boolean} [final=false]
     * @returns {string[]} New chunks to speak, in order
     */
    update(raw, final = false) {
        if (this.done) return [];
        const clean = toSpeechText(raw, { ...this.opts, final });
        let from = this.emitted;

        // The final text can differ from the streamed text (regex scripts, trimming).
        // Re-anchor on the tail of what we already spoke instead of re-speaking it.
        if (this.emitted > 0 && clean.slice(0, this.emitted) !== this.clean.slice(0, this.emitted)) {
            const tail = this.clean.slice(Math.max(0, this.emitted - 24), this.emitted);
            const at = tail ? clean.indexOf(tail) : -1;
            from = at === -1 ? Math.min(this.emitted, clean.length) : at + tail.length;
        }

        const { chunks, consumed } = takeChunks(clean.slice(from), {
            final,
            first: this.count === 0,
            ...this.opts.chunking,
        });
        this.emitted = from + consumed;
        this.clean = clean;

        const out = [];
        for (const c of chunks) {
            const balanced = balanceTags(c, this.stack);
            this.stack = balanced.stack;
            out.push(balanced.text);
            this.count++;
        }
        if (final) this.done = true;
        return out;
    }
}

/** Text for captions: speech tags rendered as small markers, everything HTML-escaped. */
export function captionHtml(chunk) {
    const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return esc(chunk)
        .replace(/\[([a-z-]+)\]/g, '<span class="tv-tag">$1</span>')
        .replace(/&lt;([a-z-]+)&gt;/g, (m, n) => ALL_WRAPPING.has(n) ? `<span class="tv-wrap tv-wrap-${n}" title="${n}">` : m)
        .replace(/&lt;\/([a-z-]+)&gt;/g, (m, n) => ALL_WRAPPING.has(n) ? '</span>' : m);
}

/**
 * Chat display: turns voice tags in rendered message HTML into styled spans.
 * Runs as a SillyTavern MessageFormatter hook, before DOMPurify (which would otherwise
 * drop <whisper> and friends, hiding that the line was whispered).
 * Note: SillyTavern prefixes message classes with "custom-", so CSS targets .custom-tv-*.
 */
export function decorateTagsHtml(html) {
    const parts = String(html).split(/(<[^>]*>)/);
    let codeDepth = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i % 2 === 1) {
            if (/^<(code|pre)\b/i.test(part)) codeDepth++;
            else if (/^<\/(code|pre)>/i.test(part)) codeDepth = Math.max(0, codeDepth - 1);
            else if (!codeDepth) {
                const m = /^<\s*(\/?)\s*([a-zA-Z][\w -]{0,30}?)\s*>$/.exec(part);
                const tag = m ? normalizeTagName(m[2]) : '';
                if (ALL_WRAPPING.has(tag)) parts[i] = m[1] ? '</span>' : `<span class="tv-wrap" title="${tag}">`;
            }
            continue;
        }
        if (codeDepth) continue;
        parts[i] = part
            // Showdown sometimes leaves wrapping tags escaped.
            .replace(/&lt;\s*(\/?)\s*([a-zA-Z][\w -]{0,30}?)\s*&gt;/g, (match, slash, name) => {
                const tag = normalizeTagName(name);
                if (!ALL_WRAPPING.has(tag)) return match;
                return slash ? '</span>' : `<span class="tv-wrap" title="${tag}">`;
            })
            .replace(/\[([a-zA-Z][a-zA-Z _-]{1,20})\]/g, (match, name) => {
                const tag = normalizeTagName(name);
                return ALL_INLINE.has(tag) ? `<span class="tv-tag" title="Grok voice tag">${tag}</span>` : match;
            });
    }
    return parts.join('');
}

export { ALL_INLINE, ALL_WRAPPING };
