// The floating call window. Pure DOM; emits intent events, holds no call logic.

const PHASE_LABELS = {
    ringing: 'Calling…',
    connecting: 'Connecting…',
    listening: 'Listening',
    ptt: 'Hold the mic to talk',
    user: 'Hearing you…',
    transcribing: 'Got it…',
    thinking: '{name} is thinking…',
    speaking: '{name}',
    ended: 'Call ended',
};

const POS_KEY = 'tavernvoice.callpos';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function formatDuration(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/**
 * Events: hangup, mute, speaker, mode, pttdown, pttup, send {text}, media {kind}
 */
export class CallUI extends EventTarget {
    mount({ name, avatarUrl, inputMode = 'open', captions = true, media = false }) {
        this.name = name;
        this.inputMode = inputMode;
        const root = document.createElement('div');
        root.id = 'tv-call';
        root.className = 'tv-call';
        root.dataset.phase = 'ringing';
        root.dataset.mode = inputMode;
        root.classList.toggle('tv-no-captions', !captions);
        root.innerHTML = `
            <div class="tv-head" title="Drag to move">
                <span class="tv-live"><i class="tv-dot"></i><span class="tv-timer">00:00</span></span>
                <span class="tv-title">Voice call</span>
                <button type="button" class="tv-icon tv-min" title="Minimize"><i class="fa-solid fa-minus"></i></button>
            </div>
            <div class="tv-body">
                <div class="tv-avatar-wrap">
                    <div class="tv-ring tv-ring-ai"></div>
                    <div class="tv-ring tv-ring-user"></div>
                    <img class="tv-avatar" alt="" src="${esc(avatarUrl)}">
                </div>
                <div class="tv-name">${esc(name)}</div>
                <div class="tv-status" aria-live="polite">Calling…</div>
                <div class="tv-captions">
                    <div class="tv-cap tv-cap-ai"></div>
                    <div class="tv-cap tv-cap-user"></div>
                </div>
                <div class="tv-media-status tv-empty"></div>
                <div class="tv-media tv-empty"></div>
            </div>
            <div class="tv-media-bar"${media ? '' : ' hidden'}>
                <button type="button" class="tv-pill tv-send-photo" title="Ask for a photo of this moment"><i class="fa-solid fa-image"></i> Photo</button>
                <button type="button" class="tv-pill tv-send-video" title="Ask for a video of this moment"><i class="fa-solid fa-film"></i> Video</button>
            </div>
            <div class="tv-controls">
                <button type="button" class="tv-btn tv-mic" title="Mute microphone"><i class="fa-solid fa-microphone"></i></button>
                <button type="button" class="tv-btn tv-mode" title="Switch between open mic and push-to-talk"><i class="fa-solid fa-hand"></i></button>
                <button type="button" class="tv-btn tv-speaker" title="Mute speaker"><i class="fa-solid fa-volume-high"></i></button>
                <button type="button" class="tv-btn tv-keyboard" title="Type a message"><i class="fa-solid fa-keyboard"></i></button>
                <button type="button" class="tv-btn tv-end" title="Hang up"><i class="fa-solid fa-phone-slash"></i></button>
            </div>
            <form class="tv-type" autocomplete="off">
                <input type="text" class="text_pole" placeholder="Type while on the call…" enterkeyhint="send">
                <button type="submit" class="tv-icon" title="Send"><i class="fa-solid fa-paper-plane"></i></button>
            </form>`;
        document.body.appendChild(root);
        this.root = root;
        this.$ = (sel) => root.querySelector(sel);
        this.#bind();
        this.#restorePosition();
        this.setInputMode(inputMode);
    }

    #emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    #bind() {
        const mic = this.$('.tv-mic');
        // In push-to-talk mode the mic button is press-and-hold; otherwise it toggles mute.
        mic.addEventListener('pointerdown', (e) => {
            if (this.inputMode !== 'ptt') return;
            e.preventDefault();
            mic.setPointerCapture?.(e.pointerId);
            this.#emit('pttdown');
        });
        const up = () => this.inputMode === 'ptt' && this.#emit('pttup');
        mic.addEventListener('pointerup', up);
        mic.addEventListener('pointercancel', up);
        mic.addEventListener('click', () => this.inputMode !== 'ptt' && this.#emit('mute'));
        mic.addEventListener('contextmenu', (e) => e.preventDefault());

        this.$('.tv-mode').addEventListener('click', () => this.#emit('mode'));
        this.$('.tv-speaker').addEventListener('click', () => this.#emit('speaker'));
        this.$('.tv-end').addEventListener('click', () => this.#emit('hangup'));
        this.$('.tv-keyboard').addEventListener('click', () => {
            const open = this.root.classList.toggle('tv-typing');
            if (open) this.$('.tv-type input').focus();
        });
        this.$('.tv-min').addEventListener('click', () => this.root.classList.toggle('tv-minimized'));
        this.$('.tv-send-photo').addEventListener('click', () => this.#emit('media', { kind: 'image' }));
        this.$('.tv-send-video').addEventListener('click', () => this.#emit('media', { kind: 'video' }));
        this.$('.tv-media').addEventListener('click', (e) => {
            if (e.target.closest('.tv-media-close')) {
                this.$('.tv-media').classList.add('tv-empty');
                this.$('.tv-media').replaceChildren();
            } else if (e.target.tagName === 'IMG') {
                this.root.classList.toggle('tv-media-big');
            }
        });
        this.$('.tv-type').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = this.$('.tv-type input');
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            this.#emit('send', { text });
        });
        this.#bindDrag();
    }

    #bindDrag() {
        const head = this.$('.tv-head');
        let start = null;
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button') || window.matchMedia('(max-width: 600px)').matches) return;
            const r = this.root.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!start) return;
            this.#place(start.left + e.clientX - start.x, start.top + e.clientY - start.y);
        });
        const end = () => {
            if (!start) return;
            start = null;
            const r = this.root.getBoundingClientRect();
            try { localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top })); } catch { /* storage blocked */ }
        };
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
    }

    #place(left, top) {
        const r = this.root.getBoundingClientRect();
        const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, left));
        const y = Math.max(4, Math.min(window.innerHeight - 60, top));
        Object.assign(this.root.style, { left: `${x}px`, top: `${y}px`, right: 'auto', translate: 'none' });
    }

    #restorePosition() {
        try {
            const pos = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null');
            if (pos && !window.matchMedia('(max-width: 600px)').matches) this.#place(pos.left, pos.top);
        } catch { /* storage blocked or corrupt */ }
    }

    setPhase(phase, detail = '') {
        if (!this.root) return;
        this.root.dataset.phase = phase;
        const label = phase === 'listening' && this.inputMode === 'ptt' ? PHASE_LABELS.ptt : (PHASE_LABELS[phase] ?? phase);
        this.$('.tv-status').textContent = detail || label.replace('{name}', this.name);
    }

    setTimer(sec) {
        if (this.root) this.$('.tv-timer').textContent = formatDuration(sec);
    }

    setConnected() {
        this.root?.classList.add('tv-connected');
    }

    setMicLevel(level) {
        this.root?.style.setProperty('--tv-mic', level.toFixed(3));
    }

    setAiLevel(level) {
        this.root?.style.setProperty('--tv-ai', level.toFixed(3));
    }

    /** @param {string} html Already-escaped caption HTML */
    setAiCaption(html) {
        if (!this.root) return;
        const el = this.$('.tv-cap-ai');
        el.innerHTML = html;
        el.classList.toggle('tv-empty', !html);
    }

    setUserCaption(text, interim = false) {
        if (!this.root) return;
        const el = this.$('.tv-cap-user');
        el.textContent = text;
        el.classList.toggle('tv-interim', interim);
        el.classList.toggle('tv-empty', !text);
    }

    /** A photo or video that arrived during the call; the chat behind the window can't show it. */
    showMedia({ url, type }) {
        if (!this.root || !url) return;
        const box = this.$('.tv-media');
        const media = document.createElement(type === 'video' ? 'video' : 'img');
        media.src = url;
        if (type === 'video') Object.assign(media, { controls: true, loop: true, playsInline: true, muted: true, autoplay: true });
        else media.alt = '';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tv-icon tv-media-close';
        close.title = 'Hide';
        close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        box.replaceChildren(media, close);
        box.classList.remove('tv-empty');
        if (this.root.classList.contains('tv-minimized')) this.root.classList.remove('tv-minimized');
    }

    /** "Photo: Rendering on NanoGPT…" while media is being made, '' when done. */
    setMediaStatus(text) {
        if (!this.root) return;
        const el = this.$('.tv-media-status');
        el.textContent = text || '';
        el.classList.toggle('tv-empty', !text);
    }

    setMuted(muted) {
        if (!this.root) return;
        this.root.classList.toggle('tv-muted', muted);
        this.$('.tv-mic i').className = `fa-solid ${muted ? 'fa-microphone-slash' : 'fa-microphone'}`;
        this.$('.tv-mic').title = muted ? 'Unmute microphone' : 'Mute microphone';
    }

    setSpeakerMuted(muted) {
        if (!this.root) return;
        this.$('.tv-speaker i').className = `fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}`;
        this.$('.tv-speaker').classList.toggle('tv-off', muted);
    }

    setInputMode(mode) {
        if (!this.root) return;
        this.inputMode = mode;
        this.root.dataset.mode = mode;
        const ptt = mode === 'ptt';
        this.$('.tv-mode').classList.toggle('tv-on', ptt);
        this.$('.tv-mode').title = ptt ? 'Push-to-talk is on (click for open mic)' : 'Open mic is on (click for push-to-talk)';
        this.$('.tv-mic').title = ptt ? 'Hold to talk' : 'Mute microphone';
        if (this.root.dataset.phase === 'listening') this.setPhase('listening');
    }

    setPttActive(on) {
        this.root?.classList.toggle('tv-ptt-active', on);
    }

    destroy() {
        this.root?.remove();
        this.root = null;
    }
}
