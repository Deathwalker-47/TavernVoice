// TavernVoice: phone-style voice calls with your character. xAI Grok listens; Grok, ElevenLabs, HeyGen or Cartesia voices speak.
// Entry point loaded by SillyTavern (see manifest.json).

import {
    EXTENSION_KEY, PROMPT_KEY, DEFAULT_API_BASE, DEFAULT_ELEVEN_BASE, DEFAULT_HEYGEN_BASE, DEFAULT_CARTESIA_BASE,
    ELEVEN_MODELS, CARTESIA_MODELS, FALLBACK_VOICES, LANGUAGES, MORE_LANGUAGES,
} from './src/constants.js';
import { XaiClient, SttStream } from './src/xai.js';
import { ElevenLabsClient } from './src/elevenlabs.js';
import { HeyGenClient } from './src/heygen.js';
import { CartesiaClient } from './src/cartesia.js';
import { PROVIDERS, VoiceRouter, parseVoice } from './src/voices.js';
import { getAudioContext, MicInput, SpeechPlayer, Sounds } from './src/audio.js';
import { encodeWav } from './src/dsp.js';
import { SpeechTurn, captionHtml, decorateTagsHtml, isSpeakable, toSpeechText } from './src/text.js';
import { DEFAULT_CALL_PROMPT, PREVIOUS_CALL_PROMPTS, buildCallPrompt } from './src/prompt.js';
import { CallUI } from './src/ui.js';
import { ASK, calleeChoices, callerChoices, castOf, mergeCast, voiceFor, whoAnswers } from './src/cast.js';

const ctx = () => SillyTavern.getContext();
const TAG = '[TavernVoice]';

const DEFAULTS = Object.freeze({
    apiKey: '',
    apiBase: DEFAULT_API_BASE,
    // More voices: ElevenLabs, HeyGen and Cartesia speak languages Grok doesn't, such as Malayalam.
    elevenKey: '',
    elevenBase: DEFAULT_ELEVEN_BASE,
    elevenModel: 'eleven_v4_turbo',
    heygenKey: '',
    heygenBase: DEFAULT_HEYGEN_BASE,
    heygenLanguages: 'Malayalam',  // HeyGen's library is huge, so only these languages are listed
    cartesiaKey: '',
    cartesiaBase: DEFAULT_CARTESIA_BASE,
    cartesiaModel: 'sonic-3.6',
    cartesiaLanguages: 'Malayalam',  // besides your own voices, the public ones Cartesia suggests for these
    defaultVoice: 'eve',
    labText: 'Hi! This is how I sound on a call. [laugh] <whisper>Pretty nice, right?</whisper>',
    language: 'en',
    speed: 1,
    inputMode: 'open',        // open | ptt
    sttMode: 'auto',          // auto (stream, fall back to batch) | stream | batch
    micDeviceId: '',
    sensitivity: 60,
    endSilenceMs: 800,
    smartTurn: true,
    bargeIn: true,
    pttKey: 'Backquote',
    speakMode: 'auto',        // auto | quotes | all
    actionSounds: true,
    tagLevel: 'full',         // none | subtle | full
    volume: 1,
    greet: true,
    ring: true,
    logCalls: true,
    injectPrompt: true,
    promptDepth: 1,
    promptTemplate: DEFAULT_CALL_PROMPT,
    captions: true,
    prettifyTags: true,
    debug: false,
    // Voice director: the Flux bridge's helper LLM adds the speech tags per sentence.
    helperTags: false,
    helperBridgeUrl: '',      // empty = Media Studio's bridge URL, else Image Generation's SD URL
    helperBridgeToken: '',
    helperModel: 'z-ai/glm-5.3-flash-uncensored',
    helperFirstMs: 1500,      // longest wait for the first sentence's tags before speaking it plain
});

const CHAR_DEFAULTS = Object.freeze({ enabled: false, voice: '', language: '', speed: '', notes: '', callees: '', cast: [], answers: ASK });

function settings() {
    const all = ctx().extensionSettings;
    all[EXTENSION_KEY] ??= {};
    const s = all[EXTENSION_KEY];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
    if (s.helperModel === 'gemini-2.5-flash-lite') s.helperModel = DEFAULTS.helperModel; // old default filters adult lines
    if (PREVIOUS_CALL_PROMPTS.includes(s.promptTemplate)) s.promptTemplate = DEFAULT_CALL_PROMPT; // never edited: take the new one
    return s;
}

const saveSettings = () => ctx().saveSettingsDebounced();
const log = (...args) => settings().debug && console.log(TAG, ...args);

// ---------------------------------------------------------------------------
// API key & client
// ---------------------------------------------------------------------------

let stSecretCache;

/** Falls back to the xAI key saved in SillyTavern's API connections (needs allowKeysExposure). */
async function readStSecret() {
    if (stSecretCache !== undefined) return stSecretCache;
    try {
        const res = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ key: 'api_key_xai' }),
        });
        stSecretCache = res.ok ? ((await res.json())?.value ?? '') : '';
    } catch {
        stSecretCache = '';
    }
    return stSecretCache;
}

async function getConfig() {
    const s = settings();
    const key = s.apiKey?.trim() || await readStSecret();
    return { key, base: s.apiBase?.trim() || DEFAULT_API_BASE };
}

const client = new XaiClient(getConfig);
const router = new VoiceRouter({
    xai: client,
    elevenlabs: new ElevenLabsClient(async () => {
        const s = settings();
        return { key: s.elevenKey?.trim(), base: s.elevenBase?.trim(), model: s.elevenModel };
    }),
    heygen: new HeyGenClient(async () => {
        const s = settings();
        return { key: s.heygenKey?.trim(), base: s.heygenBase?.trim() };
    }),
    cartesia: new CartesiaClient(async () => {
        const s = settings();
        return { key: s.cartesiaKey?.trim(), base: s.cartesiaBase?.trim(), model: s.cartesiaModel };
    }),
}, {
    elevenModel: () => settings().elevenModel,
    heygenLanguages: () => String(settings().heygenLanguages || '').split(',').map(l => l.trim()).filter(Boolean),
    cartesiaLanguages: () => String(settings().cartesiaLanguages || '').split(',').map(l => l.trim()).filter(Boolean),
});

/** Whether a provider's key is set (xAI can also borrow SillyTavern's own key). */
async function hasKey(provider) {
    const s = settings();
    if (provider === 'elevenlabs') return !!s.elevenKey?.trim();
    if (provider === 'heygen') return !!s.heygenKey?.trim();
    if (provider === 'cartesia') return !!s.cartesiaKey?.trim();
    return !!(await getConfig()).key;
}

let voiceList = FALLBACK_VOICES.map(v => ({ ...v, provider: 'xai' }));
/** Sentinel <option> value that opens the custom voice ID prompt. */
const CUSTOM_VOICE = '__custom__';

// ---------------------------------------------------------------------------
// Voice director: speech tags from the Flux bridge's helper LLM
// ---------------------------------------------------------------------------

/** Bridge URL: own setting, else Media Studio's, else Image Generation's SD WebUI URL. */
function helperBase() {
    const s = settings();
    const all = ctx().extensionSettings;
    const raw = s.helperBridgeUrl?.trim() || all?.flux_media?.bridgeUrl?.trim() || all?.sd?.auto_url?.trim() || 'http://localhost:7861';
    return raw.replace(/\/sdapi\/v1\/txt2img\/?$/, '').replace(/\/+$/, '');
}

function helperHeaders() {
    const token = settings().helperBridgeToken?.trim() || ctx().extensionSettings?.flux_media?.bridgeToken?.trim();
    return { 'Content-Type': 'application/json', ...(token ? { 'X-Edit-Token': token } : {}) };
}

function lastUserLine() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i].is_user) return String(chat[i].mes || '').slice(-300);
    return '';
}

/**
 * Asks the bridge helper to add speech tags to one sentence. Never throws and never
 * delays past timeoutMs, or past `until` when given: on any problem the sentence is
 * spoken as it was.
 */
async function helperTag(text, { char = '', context = '', timeoutMs = 1500, until = null } = {}) {
    const s = settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    until?.then(() => controller.abort());
    try {
        const res = await fetch(`${helperBase()}/helper/voice-tags`, {
            method: 'POST',
            headers: helperHeaders(),
            body: JSON.stringify({ text, char, tag_level: s.tagLevel, context, model: s.helperModel || undefined }),
            signal: controller.signal,
        });
        if (!res.ok) return text;
        const data = await res.json();
        if (!data?.text || data.error) return text;
        // Re-run our own cleanup so only official, allowed tags reach the voice.
        const cleaned = toSpeechText(data.text, { mode: 'all', actionSounds: false, tagLevel: s.tagLevel });
        return isSpeakable(cleaned) ? cleaned : text;
    } catch {
        return text; // timed out or unreachable
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Per-character config, stored on the card at data.extensions.tavern_voice
// ---------------------------------------------------------------------------

async function getCharVoice(chid) {
    const c = ctx();
    if (chid === undefined || chid === null || !c.characters[chid]) return null;
    await c.unshallowCharacter?.(chid); // lazy-loaded cards don't carry extension fields
    return { ...CHAR_DEFAULTS, ...(c.characters[chid]?.data?.extensions?.[EXTENSION_KEY] ?? {}) };
}

let charWrites = Promise.resolve();

/**
 * Read-modify-write of the card field. Writes are queued so quick successive edits
 * (e.g. toggling enable then picking a voice) each build on the previous one.
 */
function setCharVoice(chid, patch) {
    const run = charWrites.then(async () => {
        const next = { ...(await getCharVoice(chid)), ...patch };
        await ctx().writeExtensionField(chid, EXTENSION_KEY, next);
        return next;
    });
    charWrites = run.catch(() => {});
    run.then(() => {
        refreshCallButton();
        refreshCharButton();
        refreshSettingsCharacter();
    }, (err) => toastr.error(`Could not save voice settings: ${err?.message ?? err}`, 'TavernVoice'));
    return run;
}

/** Character overrides on top of global defaults. */
function resolveVoice(cfg) {
    const s = settings();
    return {
        voice: cfg?.voice || s.defaultVoice || 'eve',
        language: cfg?.language || s.language || 'auto',
        speed: Number(cfg?.speed) || Number(s.speed) || 1,
        notes: cfg?.notes || '',
    };
}

function characterForMessage(msg) {
    const c = ctx();
    if (!c.groupId) return c.characterId;
    const idx = c.characters.findIndex(ch => ch.avatar === msg?.original_avatar || ch.name === msg?.name);
    return idx === -1 ? undefined : idx;
}

// ---------------------------------------------------------------------------
// SillyTavern glue
// ---------------------------------------------------------------------------

const isStBusy = () => document.body.dataset.generating === 'true';

function setTextarea(value) {
    const ta = document.getElementById('send_textarea');
    ta.value = value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Runs fn with the chat box emptied, putting back whatever the user had drafted. */
async function withDraftStashed(fn) {
    const ta = document.getElementById('send_textarea');
    const draft = ta?.value ?? '';
    if (draft) setTextarea('');
    try {
        return await fn();
    } finally {
        if (draft && !ta.value) setTextarea(draft);
    }
}

/** Sends a user message through SillyTavern's normal pipeline (regex, quick replies, etc.). */
function sendUserMessage(text, { voice = false } = {}) {
    const c = ctx();
    const ta = document.getElementById('send_textarea');
    const draft = ta.value;
    setTextarea(text);

    const onSent = (id) => {
        const msg = c.chat[id];
        if (voice && msg?.is_user) {
            msg.extra ??= {};
            msg.extra[EXTENSION_KEY] = 'voice';
        }
        if (draft && !ta.value) setTextarea(draft);
    };
    c.eventSource.once(c.eventTypes.MESSAGE_SENT, onSent);
    $('#send_but').trigger('click');
}

async function logMarker(text) {
    try {
        const safe = ctx().substituteParams(text).replace(/\|/g, '\\|').replace(/\{\{/g, '{ {');
        await ctx().executeSlashCommandsWithOptions(`/sys compact=true ${safe}`);
    } catch (err) {
        console.warn(TAG, 'Could not log call marker', err);
    }
}

function micErrorMessage(err) {
    if (err?.name === 'NotAllowedError') return 'Microphone permission was denied. Allow it in the browser address bar and try again.';
    if (err?.name === 'NotFoundError') return 'No microphone found.';
    if (err?.name === 'OverconstrainedError') return 'The selected microphone is unavailable. Pick another one in TavernVoice settings.';
    return err?.message || String(err);
}

// \p{M}: vowel signs in Malayalam and other Indic scripts are marks, and belong to the word.
const words = (s) => String(s).toLowerCase().replace(/<[^>]+>|\[[^\]]+\]/g, ' ').match(/[\p{L}\p{M}\p{N}']+/gu) ?? [];

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** @type {CallSession|null} */
let call = null;

class CallSession {
    constructor(chid, charCfg, person = null, caller = null) {
        const c = ctx();
        this.s = settings();
        this.chid = chid;
        this.chatId = c.getCurrentChatId();
        this.char = c.characters[chid];
        this.person = person;               // someone on a story card, or null for the card itself
        this.caller = caller;               // who is ringing them, or null when it's your persona
        this.callee = person?.name || '';
        this.name = this.callee || this.char.name;
        this.cast = castOf(charCfg).map(p => p.name);
        this.voice = resolveVoice(voiceFor(charCfg, person));
        this.provider = parseVoice(this.voice.voice).provider;
        this.tagStyle = router.tagStyle(this.voice.voice); // HeyGen voices get no tags, so the LLM is told not to write them
        this.inputMode = this.s.inputMode;

        this.player = new SpeechPlayer();
        this.player.setVolume(this.s.volume);
        this.mic = new MicInput();
        this.ui = new CallUI();
        this.stt = null;
        this.sttMode = 'batch';

        this.turn = null;
        this.turnBase = '';
        this.generating = false;
        this.pending = [];
        this.recentSpoken = [];
        this.listeners = [];
        this.timers = new Set();
        this.ended = false;
        this.connectedAt = 0;
        this.stoppedAt = 0;
        this.muted = false;
        this.speakerMuted = false;
        this.greetingPending = false;
    }

    // --- lifecycle --------------------------------------------------------

    async start() {
        const c = ctx();
        const et = c.eventTypes;
        const s = this.s;

        this.ui.mount({
            name: this.name,
            avatarUrl: c.getThumbnailUrl('avatar', this.char.avatar),
            inputMode: this.inputMode,
            captions: s.captions,
            media: !!mediaStudio(),
        });
        this.#bindUi();
        this.setPhase('ringing');

        this.stopRing = s.ring ? Sounds.ringback(this.player.output) : () => {};
        this.ringUntil = Date.now() + (s.ring ? 2400 : 200);
        this.player.notBefore = this.ringUntil; // let it ring at least once before they "pick up"

        this.#on(et.GENERATION_STARTED, (type, _opts, dryRun) => this.onGenerationStarted(type, dryRun));
        this.#on(et.STREAM_TOKEN_RECEIVED, (text) => this.onToken(text));
        this.#on(et.MESSAGE_RECEIVED, (id, type) => this.onMessageReceived(id, type));
        this.#on(et.GENERATION_ENDED, () => this.onGenerationDone());
        this.#on(et.GENERATION_STOPPED, () => this.onGenerationStopped());
        this.#on(et.CHAT_CHANGED, () => {
            if (ctx().getCurrentChatId() !== this.chatId) this.end('Chat changed');
        });

        this.player.addEventListener('chunkstart', (e) => {
            this.connected();
            this.setPhase('speaking');
            this.ui.setAiCaption(captionHtml(e.detail.meta.text));
            this.recentSpoken = [...this.recentSpoken.slice(-2), e.detail.meta.text];
            this.mic.vad.boostDb = this.s.bargeIn ? 8 : 0;
        });
        this.player.addEventListener('idle', () => {
            this.mic.vad.boostDb = 0;
            this.restorePhase();
            this.flushPending();
        });
        this.player.addEventListener('stopped', () => {
            this.mic.vad.boostDb = 0;
        });
        this.player.addEventListener('error', (e) => this.onTtsError(e.detail.error));

        try {
            await this.mic.start({
                deviceId: s.micDeviceId,
                sensitivity: s.sensitivity,
                endMs: s.endSilenceMs,
                manual: this.inputMode === 'ptt',
            });
        } catch (err) {
            toastr.error(micErrorMessage(err), 'TavernVoice');
            this.end('Microphone unavailable', { silent: true });
            return;
        }
        if (this.ended) return;
        this.mic.addEventListener('frame', (e) => this.onMicFrame(e.detail));
        this.mic.addEventListener('speechstart', () => this.onSpeechStart());
        this.mic.addEventListener('speechend', (e) => this.onSpeechEnd(e.detail));

        if (s.sttMode !== 'batch') this.connectStream();

        this.applyPrompt(s.greet);
        if (s.logCalls) await logMarker(this.caller
            ? `📞 ${this.caller.name} called ${this.name}.`
            : `📞 {{user}} started a voice call with ${this.name}.`);
        this.#acquireWakeLock();
        this.#loop();

        if (s.greet && !isStBusy()) {
            this.greetingPending = true;
            this.generateGreeting();
        } else {
            this.applyPrompt(false);
            this.#later(() => this.connected(), this.ringUntil - Date.now());
        }
        // Safety net: never ring forever if the greeting fails silently.
        this.#later(() => this.connected(), 30000);
    }

    /** The phone was "picked up": stop ringing, start the clock. */
    connected() {
        if (this.connectedAt || this.ended) return;
        this.connectedAt = Date.now();
        this.stopRing();
        if (this.s.ring && !this.player.playing) Sounds.connect(this.player.output);
        this.ui.setConnected();
        this.restorePhase();
        this.timer = setInterval(() => this.ui.setTimer((Date.now() - this.connectedAt) / 1000), 1000);
    }

    async generateGreeting() {
        try {
            await withDraftStashed(() => ctx().generate('normal'));
        } catch (err) {
            console.error(TAG, 'Greeting failed', err);
        } finally {
            if (this.greetingPending) {
                this.greetingPending = false;
                this.applyPrompt(false);
            }
            if (!this.connectedAt) this.#later(() => this.connected(), Math.max(0, this.ringUntil - Date.now()));
        }
    }

    end(reason = 'Call ended', { silent = false } = {}) {
        if (this.ended) return;
        this.ended = true;
        const c = ctx();
        for (const [event, fn] of this.listeners) c.eventSource.removeListener(event, fn);
        this.listeners = [];
        for (const t of this.timers) clearTimeout(t);
        clearInterval(this.timer);
        cancelAnimationFrame(this.raf);
        this.stopRing?.();
        this.player.stop();
        this.mic.stop();
        this.stt?.close();
        this.offMedia?.();
        c.setExtensionPrompt(PROMPT_KEY, '', 1, 0);
        this.wakeLock?.release().catch(() => {});

        const seconds = this.connectedAt ? (Date.now() - this.connectedAt) / 1000 : 0;
        if (this.s.logCalls && this.connectedAt) {
            const m = Math.floor(seconds / 60);
            const sec = Math.floor(seconds % 60);
            logMarker(`📞 Call ended (${m}:${String(sec).padStart(2, '0')}).`);
        }
        if (!silent) Sounds.hangup(this.player.output);
        this.ui.setPhase('ended', reason === 'Hung up' ? 'Call ended' : reason);
        this.ui.root?.classList.add('tv-ending');
        setTimeout(() => this.ui.destroy(), 1400);

        if (call === this) call = null;
        refreshCallButton();
        log('call ended:', reason);
    }

    // --- prompt -----------------------------------------------------------

    applyPrompt(greeting) {
        const s = this.s;
        if (!s.injectPrompt) {
            ctx().setExtensionPrompt(PROMPT_KEY, '', 1, 0);
            return;
        }
        // With the voice director on, the main LLM writes plain dialogue and the helper adds tags.
        const promptTags = s.helperTags ? 'none' : this.tagLevel();
        const text = buildCallPrompt({
            template: s.promptTemplate, tagLevel: promptTags, voiceNotes: this.voice.notes, greeting,
            callee: this.callee, about: this.person?.about || '', language: this.voice.language,
            caller: this.caller?.name || '', callerAbout: this.caller?.about || '',
            // Named even when the card itself answered: without this the model drifts into
            // speaking as the side characters it can see in the chat.
            others: this.cast.filter(n => n.toLowerCase() !== this.name.toLowerCase()),
        });
        // position 1 = IN_CHAT, role 0 = SYSTEM
        ctx().setExtensionPrompt(PROMPT_KEY, text, 1, Number(s.promptDepth) || 0, false, 0);
    }

    /** The expressiveness setting, or none for a voice that can't do tags. */
    tagLevel() {
        return this.tagStyle === 'plain' ? 'none' : this.s.tagLevel;
    }

    speechOpts() {
        return { mode: this.s.speakMode, actionSounds: this.s.actionSounds, tagLevel: this.tagLevel(), charName: this.char.name };
    }

    // --- the character talking ------------------------------------------

    onGenerationStarted(type, dryRun) {
        if (dryRun || type === 'quiet' || type === 'impersonate') return;
        this.generating = true;
        this.player.stop(); // a new reply supersedes whatever was still being said
        this.turn = new SpeechTurn(this.speechOpts());
        this.turnChunks = 0;
        const last = ctx().chat.at(-1);
        this.turnBase = type === 'continue' && last && !last.is_user ? (last.mes ?? '') : '';
        this.stoppedAt = 0;
        this.ui.setAiCaption('');
        if (this.connectedAt) this.setPhase('thinking');
    }

    onToken(text) {
        if (!this.turn) return;
        this.speak(this.turn.update(String(text ?? ''), false));
    }

    onMessageReceived(id, type) {
        if (type === 'first_message') return;
        const msg = ctx().chat[id];
        if (!msg || msg.is_user || msg.is_system) return;
        this.generating = false;
        if (this.greetingPending) {
            this.greetingPending = false;
            this.applyPrompt(false);
        }
        if (!this.turn) {
            if (Date.now() - this.stoppedAt < 3000) return; // interrupted: don't speak the leftovers
            this.turn = new SpeechTurn(this.speechOpts());
            this.turnChunks = 0;
        }
        let text = msg.mes ?? '';
        if (this.turnBase && text.startsWith(this.turnBase)) text = text.slice(this.turnBase.length);
        const chunks = this.turn.update(text, true);
        this.turn = null;
        this.speak(chunks);
        if (!chunks.length && !this.player.busy) {
            this.connected();
            this.restorePhase();
        }
        this.flushPending();
    }

    onGenerationDone() {
        this.generating = false;
        this.#later(() => {
            this.restorePhase();
            this.flushPending();
        }, 50);
    }

    onGenerationStopped() {
        this.generating = false;
        this.turn = null;
        this.stoppedAt = Date.now();
        this.player.stop();
        this.#later(() => {
            this.restorePhase();
            this.flushPending();
        }, 50);
    }

    speak(chunks) {
        const { voice, language, speed } = this.voice;
        for (const text of chunks) {
            log('speak:', text);
            const meta = { text };
            // The first sentence waits for its tags up to helperFirstMs. Later ones are tagged
            // while earlier sentences play, and are spoken plain if the tags aren't back by
            // the time they're needed, so the voice never pauses for them.
            const first = (this.turnChunks++ || 0) === 0;
            const budget = first ? Number(this.s.helperFirstMs) || 1500 : 8000;
            this.player.enqueue(async (signal, needed) => {
                const spoken = this.s.helperTags && this.tagStyle !== 'plain'
                    ? await helperTag(text, { char: this.name, context: lastUserLine(), timeoutMs: budget, until: first ? null : needed })
                    : text;
                meta.text = spoken; // the caption shows what the voice actually gets
                return router.tts({ text: spoken, voice, language, speed, signal });
            }, meta);
        }
    }

    onTtsError(err) {
        console.error(TAG, 'TTS failed', err);
        if (this.lastTtsToast && Date.now() - this.lastTtsToast < 8000) return;
        this.lastTtsToast = Date.now();
        toastr.error(err?.message || String(err), 'TavernVoice: voice generation failed');
        // 401/403: a bad key, or (ElevenLabs) no credits left. The toast above has the provider's reason.
        if (err?.status === 401 || err?.status === 403) this.end(`${PROVIDERS[this.provider]} refused the voice request`);
    }

    // --- the user talking -----------------------------------------------

    async connectStream() {
        const stream = new SttStream(client, {
            language: this.voice.language,
            smartTurn: this.s.smartTurn,
            endpointing: Math.max(300, Math.min(2000, Number(this.s.endSilenceMs) || 800)),
            keyterms: this.keyterms(),
            onInterim: (text) => this.onInterim(text),
            onUtterance: (text) => this.handleUtterance(text, { voice: true }),
            onError: (err) => console.warn(TAG, 'Streaming STT error', err),
            onClose: () => this.fallbackToBatch('Live transcription disconnected'),
        });
        try {
            await stream.connect();
            if (this.ended) {
                stream.close();
                return;
            }
            this.stt = stream;
            this.sttMode = 'stream';
            log('streaming STT connected via', SttStream.workingAuth);
        } catch (err) {
            console.warn(TAG, 'Streaming STT unavailable, using batch STT', err);
            if (this.s.sttMode === 'stream') toastr.warning('Live transcription is unavailable; using standard transcription.', 'TavernVoice');
        }
    }

    fallbackToBatch(reason) {
        if (this.ended || this.sttMode !== 'stream') return;
        this.sttMode = 'batch';
        this.stt = null;
        toastr.info(`${reason}. Switched to standard transcription.`, 'TavernVoice');
    }

    keyterms() {
        return [...new Set([this.name, this.char.name, ctx().name1, this.caller?.name, ...this.cast])].filter(Boolean);
    }

    onMicFrame({ pcm, level }) {
        this.ui.setMicLevel(level);
        if (this.sttMode !== 'stream' || !this.stt) return;
        // Half-duplex (no barge-in): don't let the character's own voice reach the transcriber.
        const deaf = !this.s.bargeIn && this.player.busy;
        this.stt.send(deaf ? new Int16Array(pcm.length) : pcm);
    }

    onSpeechStart() {
        if (this.muted) return;
        this.ui.setPttActive(this.mic.pttHeld);
        const aiBusy = this.player.busy || this.generating;
        if (aiBusy && !this.s.bargeIn && this.inputMode !== 'ptt') return; // half-duplex: ignore
        if (aiBusy && this.player.busy) {
            this.player.duck(true);
            clearTimeout(this.bargeTimer);
            if (this.sttMode === 'batch' || this.inputMode === 'ptt') {
                // Batch mode can't wait for words: confirm with sustained voice instead.
                this.bargeTimer = setTimeout(() => {
                    if (this.mic.speaking) this.interrupt('voice');
                    else this.player.duck(false);
                }, this.inputMode === 'ptt' ? 0 : 350);
            } else {
                this.bargeTimer = setTimeout(() => this.player.duck(false), 1500);
            }
        }
        this.setPhase('user');
    }

    async onSpeechEnd({ pcm, ms }) {
        this.ui.setPttActive(false);
        clearTimeout(this.bargeTimer);
        if (this.sttMode === 'stream') {
            if (this.inputMode === 'ptt') this.stt?.finalize();
            return;
        }
        if (this.muted) return;
        if (!this.s.bargeIn && this.player.busy && this.inputMode !== 'ptt') return;
        if (ms < 350) {
            this.player.duck(false);
            this.restorePhase();
            return;
        }
        this.setPhase('transcribing');
        this.ui.setUserCaption('…', true);
        try {
            const res = await client.stt({ audio: encodeWav(pcm, 16000), language: this.voice.language, keyterms: this.keyterms() });
            if (this.ended) return;
            log('stt:', res);
            this.handleUtterance(res?.text ?? '', { voice: true });
        } catch (err) {
            console.error(TAG, 'STT failed', err);
            toastr.error(err?.message || String(err), 'TavernVoice: transcription failed');
            this.ui.setUserCaption('', false);
            this.player.duck(false);
            this.restorePhase();
            if (err?.status === 401 || err?.status === 403) this.end('Invalid xAI API key');
        }
    }

    onInterim(text) {
        if (this.ended) return;
        if (text && this.player.busy && this.isEcho(text)) return;
        this.ui.setUserCaption(text, true);
        if (!text) return;
        if (this.phase !== 'user') this.setPhase('user');
        if (this.s.bargeIn && (this.player.busy || this.generating) && words(text).length >= 1) {
            this.interrupt('words');
        }
    }

    /** Did the mic just hear the character's own voice? (helps when echo cancellation leaks) */
    isEcho(text) {
        const heard = words(text);
        if (heard.length < 2) return false;
        const spoken = new Set(this.recentSpoken.flatMap(words));
        const hits = heard.filter(w => spoken.has(w)).length;
        return hits / heard.length >= 0.7;
    }

    handleUtterance(text, { voice = false } = {}) {
        if (this.ended) return;
        text = String(text ?? '').trim();
        if (!/[\p{L}\p{N}]/u.test(text)) {
            this.ui.setUserCaption('', false);
            this.player.duck(false);
            this.restorePhase();
            return;
        }
        if (voice && this.player.busy && this.isEcho(text)) {
            log('dropped echo:', text);
            return;
        }
        this.ui.setUserCaption(text, false);
        const aiBusy = this.player.busy || this.generating || isStBusy();
        if (aiBusy && (this.s.bargeIn || !voice)) this.interrupt(voice ? 'speech' : 'typed');
        this.pending.push({ text, voice });
        this.flushPending();
    }

    /** Barge-in: the user talks over the character, so it stops mid-sentence like a real person. */
    interrupt(reason) {
        log('interrupt:', reason);
        clearTimeout(this.bargeTimer);
        this.player.stop();
        this.turn = null;
        if (this.generating || isStBusy()) {
            this.stoppedAt = Date.now();
            ctx().stopGeneration();
        }
        this.generating = false;
    }

    flushPending() {
        if (this.ended || !this.pending.length) return;
        if (isStBusy() || this.player.busy) {
            if (!this.flushRetry) {
                this.flushRetry = setTimeout(() => {
                    this.flushRetry = null;
                    this.flushPending();
                }, 250);
            }
            return;
        }
        const batch = this.pending.splice(0);
        const text = batch.map(p => p.text).join(' ');
        this.setPhase('thinking');
        try {
            sendUserMessage(text, { voice: batch.some(p => p.voice) });
        } catch (err) {
            toastr.error(err?.message || String(err), 'TavernVoice');
            this.restorePhase();
        }
    }

    // --- controls ---------------------------------------------------------

    #bindUi() {
        this.ui.addEventListener('hangup', () => this.end('Hung up'));
        this.ui.addEventListener('mute', () => this.setMuted(!this.muted));
        this.ui.addEventListener('speaker', () => {
            this.speakerMuted = !this.speakerMuted;
            this.player.setVolume(this.speakerMuted ? 0 : this.s.volume);
            this.ui.setSpeakerMuted(this.speakerMuted);
        });
        this.ui.addEventListener('mode', () => this.setInputMode(this.inputMode === 'ptt' ? 'open' : 'ptt'));
        this.ui.addEventListener('pttdown', () => this.mic.pttDown());
        this.ui.addEventListener('pttup', () => this.mic.pttUp());
        this.ui.addEventListener('send', (e) => this.handleUtterance(e.detail.text, { voice: false }));
        // Photos and videos while on the call: the chat is behind this window, so they show here.
        this.ui.addEventListener('media', (e) => mediaStudio()?.generateLast(e.detail.kind));
        const shown = (e) => {
            if (e.detail?.chatId === this.chatId) this.ui.showMedia(e.detail);
        };
        const status = (e) => {
            if (e.detail?.chatId === this.chatId) this.ui.setMediaStatus(e.detail.text);
        };
        document.addEventListener('mediastudio:attached', shown);
        document.addEventListener('mediastudio:status', status);
        this.offMedia = () => {
            document.removeEventListener('mediastudio:attached', shown);
            document.removeEventListener('mediastudio:status', status);
        };
    }

    setMuted(muted) {
        this.muted = muted;
        this.mic.muted = muted;
        this.ui.setMuted(muted);
        if (muted) this.ui.setUserCaption('', false);
    }

    setInputMode(mode) {
        this.inputMode = mode;
        this.mic.configure({ manual: mode === 'ptt' });
        this.ui.setInputMode(mode);
        if (this.muted && mode === 'ptt') this.setMuted(false);
    }

    applySettings() {
        this.mic.configure({ sensitivity: this.s.sensitivity, endMs: this.s.endSilenceMs });
        if (!this.speakerMuted) this.player.setVolume(this.s.volume);
    }

    // --- display ----------------------------------------------------------

    setPhase(phase) {
        this.phase = phase;
        this.ui.setPhase(phase);
    }

    restorePhase() {
        if (this.ended) return;
        if (!this.connectedAt) return this.setPhase('ringing');
        if (this.player.playing) return this.setPhase('speaking');
        if (this.generating || isStBusy() || this.player.busy) return this.setPhase('thinking');
        this.setPhase('listening');
    }

    #loop() {
        this.ui.setAiLevel(this.player.level());
        this.raf = requestAnimationFrame(() => this.#loop());
    }

    #on(event, fn) {
        ctx().eventSource.on(event, fn);
        this.listeners.push([event, fn]);
    }

    #later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            if (!this.ended) fn();
        }, Math.max(0, ms));
        this.timers.add(t);
    }

    async #acquireWakeLock() {
        try {
            this.wakeLock = await navigator.wakeLock?.request('screen');
        } catch { /* not supported or denied */ }
    }
}

/** Media Studio's API, when that extension is installed. */
const mediaStudio = () => (typeof globalThis.MediaStudio?.generateLast === 'function' ? globalThis.MediaStudio : null);

const answered = (choice) => (choice?.person ? { person: choice.person } : {});

/** Groups the "Calling as" list under its headings, keeping the order it came in. */
function callerOptionsHtml(people, esc) {
    const groups = [];
    for (const [i, p] of people.entries()) {
        const option = `<option value="${i}">${esc(p.persona ? `You (${p.name})` : p.name)}</option>`;
        const open = groups[groups.length - 1];
        if (open && open.name === p.group) open.html += option;
        else groups.push({ name: p.group, html: option });
    }
    return groups.map(g => (g.name ? `<optgroup label="${esc(g.name)}">${g.html}</optgroup>` : g.html)).join('');
}

/**
 * Who picks up and who is ringing them: { person } for someone in the story or {} for the card
 * itself, plus { caller } when the call comes from someone other than your persona, and null
 * when the user cancelled. The card's own character heads the list of answerers, so a story card
 * never hides the character it is named after.
 *
 * The popup opens on every call now: the caller is a choice even on a card with nobody else on
 * it, and both dropdowns come back on the last pair this chat used.
 */
async function pickCall(cfg, cardName) {
    const c = ctx();
    const esc = (t) => $('<span>').text(t).html();
    const fixed = whoAnswers(cfg, cardName);
    const answers = fixed.ask ? calleeChoices(cfg, cardName) : [];
    const cast = castOf(cfg);
    const characters = (c.characters || []).map(ch => ({ name: ch.name, description: ch.description }));
    const label = (ch) => (ch.card ? `${ch.name} (the card itself)` : ch.name);

    const $el = $(`<div class="tv-char-popup"><h3><i class="fa-solid fa-phone"></i> Call ${esc(cardName)}</h3>
        <label class="tv-notes${answers.length ? '' : ' displayNone'}">Who are you calling
            <select class="tv-callee text_pole">${answers.map((ch, i) => `<option value="${i}">${esc(label(ch))}</option>`).join('')}</select></label>
        <label class="tv-notes">Calling as <select class="tv-caller text_pole"></select></label></div>`);
    const $callee = $el.find('.tv-callee');
    const $caller = $el.find('.tv-caller');

    const lastCallee = String(c.chatMetadata?.tavern_voice_callee ?? '');
    const at = answers.findIndex(ch => (ch.card ? '' : ch.name) === lastCallee);
    if (at > 0) $callee.val(String(at));

    // Rebuilt whenever the answerer changes, so nobody is ever offered as their own caller.
    let callers = [];
    const drawCallers = () => {
        const picked = answers.length ? answers[Number($callee.val())] : null;
        const answering = picked ? (picked.card ? cardName : picked.name) : (fixed.person?.name || cardName);
        callers = callerChoices({ persona: c.name1, cardName, cast, characters, answering });
        const want = String(c.chatMetadata?.tavern_voice_caller ?? '');
        const keep = callers.findIndex(p => !p.persona && p.name === want);
        $caller.html(callerOptionsHtml(callers, esc)).val(String(keep > 0 ? keep : 0));
    };
    drawCallers();
    $callee.on('change', drawCallers);

    const ok = await c.callGenericPopup($el, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Call', cancelButton: 'Cancel' });
    if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return null;
    const choice = answers.length ? (answers[Number($callee.val())] ?? answers[0]) : null;
    const caller = callers[Number($caller.val())] ?? callers[0];
    if (choice) c.chatMetadata.tavern_voice_callee = choice.card ? '' : choice.name;
    c.chatMetadata.tavern_voice_caller = caller.persona ? '' : caller.name;
    c.saveMetadataDebounced?.();
    return { ...(choice ? answered(choice) : fixed), caller: caller.persona ? null : caller };
}

const INSECURE_PAGE_MESSAGE = 'Your browser blocks the microphone because this page is not HTTPS. Open SillyTavern through an https:// address (reverse proxy, Tailscale or Cloudflare Tunnel) or via localhost.';

async function startCall() {
    const c = ctx();
    if (call) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        toastr.error(INSECURE_PAGE_MESSAGE, 'TavernVoice', { timeOut: 12000 });
        return;
    }
    if (c.groupId) {
        toastr.info('Voice calls work in one-on-one chats only.', 'TavernVoice');
        return;
    }
    if (c.characterId === undefined || c.characterId === null) {
        toastr.info('Open a character chat first.', 'TavernVoice');
        return;
    }
    const cfg = await getCharVoice(c.characterId);
    const name = c.characters[c.characterId]?.name;
    if (!cfg?.enabled) {
        toastr.info(`Voice calls are off for ${name}. Turn them on with the phone button in the character card.`, 'TavernVoice');
        return;
    }
    if (!(await hasKey('xai'))) {
        toastr.warning('Calls listen to you with xAI Grok. Add your xAI API key in Extensions → TavernVoice first.', 'TavernVoice');
        return;
    }
    if (c.onlineStatus === 'no_connection') {
        toastr.warning('SillyTavern is not connected to an LLM API, so the character can\'t answer.', 'TavernVoice');
        return;
    }
    const picked = await pickCall(cfg, name);
    if (!picked) return;
    const { provider } = parseVoice(resolveVoice(voiceFor(cfg, picked.person ?? null)).voice);
    if (!(await hasKey(provider))) {
        toastr.warning(`${picked.person?.name || name} has a ${PROVIDERS[provider]} voice. Add your ${PROVIDERS[provider]} API key in Extensions → TavernVoice first.`, 'TavernVoice');
        return;
    }
    call = new CallSession(c.characterId, cfg, picked.person ?? null, picked.caller ?? null);
    refreshCallButton();
    try {
        await call.start();
    } catch (err) {
        console.error(TAG, err);
        toastr.error(err?.message || String(err), 'TavernVoice');
        call?.end('Call failed', { silent: true });
    }
}

// ---------------------------------------------------------------------------
// One-off playback (message replay button, previews, /voicesay)
// ---------------------------------------------------------------------------

const oneShot = new SpeechPlayer();

async function speakOnce(rawText, chid, person = null) {
    getAudioContext();
    oneShot.stop();
    const cfg = resolveVoice(voiceFor(await getCharVoice(chid), person));
    const s = settings();
    oneShot.setVolume(s.volume);
    const plain = router.tagStyle(cfg.voice) === 'plain';
    const turn = new SpeechTurn({
        mode: s.speakMode,
        actionSounds: s.actionSounds,
        tagLevel: plain ? 'none' : s.tagLevel,
        charName: ctx().characters[chid]?.name ?? '',
        // Not streaming, so fewer and longer chunks sound more natural.
        chunking: { firstMinChars: 12, minChars: 200, maxChars: 900 },
    });
    const chunks = turn.update(rawText, true);
    if (!chunks.length) {
        toastr.info('Nothing to say in that message.', 'TavernVoice');
        return;
    }
    const name = person?.name || (ctx().characters[chid]?.name ?? '');
    for (const chunk of chunks) {
        oneShot.enqueue(async (signal) => {
            const text = s.helperTags && !plain ? await helperTag(chunk, { char: name, timeoutMs: 8000 }) : chunk;
            return router.tts({ text, voice: cfg.voice, language: cfg.language, speed: cfg.speed, signal });
        }, { text: chunk });
    }
}

oneShot.addEventListener('error', (e) => toastr.error(e.detail.error?.message ?? String(e.detail.error), 'TavernVoice'));

// ---------------------------------------------------------------------------
// Chat decorations: voice-tag chips, "said on a call" badge, replay button
// ---------------------------------------------------------------------------

function registerTagFormatter() {
    const formatter = ctx().messageFormatter;
    if (!formatter?.addHook) return; // older SillyTavern: tags just show as plain text
    formatter.addHook(
        (mes, info) => (settings().prettifyTags && !info?.isUser && !info?.isReasoning ? decorateTagsHtml(mes) : mes),
        { stage: 'afterMarkdown' },
    );
}

function decorateMessage(id) {
    const msg = ctx().chat[id];
    const el = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!msg || !el) return;
    if (msg.extra?.[EXTENSION_KEY] === 'voice' && !el.querySelector('.tv-voice-badge')) {
        el.querySelector('.name_text')?.insertAdjacentHTML('afterend', '<i class="fa-solid fa-microphone tv-voice-badge" title="Said on a voice call"></i>');
    }
}

function decorateAll() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => decorateMessage(Number(el.getAttribute('mesid'))));
}

// ---------------------------------------------------------------------------
// Call button (chat bar) and character card button
// ---------------------------------------------------------------------------

let refreshSeq = 0;

async function refreshCallButton() {
    const btn = $('#tv_call_button');
    if (!btn.length) return;
    const seq = ++refreshSeq;
    if (call) {
        btn.removeClass('displayNone').addClass('tv-in-call').attr('title', 'Hang up');
        return;
    }
    btn.removeClass('tv-in-call');
    const c = ctx();
    const single = !c.groupId && c.characterId !== undefined && c.characterId !== null;
    const cfg = single ? await getCharVoice(c.characterId) : null;
    if (seq !== refreshSeq) return;
    const who = cfg?.enabled ? whoAnswers(cfg, c.characters[c.characterId]?.name) : {};
    const name = who.person?.name || (who.ask ? `someone in ${c.characters[c.characterId]?.name}` : c.characters[c.characterId]?.name);
    btn.toggleClass('displayNone', !cfg?.enabled).attr('title', cfg?.enabled ? `Voice call ${name}` : '');
}

async function refreshCharButton() {
    const btn = $('#tv_char_button');
    if (!btn.length) return;
    const c = ctx();
    const editing = c.characterId !== undefined && c.characterId !== null && c.menuType !== 'create' && !c.groupId;
    btn.toggleClass('displayNone', !editing);
    if (!editing) return;
    const cfg = await getCharVoice(c.characterId);
    btn.toggleClass('tv-enabled', !!cfg?.enabled)
        .attr('title', cfg?.enabled ? 'Voice calls: ON (click for voice settings)' : 'Voice calls: OFF (click to set up)');
}

/** A voice's display name; the other providers' IDs are long hex strings. */
const voiceName = (ref) => voiceList.find(v => v.voice_id === ref)?.name ?? ref;

/** Voice <option>s grouped by source: the xAI team's custom voices, xAI's built-ins, ElevenLabs, HeyGen, Cartesia, then anything typed in. */
function voiceOptionsHtml(selected, { withDefault = false, defaultLabel = '' } = {}) {
    const esc = (t) => $('<span>').text(t).html();
    const option = (v) => {
        const desc = v.provider === 'xai'
            ? v.description || FALLBACK_VOICES.find(f => f.voice_id === v.voice_id)?.description
            : [v.description, v.gender].filter(Boolean).join(', ');
        return `<option value="${esc(v.voice_id)}" ${v.voice_id === selected ? 'selected' : ''}>${esc(v.name)}${desc ? ` — ${esc(desc)}` : ''}</option>`;
    };
    const opts = withDefault ? [`<option value="">${esc(defaultLabel || `Default (${voiceName(settings().defaultVoice)})`)}</option>`] : [];
    const groups = [
        ['Your custom voices (xAI)', v => v.provider === 'xai' && v.custom],
        ['xAI Grok voices', v => v.provider === 'xai' && !v.custom],
        ['ElevenLabs voices', v => v.provider === 'elevenlabs'],
        ['HeyGen voices', v => v.provider === 'heygen'],
        ['Cartesia voices', v => v.provider === 'cartesia'],
    ];
    for (const [label, test] of groups) {
        const list = voiceList.filter(test);
        if (list.length) opts.push(`<optgroup label="${label}">${list.map(option).join('')}</optgroup>`);
    }
    if (selected && selected !== CUSTOM_VOICE && !voiceList.some(v => v.voice_id === selected)) {
        opts.push(`<optgroup label="Other"><option value="${esc(selected)}" selected>${esc(selected)} (voice ID)</option></optgroup>`);
    }
    opts.push(`<option value="${CUSTOM_VOICE}">Enter a voice ID…</option>`);
    return opts.join('');
}

/** Ask for a voice ID that isn't in the list. Resolves to the ID, or '' if cancelled. */
async function askCustomVoice(current) {
    const c = ctx();
    const id = await c.callGenericPopup('Voice ID. A plain ID is an xAI voice (custom xAI voices only work with a key from the xAI team that made them). For the others write elevenlabs:<voice ID>, heygen:<voice ID> or cartesia:<voice ID>.',
        c.POPUP_TYPE.INPUT, current && current !== CUSTOM_VOICE ? current : '');
    const clean = String(id || '').trim();
    if (clean && !/^((xai|elevenlabs|heygen|cartesia):)?[\w-]{1,64}$/.test(clean)) {
        toastr.warning('Voice IDs are letters, digits, - and _ only, after an optional elevenlabs:, heygen: or cartesia:.', 'TavernVoice');
        return '';
    }
    return clean;
}

function languageOptionsHtml(selected, { withDefault = false } = {}) {
    const option = ([code, label]) => `<option value="${code}" ${code === selected ? 'selected' : ''}>${label}</option>`;
    const opts = withDefault ? [`<option value="">Default (${settings().language})</option>`] : [];
    opts.push(...LANGUAGES.map(option));
    opts.push(`<optgroup label="ElevenLabs, HeyGen and Cartesia voices only">${MORE_LANGUAGES.map(option).join('')}</optgroup>`);
    return opts.join('');
}

/** Lorebook entries for a card: its embedded book, then the world it links to. */
async function cardLore(ch) {
    const entries = [...(ch.data?.character_book?.entries ?? [])];
    const world = ch.data?.extensions?.world;
    if (world && typeof ctx().loadWorldInfo === 'function') {
        try {
            entries.push(...Object.values((await ctx().loadWorldInfo(world))?.entries ?? {}));
        } catch { /* a missing lorebook just means less to read */ }
    }
    return entries.filter(e => e?.content && !e.disable && e.enabled !== false)
        .map(e => `${[].concat(e.keys ?? e.key ?? []).join(', ')}: ${e.content}`).join('\n');
}

/** Asks the bridge helper who is in the card, and adds them to the list. */
async function findCast(ch, current) {
    const c = ctx();
    const sub = (t) => c.substituteParams(String(t ?? ''), undefined, ch.name);
    const card = {
        name: ch.name, description: sub(ch.description), personality: sub(ch.personality), scenario: sub(ch.scenario),
        first_mes: sub(ch.first_mes), mes_example: sub(ch.mes_example), lore: sub(await cardLore(ch)),
    };
    const voices = voiceList.map(v => ({
        voice_id: v.voice_id, name: v.name, gender: v.gender || '', language: v.language || '',
        description: v.description || FALLBACK_VOICES.find(f => f.voice_id === v.voice_id)?.description || '',
    }));
    const res = await fetch(`${helperBase()}/helper/cast`, {
        method: 'POST',
        headers: helperHeaders(),
        body: JSON.stringify({ card, user: c.name1, voices, model: settings().helperModel || undefined }),
    });
    if (!res.ok) throw new Error(res.status === 404 ? 'This bridge is too old for this. Update it.' : `The bridge answered ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return { cast: mergeCast(current, data.people), found: (data.people ?? []).length };
}

/** The "People in this story" part of the character popup: who answers, and each person's voice and brief. */
function bindCastEditor($el, chid, ch, cfg) {
    const esc = (t) => $('<span>').text(t).html();
    const $list = $el.find('.tv-cast-list');
    let cast = castOf(cfg);
    const personVoice = (id) => (id ? voiceName(id) : 'card\'s voice');

    const save = (patch = {}) => setCharVoice(chid, { cast, callees: '', ...patch });

    function renderAnswers() {
        // Everyone is listed whatever the size of the cast: with one side character this used to
        // relabel "Ask me each time" as that person and leave them no way to be pinned instead.
        const options = [[ASK, 'Ask me each time I call'], ['', `${ch.name} (the card itself)`],
            ...cast.filter(p => p.name.toLowerCase() !== ch.name.toLowerCase()).map(p => [p.name, p.name])];
        const current = String(cfg.answers ?? ASK);
        const known = options.some(([v]) => v.toLowerCase() === current.toLowerCase());
        $el.find('[name=answers]').html(options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join(''))
            .val(known ? options.find(([v]) => v.toLowerCase() === current.toLowerCase())[0] : ASK);
        $el.find('.tv-answers-row').toggle(cast.length > 0);
    }

    function render(openIndex = -1) {
        $list.html(cast.map((p, i) => `
            <details class="tv-person" data-i="${i}"${i === openIndex ? ' open' : ''}>
                <summary><b class="tv-person-name">${esc(p.name || 'New person')}</b> <small class="tv-person-voice">${esc(personVoice(p.voice))}</small></summary>
                <label class="tv-notes">Name<input data-f="name" class="text_pole" type="text"></label>
                <label class="tv-notes">Voice<select data-f="voice" class="text_pole">${voiceOptionsHtml(p.voice, { withDefault: true, defaultLabel: 'Same as the card' })}</select></label>
                <label class="tv-notes">Who they are <small>(the AI plays them from this on their calls)</small><textarea data-f="about" class="text_pole" rows="3"></textarea></label>
                <label class="tv-notes">How they sound <small>(optional)</small><input data-f="notes" class="text_pole" type="text" placeholder="e.g. older, slow and gravelly"></label>
                <div class="tv-popup-actions">
                    <div class="menu_button tv-person-preview"><i class="fa-solid fa-play"></i> Preview</div>
                    <div class="menu_button tv-person-remove"><i class="fa-solid fa-trash"></i> Remove</div>
                </div>
            </details>`).join(''));
        $list.find('.tv-person').each((i, node) => {
            for (const f of ['name', 'about', 'notes']) $(node).find(`[data-f=${f}]`).val(cast[i][f]);
        });
        renderAnswers();
    }

    const indexOf = (target) => Number($(target).closest('.tv-person').attr('data-i'));

    $list.on('input', '[data-f=name]', (e) => {
        const i = indexOf(e.target);
        const value = e.target.value;
        if (cfg.answers && cfg.answers === cast[i].name) cfg.answers = value; // a rename keeps them as the one who answers
        cast[i].name = value;
        $(e.target).closest('.tv-person').find('.tv-person-name').text(value || 'New person');
    });
    $list.on('change', '[data-f]', async (e) => {
        const i = indexOf(e.target);
        const f = e.target.dataset.f;
        let { value } = e.target;
        if (f === 'voice' && value === CUSTOM_VOICE) {
            value = (await askCustomVoice(cast[i].voice)) || cast[i].voice;
            $(e.target).html(voiceOptionsHtml(value, { withDefault: true, defaultLabel: 'Same as the card' }));
        }
        cast[i][f] = f === 'name' ? value.trim() : value;
        if (f === 'voice') $(e.target).closest('.tv-person').find('.tv-person-voice').text(personVoice(value));
        if (f === 'name') renderAnswers();
        await save({ answers: cfg.answers });
    });
    $list.on('click', '.tv-person-remove', async (e) => {
        const i = indexOf(e.target);
        if (cfg.answers === cast[i].name) cfg.answers = ASK;
        cast.splice(i, 1);
        render();
        await save({ answers: cfg.answers });
    });
    $list.on('click', '.tv-person-preview', (e) => {
        const p = cast[indexOf(e.target)];
        if (!p?.name) return toastr.info('Give them a name first.', 'TavernVoice');
        speakOnce(`Hey, it's ${p.name}. [laugh] It's really nice to finally hear your voice!`, chid, p);
    });
    $el.find('.tv-cast-add').on('click', () => {
        cast.push({ name: '', voice: '', about: '', notes: '' });
        render(cast.length - 1);
        $list.find('.tv-person').last().find('[data-f=name]').trigger('focus');
    });
    $el.find('.tv-cast-find').on('click', async function () {
        const $btn = $(this);
        if ($btn.hasClass('disabled')) return;
        $btn.addClass('disabled').find('i').attr('class', 'fa-solid fa-spinner fa-spin');
        try {
            const result = await findCast(ch, cast);
            const added = result.cast.length - castOf({ cast }).length;
            cast = result.cast;
            render();
            await save({ answers: cfg.answers });
            toastr.success(result.found ? `Found ${result.found} ${result.found === 1 ? 'person' : 'people'}${added ? `, ${added} new` : ''}. Check their voices and tap Preview.` : 'Found nobody to add.', 'TavernVoice');
        } catch (err) {
            toastr.error(`Could not read the card: ${err?.message ?? err}. The voice director's bridge (Extensions → TavernVoice) does this.`, 'TavernVoice');
        } finally {
            $btn.removeClass('disabled').find('i').attr('class', 'fa-solid fa-wand-magic-sparkles');
        }
    });
    render();
}

async function openCharacterPopup(chid) {
    const c = ctx();
    const ch = c.characters[chid];
    if (!ch) return;
    const cfg = await getCharVoice(chid);
    const speeds = ['', '0.75', '0.85', '1', '1.1', '1.2', '1.35', '1.5'];
    const $el = $(`
        <div class="tv-char-popup">
            <h3><i class="fa-solid fa-phone"></i> Voice calls with ${$('<span>').text(ch.name).html()}</h3>
            <label class="checkbox_label"><input type="checkbox" name="enabled"> Enable voice calls for this character</label>
            <div class="tv-grid">
                <label>Voice<select name="voice" class="text_pole">${voiceOptionsHtml(cfg.voice, { withDefault: true })}</select></label>
                <label>Language<select name="language" class="text_pole">${languageOptionsHtml(cfg.language, { withDefault: true })}</select></label>
                <label>Speed<select name="speed" class="text_pole">${speeds.map(v => `<option value="${v}" ${String(cfg.speed) === v ? 'selected' : ''}>${v ? `${v}×` : `Default (${settings().speed}×)`}</option>`).join('')}</select></label>
            </div>
            <div class="tv-cast">
                <b>People in this story</b>
                <small class="tv-hint">For cards with several characters (an RPG, a household, a group). Each person can have their own voice, and the AI plays only the one you call.</small>
                <label class="tv-notes tv-answers-row">Who answers calls<select name="answers" class="text_pole"></select></label>
                <div class="tv-cast-list"></div>
                <div class="tv-popup-actions">
                    <div class="menu_button tv-cast-find" title="Reads the card and lorebook and picks a voice for each person"><i class="fa-solid fa-wand-magic-sparkles"></i> Find people in this card</div>
                    <div class="menu_button tv-cast-add"><i class="fa-solid fa-user-plus"></i> Add person</div>
                </div>
            </div>
            <label class="tv-notes">How they sound on the phone <small>(optional, given to the AI during calls)</small>
                <textarea name="notes" class="text_pole" rows="2" placeholder="e.g. talks fast when excited, giggles a lot, soft and sleepy at night"></textarea>
            </label>
            <div class="tv-popup-actions">
                <div class="menu_button tv-preview"><i class="fa-solid fa-play"></i> Preview voice</div>
                <small>Saved on the card (data.extensions.${EXTENSION_KEY}), so it travels with exported cards.</small>
            </div>
        </div>`);
    $el.find('[name=enabled]').prop('checked', !!cfg.enabled);
    $el.find('[name=notes]').val(cfg.notes);
    bindCastEditor($el, chid, ch, cfg);
    $el.on('change', 'input, select, textarea', async (e) => {
        const { name, type, checked } = e.target;
        if (!name) return; // the people list saves itself
        let { value } = e.target;
        if (name === 'answers') cfg.answers = value;
        if (name === 'voice' && value === CUSTOM_VOICE) {
            value = await askCustomVoice(cfg.voice);
            if (!value) value = cfg.voice;
            cfg.voice = value;
            $(e.target).html(voiceOptionsHtml(value, { withDefault: true }));
        }
        await setCharVoice(chid, { [name]: type === 'checkbox' ? checked : value });
        if (name === 'enabled') toastr.success(checked ? `Voice calls enabled for ${ch.name}` : `Voice calls disabled for ${ch.name}`, 'TavernVoice');
    });
    $el.find('.tv-preview').on('click', async () => {
        await setCharVoice(chid, { notes: $el.find('[name=notes]').val() });
        speakOnce(`Hey, it's ${ch.name}. [laugh] It's really nice to finally hear your voice!`, chid);
    });
    await c.callGenericPopup($el, c.POPUP_TYPE.TEXT, '', { okButton: 'Done', leftAlign: true, wide: false });
    await setCharVoice(chid, { notes: String($el.find('[name=notes]').val() ?? '') });
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

/** Voice the lab plays; independent of the default so trying voices changes nothing. */
let labVoice = '';

function renderVoicePickers() {
    const s = settings();
    labVoice ||= s.defaultVoice;
    $('#tv_default_voice').html(voiceOptionsHtml(s.defaultVoice));
    $('#tv_lab_voice').html(voiceOptionsHtml(labVoice));
    const v = voiceList.find(x => x.voice_id === labVoice);
    const { provider, id } = parseVoice(labVoice);
    const kind = v ? (v.provider === 'xai' && v.custom ? 'Your custom xAI voice' : `${PROVIDERS[provider]} voice`) : `${PROVIDERS[provider]} voice ID not in the list`;
    const plain = router.tagStyle(labVoice) === 'plain' ? 'speaks without voice tags' : '';
    $('#tv_lab_info').text([kind, `id ${id}`, v?.gender, v?.language, plain].filter(Boolean).join(' · '));
}

const STATUS_PILLS = { xai: '#tv_status', elevenlabs: '#tv_status_elevenlabs', heygen: '#tv_status_heygen', cartesia: '#tv_status_cartesia' };

/** Loads each provider's voices into the pickers. Providers other than xAI are skipped until they have a key. */
async function loadVoices({ quiet = false, providers = Object.keys(PROVIDERS) } = {}) {
    const wanted = [];
    for (const p of providers) {
        const pill = $(STATUS_PILLS[p]).removeClass('tv-ok tv-bad');
        if (p !== 'xai' && !(await hasKey(p))) {
            pill.text('No key');
            voiceList = voiceList.filter(v => v.provider !== p);
            continue;
        }
        pill.text('Checking key…');
        wanted.push(p);
    }
    for (const { provider, voices, error } of await router.voices(wanted)) {
        const pill = $(STATUS_PILLS[provider]);
        const label = PROVIDERS[provider];
        if (error) {
            pill.text(error?.status === 401 ? 'No key / invalid key' : 'Not connected').addClass('tv-bad');
            if (!quiet) toastr.error(error?.message || String(error), 'TavernVoice');
            continue;
        }
        if (voices.length || provider !== 'xai') voiceList = [...voiceList.filter(v => v.provider !== provider), ...voices];
        const mine = voiceList.filter(v => v.provider === provider);
        const custom = mine.filter(v => v.custom).length;
        const languages = router.listedLanguages(provider);
        const where = languages ? ` in ${languages.join(', ') || 'no language'}` : '';
        const count = `${mine.length} voice${mine.length === 1 ? '' : 's'}`;
        pill.text(`Connected · ${count}${where}${custom ? ` (${custom} custom)` : ''}`).addClass('tv-ok');
        if (quiet) continue;
        if (mine.length) toastr.success(`${label} key works. ${count} available.`, 'TavernVoice');
        else toastr.warning(`${label} key works, but no voices were found${where}. Check the voice languages.`, 'TavernVoice');
    }
    renderVoicePickers();
}

async function loadMicDevices() {
    const sel = $('#tv_mic_device');
    try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
        const current = settings().micDeviceId;
        sel.html(['<option value="">System default</option>', ...devices.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === current ? 'selected' : ''}>${$('<span>').text(d.label || `Microphone ${i + 1}`).html()}</option>`)].join(''));
    } catch {
        sel.html('<option value="">System default</option>');
    }
}

async function refreshSettingsCharacter() {
    const box = $('#tv_current_char');
    if (!box.length) return;
    const c = ctx();
    if (c.groupId) {
        box.html('<i>Group chat open. Voice calls work in one-on-one chats only.</i>');
        return;
    }
    if (c.characterId === undefined || c.characterId === null) {
        box.html('<i>No character selected.</i>');
        return;
    }
    const cfg = await getCharVoice(c.characterId);
    const name = $('<span>').text(c.characters[c.characterId].name).html();
    const v = resolveVoice(cfg);
    const voice = $('<span>').text(`${voiceName(v.voice)} (${PROVIDERS[parseVoice(v.voice).provider]})`).html();
    box.html(`<b>${name}</b>: calls <b class="${cfg.enabled ? 'tv-ok' : 'tv-bad'}">${cfg.enabled ? 'ON' : 'OFF'}</b> · voice <code>${voice}</code> · ${$('<span>').text(v.language).html()}
        <div class="menu_button menu_button_icon tv-open-char"><i class="fa-solid fa-phone"></i><span>Character voice settings</span></div>`);
}

const LIVE_KEYS = new Set(['volume', 'sensitivity', 'endSilenceMs']);

let helperModels = [];

async function loadHelperModels(refresh = false) {
    try {
        const res = await fetch(`${helperBase()}/helper/models${refresh ? '?refresh=true' : ''}`, { headers: helperHeaders() });
        if (!res.ok) throw new Error(res.statusText);
        helperModels = (await res.json()).models || [];
    } catch {
        helperModels = [];
    }
    renderHelperModels();
}

function renderHelperModels() {
    const s = settings();
    const filter = String($('#tv_helper_filter').val() || '').toLowerCase();
    const list = helperModels.filter(m => !filter || String(m.id).toLowerCase().includes(filter));
    const price = (m) => (m.input_price != null ? ` · $${m.input_price}/$${m.output_price} per M` : '');
    const options = list.slice(0, 400).map(m =>
        `<option value="${$('<span>').text(m.id).html()}" ${m.id === s.helperModel ? 'selected' : ''}>${$('<span>').text(m.id).html()}${price(m)}</option>`);
    if (s.helperModel && !list.some(m => m.id === s.helperModel)) {
        options.unshift(`<option value="${$('<span>').text(s.helperModel).html()}" selected>${$('<span>').text(s.helperModel).html()}</option>`);
    }
    $('#tv_helper_model').html(options.join('') || '<option value="">Bridge default</option>');
    $('#tv_helper_status').text(helperModels.length ? `${helperModels.length} models from ${helperBase()}` : `Bridge not reachable at ${helperBase()}`);
}

function bindSettings() {
    const s = settings();
    const root = $('#tavern_voice_settings');

    // A model saved by hand that isn't listed stays selectable.
    const modelOptions = (sel, models, current) => {
        $(sel).html(models.map(([id, label]) => `<option value="${id}">${label}</option>`).join(''));
        const esc = $('<span>').text(current).html();
        if (!models.some(([id]) => id === current)) $(sel).append(`<option value="${esc}">${esc}</option>`);
    };
    modelOptions('#tv_eleven_model', ELEVEN_MODELS, s.elevenModel);
    modelOptions('#tv_cartesia_model', CARTESIA_MODELS, s.cartesiaModel);
    root.find('[data-tv]').each((_, el) => {
        const key = el.dataset.tv;
        if (el.type === 'checkbox') el.checked = !!s[key];
        else el.value = s[key];
    });
    renderVoicePickers();
    $('#tv_language').html(languageOptionsHtml(s.language));
    const showRanges = () => root.find('[data-tv-out]').each((_, el) => { el.textContent = s[el.dataset.tvOut]; });
    showRanges();

    root.on('input change', '[data-tv]', (e) => {
        const el = e.target;
        const key = el.dataset.tv;
        let value = el.type === 'checkbox' ? el.checked : el.value;
        if (value === CUSTOM_VOICE) {
            if (e.type !== 'change') return;
            askCustomVoice(s[key]).then((id) => {
                if (id) s[key] = id;
                $(el).html(voiceOptionsHtml(s[key]));
                saveSettings();
                if (call && LIVE_KEYS.has(key)) call.applySettings();
            });
            return;
        }
        if (el.type === 'range' || el.type === 'number') value = Number(value);
        if (s[key] === value) return;
        s[key] = value;
        if (key === 'apiKey') stSecretCache = undefined;
        showRanges();
        saveSettings();
        if (call && LIVE_KEYS.has(key)) call.applySettings();
        if (call && key === 'helperTags') call.applyPrompt(false);
        if (key === 'prettifyTags' && !call) ctx().reloadCurrentChat();
        if (key === 'helperBridgeUrl' || key === 'helperBridgeToken') loadHelperModels();
        if (key === 'elevenModel') renderVoicePickers();
    });
    // Text fields save on every keystroke; their voices reload once the field is left.
    root.on('change', '[data-tv=elevenKey], [data-tv=elevenBase]', () => loadVoices({ quiet: true, providers: ['elevenlabs'] }));
    root.on('change', '[data-tv=heygenKey], [data-tv=heygenBase], [data-tv=heygenLanguages]', () => loadVoices({ quiet: true, providers: ['heygen'] }));
    root.on('change', '[data-tv=cartesiaKey], [data-tv=cartesiaBase], [data-tv=cartesiaLanguages]', () => loadVoices({ quiet: true, providers: ['cartesia'] }));

    $('#tv_helper_refresh').on('click', () => loadHelperModels(true));
    $('#tv_helper_filter').on('input', () => renderHelperModels());
    $('#tv_helper_test').on('click', async () => {
        const $out = $('#tv_helper_out').text('Asking the helper…');
        const line = 'Wait, you actually drove all the way here just to see me?';
        const started = performance.now();
        const tagged = await helperTag(line, { char: 'Test', timeoutMs: 15000 });
        const ms = Math.round(performance.now() - started);
        $out.text(tagged === line ? `No tags added (${ms} ms). Check the bridge URL, or the model kept it plain.` : `${tagged}  (${ms} ms)`);
    });
    loadHelperModels();

    $('#tv_test_key').on('click', () => loadVoices({ providers: ['xai'] }));
    root.on('click', '.tv-test-provider', (e) => loadVoices({ providers: [e.currentTarget.dataset.provider] }));
    $('#tv_use_st_key').on('click', async () => {
        stSecretCache = undefined;
        const key = await readStSecret();
        if (key) {
            s.apiKey = key;
            $('#tv_api_key').val(key);
            saveSettings();
            toastr.success('Imported the xAI key saved in SillyTavern.', 'TavernVoice');
            loadVoices({ quiet: true, providers: ['xai'] });
        } else {
            toastr.warning('Could not read it. Save an xAI key under API Connections and set allowKeysExposure: true in config.yaml, or paste the key here.', 'TavernVoice');
        }
    });
    root.on('click', '.tv-toggle-key', (e) => {
        const input = $(`#${e.currentTarget.dataset.for}`);
        input.attr('type', input.attr('type') === 'password' ? 'text' : 'password');
    });
    // Voice lab: play any voice with your own line; the play button doubles as stop.
    const labPlay = $('#tv_lab_play');
    const labPlaying = (on) => labPlay.toggleClass('fa-play', !on).toggleClass('fa-stop', on).attr('title', on ? 'Stop' : 'Play this voice');
    oneShot.addEventListener('idle', () => labPlaying(false));
    oneShot.addEventListener('stopped', () => labPlaying(false));
    labPlay.on('click', () => {
        if (oneShot.busy) return oneShot.stop();
        getAudioContext();
        oneShot.setVolume(s.volume);
        const text = String(s.labText || '').trim() || DEFAULTS.labText;
        oneShot.enqueue((signal) => router.tts({ text, voice: labVoice, language: s.language, speed: s.speed, signal }), { text });
        labPlaying(true);
    });
    $('#tv_lab_voice').on('change', async (e) => {
        labVoice = e.target.value === CUSTOM_VOICE ? (await askCustomVoice(labVoice)) || labVoice : e.target.value;
        renderVoicePickers();
    });
    $('#tv_lab_refresh').on('click', () => loadVoices());
    $('#tv_lab_default').on('click', () => {
        s.defaultVoice = labVoice;
        saveSettings();
        renderVoicePickers();
        toastr.success(`${voiceName(labVoice)} is now the default voice.`, 'TavernVoice');
    });
    $('#tv_refresh_mics').on('click', async () => {
        try {
            // Labels are only visible after mic permission has been granted once.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
        } catch (err) {
            toastr.error(micErrorMessage(err), 'TavernVoice');
        }
        loadMicDevices();
    });
    $('#tv_reset_prompt').on('click', () => {
        s.promptTemplate = DEFAULT_CALL_PROMPT;
        $('#tv_prompt_template').val(DEFAULT_CALL_PROMPT);
        saveSettings();
    });
    root.on('click', '.tv-open-char', () => openCharacterPopup(ctx().characterId));

    if (!window.isSecureContext) $('#tv_insecure').text(INSECURE_PAGE_MESSAGE).removeClass('displayNone');

    loadMicDevices();
    refreshSettingsCharacter();
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecall',
        callback: async () => {
            getAudioContext();
            if (call) call.end('Hung up');
            else await startCall();
            return '';
        },
        helpString: 'Start a TavernVoice call with the current character, or hang up if one is active.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hangup',
        callback: () => {
            call?.end('Hung up');
            return '';
        },
        helpString: 'End the active TavernVoice call.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicesay',
        callback: async (_args, text) => {
            await speakOnce(String(text ?? ''), ctx().characterId);
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'text to speak', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'Speak text with the current character\'s voice. Speech tags like [laugh] and <whisper>…</whisper> work with Grok and ElevenLabs v3/v4 voices.',
    }));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function isEditable(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function bindPttKey() {
    window.addEventListener('keydown', (e) => {
        if (!call || call.inputMode !== 'ptt' || e.repeat || e.code !== settings().pttKey || isEditable(e.target)) return;
        e.preventDefault();
        call.mic.pttDown();
    });
    window.addEventListener('keyup', (e) => {
        if (!call || call.inputMode !== 'ptt' || e.code !== settings().pttKey) return;
        call.mic.pttUp();
    });
}

jQuery(async () => {
    const c = ctx();
    const et = c.eventTypes;
    settings();

    const html = await (await fetch(new URL('./settings.html', import.meta.url))).text();
    $('#extensions_settings2').append(html);
    bindSettings();

    // Call button in the chat bar, left of the send button.
    $('#send_but').before('<div id="tv_call_button" class="fa-solid fa-phone interactable displayNone" tabindex="0" title="Voice call"></div>');
    $('#tv_call_button').on('click', () => {
        getAudioContext(); // must happen inside the click for Safari
        if (call) call.end('Hung up');
        else startCall();
    });

    // Phone toggle in the character card's button row.
    $('.form_create_bottom_buttons_block').first().append('<div id="tv_char_button" class="menu_button fa-solid fa-phone displayNone" title="Voice calls"></div>');
    $('#tv_char_button').on('click', () => openCharacterPopup(ctx().characterId));

    // Replay-with-voice button on every message.
    $('#message_template .mes_buttons .extraMesButtons').prepend('<div title="Play with the call voice" class="mes_button tv_mes_play fa-solid fa-phone-volume" data-i18n="[title]Play with the call voice"></div>');
    $(document).on('click', '.tv_mes_play', function () {
        const id = Number($(this).closest('.mes').attr('mesid'));
        const msg = ctx().chat[id];
        if (!msg) return;
        if (oneShot.busy) {
            oneShot.stop();
            return;
        }
        speakOnce(msg.mes, characterForMessage(msg));
    });

    const refreshAll = () => {
        refreshCallButton();
        refreshCharButton();
        refreshSettingsCharacter();
    };
    c.eventSource.on(et.CHAT_CHANGED, () => {
        refreshAll();
        setTimeout(decorateAll, 100);
    });
    c.eventSource.on(et.CHARACTER_EDITOR_OPENED, refreshCharButton);
    c.eventSource.on(et.CHARACTER_EDITED, refreshAll);
    c.eventSource.on(et.CHARACTER_MESSAGE_RENDERED, (id) => decorateMessage(id));
    c.eventSource.on(et.USER_MESSAGE_RENDERED, (id) => decorateMessage(id));
    c.eventSource.on(et.MESSAGE_UPDATED, (id) => decorateMessage(id));
    c.eventSource.on(et.MESSAGE_SWIPED, (id) => setTimeout(() => decorateMessage(id), 0));
    if (et.MORE_MESSAGES_LOADED) c.eventSource.on(et.MORE_MESSAGES_LOADED, decorateAll);

    bindPttKey();
    registerSlashCommands();
    registerTagFormatter();
    refreshAll();
    const s = settings();
    const keyed = Object.entries({ xai: s.apiKey, elevenlabs: s.elevenKey, heygen: s.heygenKey, cartesia: s.cartesiaKey }).filter(([, k]) => k?.trim()).map(([p]) => p);
    if (keyed.length) loadVoices({ quiet: true, providers: keyed });

    // Small debugging surface for the browser console.
    globalThis.TavernVoice = {
        get call() { return call; },
        start: startCall,
        hangup: () => call?.end('Hung up'),
        say: (text) => call ? call.handleUtterance(text, { voice: true }) : toastr.info('No active call', 'TavernVoice'),
        speak: (text) => speakOnce(text, ctx().characterId),
        settings,
        toSpeechText,
    };
    console.log(TAG, 'loaded');
});
