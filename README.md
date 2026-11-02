# TavernVoice: Voice Calls for SillyTavern

Call your character like a phone call. Press the phone button and they pick up. You talk; your voice is transcribed by **xAI Grok speech-to-text** and sent to whatever LLM SillyTavern is using. The reply is spoken back with **Grok text-to-speech**, or with an **ElevenLabs** or **HeyGen** voice, including expressive speech tags like `[laugh]`, `[sigh]` and `<whisper>…</whisper>`. You can keep typing during the call too.

## Features

- **One-tap calls** from the chat bar, with ringing, pick-up and hang-up sounds and a call timer
- **Per-character switch** stored on the character card (`data.extensions.tavern_voice`), so it travels with exported cards. Each card can also set its own voice, language, speed and "how they sound on the phone" notes
- **One-on-one chats only**: the call button is hidden in group chats
- **Streaming speech**: the reply is spoken sentence by sentence while the LLM is still writing it
- **Grok speech tags**: the LLM is told it is on a live call and how to use all 14 inline sound tags and 12 wrapping style tags. `*laughs*`-style roleplay actions are converted into real sounds (`[laugh]`), and other narration is not read aloud
- **Interrupting (barge-in)**: start talking and the character stops mid-sentence, like a real person
- **Open mic or push-to-talk**: hands-free with voice-activity detection, or hold the mic button (or a hotkey)
- **Live transcription**: streams your voice to Grok STT with Smart Turn end-of-turn detection, and falls back to standard transcription automatically when streaming isn't available
- **Text during the call**: use the call window's keyboard, or SillyTavern's normal chat box. Either way the reply is spoken
- **Live captions** in the call window, a 🎙 badge on messages you said by voice, and speech tags shown as chips in chat
- **▶ Play with the call voice** button on every message, usable outside calls too
- **Three voice providers**: xAI Grok, ElevenLabs and HeyGen. Each character (and each person on a story card) can use a voice from any of them. ElevenLabs and HeyGen speak languages Grok doesn't, such as **Malayalam**
- **Voice lab**: every voice your keys can use in one dropdown, grouped by provider (Grok built-ins, your xAI team's custom voices, your ElevenLabs library, HeyGen voices in the languages you pick), with your own test line and a play button, so you can audition voices without touching your settings
- **Voice director (optional)**: the [Flux LoRA Bridge](https://github.com/Deathwalker-47/Silly-Tavern-Flux-Bridge)'s helper LLM adds the speech tags, so your main LLM can write plain dialogue
- Slash commands: `/voicecall`, `/hangup`, `/voicesay <text>`
- Works on phones: the call window becomes a bottom sheet

## Install

1. In SillyTavern open **Extensions** (the stacked-blocks icon) → **Install extension**, and paste `https://github.com/Deathwalker-47/TavernVoice`.
   Or copy this folder to `SillyTavern/data/<your-user>/extensions/TavernVoice` (or `public/scripts/extensions/third-party/TavernVoice`) and reload.
2. Open **Extensions → TavernVoice: Voice Calls** and paste your xAI API key ([console.x.ai](https://console.x.ai)). Click **Test key & load voices**. Calls always need it: Grok is what hears you.
   If your xAI key is already saved under API Connections and `allowKeysExposure: true` is set in `config.yaml`, **Use SillyTavern's xAI key** imports it.
   Optional: paste an [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) and/or [HeyGen](https://app.heygen.com/settings?nav=API) key under *Voice providers* for their voices.
3. Open a character, click the **📞 phone button** in the character card's button row, and tick **Enable voice calls for this character**. Pick a voice and click **Preview voice**.
4. In that character's chat a 📞 appears left of the send button. Click it to call.

> **Microphone access needs a secure page.** Open SillyTavern at `http://localhost:8000` or over HTTPS. Browsers block the mic on plain `http://<ip>:8000` addresses, and the settings panel shows a red warning when that's the case.

### SillyTavern on a remote server (VPS, Hetzner, …)

1. Install the extension on the server:
   ```bash
   cd SillyTavern/data/default-user/extensions
   git clone https://github.com/Deathwalker-47/TavernVoice TavernVoice
   ```
   Then reload SillyTavern in the browser. To update later, run `git pull` in that folder, or use **Extensions → Manage extensions → Update**.
2. Serve SillyTavern over HTTPS. The simplest option is [Caddy](https://caddyserver.com), which gets a Let's Encrypt certificate automatically. Point a domain at the server and use this Caddyfile:
   ```
   tavern.example.com {
       reverse_proxy localhost:8000
   }
   ```
   Tailscale (`tailscale serve`) or a Cloudflare Tunnel also work if you don't want to expose a domain.

Audio never passes through your server. The browser talks to `api.x.ai` directly, so the server's location doesn't add voice latency.

## Using a call

| Control | What it does |
|---|---|
| 🎤 | Mute or unmute. In push-to-talk mode, **hold** it to talk |
| ✋ | Switch between open mic and push-to-talk |
| 🔊 | Mute the character's voice |
| ⌨️ | Type a message without leaving the call |
| ☎️ (red) | Hang up |
| − | Minimize to a slim bar. Drag the header to move the window |

Tips:
- **Use headphones** if the character keeps interrupting itself. Echo cancellation is on, but loud speakers can leak into the mic. You can also turn off *Let me interrupt the character* (half-duplex).
- If it cuts you off mid-sentence, raise **Pause before your turn ends** or keep **Smart turn detection** on.
- If it doesn't hear you, raise **Mic sensitivity**. If background noise triggers it, lower it.
- Calls are noted in the chat (`📞 … started a voice call`), so the AI knows a call happened. Turn this off under *Call behavior*.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Default voice / language / speed | `eve`, `en`, `1.0×` | The character card can override each one. Every voice list ends with *Enter a voice ID…* for IDs that aren't listed: a plain ID is an xAI voice, `elevenlabs:<id>` and `heygen:<id>` are the others |
| ElevenLabs model | Eleven v4 Turbo | v4 Turbo and v3 Conversational are fast enough for calls, read voice tags and speak Malayalam. Flash v2.5 and Multilingual v2 speak without tags |
| HeyGen voice languages | `Malayalam` | HeyGen's library has thousands of voices, so only these languages (HeyGen's names, comma-separated) are listed. HeyGen voices speak without tags, so the AI is told to write plain speech for them |
| Voice lab | — | Pick any voice, edit the test line, press ▶ (press again to stop). *Make this the default voice* copies it to Default voice. ⟳ reloads the list, e.g. after xAI adds custom voices to your team. Voice cloning is US-only at xAI |
| Voice director | Off | Needs the Flux LoRA Bridge with a helper LLM key. Bridge URL empty = Media Studio's bridge. The first sentence waits at most *Max wait* for tags, later ones are tagged while earlier ones play |
| Expressiveness | Full | *Subtle* keeps only laugh/sigh/pause/whisper. *None* means plain speech |
| What gets read aloud | Speech only | Skips `*actions*`. *Quoted dialogue only* suits narrated cards. *Everything* reads narration too |
| Turn \*actions\* into sounds | On | `*giggles*` → `[giggle]`, `*sighs*` → `[sigh]`, … |
| Talk mode | Open mic | Or push-to-talk. Hotkey defaults to the `` ` `` key (`Backquote`) |
| Transcription | Live with fallback | *Standard* sends audio after you stop talking |
| Call prompt | built-in | Edit freely. `{{voice_tags}}` and `{{voice_notes}}` are filled in automatically |
| API base URLs | `https://api.x.ai/v1`, `https://api.elevenlabs.io`, `https://api.heygen.com` | For a proxy or the local mock (see Development) |

### Other languages (Malayalam and more)

Pick an ElevenLabs or HeyGen voice and set the character's **Language** to the language it should speak (Malayalam, Tamil, Telugu, Kannada, Marathi, Gujarati, Punjabi and Urdu are listed under *ElevenLabs and HeyGen voices only*). Write the card so the character replies in that language. Grok STT doesn't list Malayalam, so for those languages it auto-detects what you say instead of being told the language.

### Speech tags (from the xAI docs)

The AI always writes Grok's tags. For ElevenLabs v3/v4 voices they are rewritten as ElevenLabs audio tags (`[laugh]` → `[laughs]`, `<whisper>secret</whisper>` → `[whispers] secret`, `<emphasis>` → capitals). Voices that can't do tags get none: the call prompt tells the AI to write plain speech, and pauses become "…".

- **Inline**: `[pause]` `[long-pause]` `[hum-tune]` `[laugh]` `[chuckle]` `[giggle]` `[cry]` `[tsk]` `[tongue-click]` `[lip-smack]` `[breath]` `[inhale]` `[exhale]` `[sigh]`
- **Wrapping**: `<soft>` `<whisper>` `<loud>` `<build-intensity>` `<decrease-intensity>` `<higher-pitch>` `<lower-pitch>` `<slow>` `<fast>` `<sing-song>` `<singing>` `<emphasis>`

Common LLM spellings are normalized (`[laughs]` → `[laugh]`, `<whispers>` → `<whisper>`). Unknown `[brackets]` such as `[OOC: …]` are never read aloud. A `<whisper>` that spans two sentences is closed and reopened, so each TTS request stays well-formed.

## How it works

```
 mic ─► AudioWorklet (20 ms frames) ─► 16 kHz PCM ─┬─► wss://api.x.ai/v1/stt  (live, Smart Turn)
                                                    └─► VAD ─► WAV ─► POST /v1/stt (fallback)
                                                                     │ transcript
                                                                     ▼
                         SillyTavern send pipeline ─► your LLM (streaming) + injected call prompt
                                                                     │ tokens
                                                                     ▼
       sentence chunker + tag cleaner ─► POST /v1/tts (MP3, prefetched) ─► gapless WebAudio playback
```

- Calls go straight from the browser to `api.x.ai`, `api.elevenlabs.io` and `api.heygen.com`, which all allow CORS. No server plugin is needed. HeyGen answers with a link to an MP3, which the browser then fetches from `files.heygen.ai`.
- Browsers can't send an `Authorization` header on WebSockets, so live transcription authenticates with an ephemeral client secret in the `Sec-WebSocket-Protocol` header (`xai-client-secret.<token>`), the method xAI documents for browser voice apps. If that fails, the extension silently uses standard transcription.
- User messages go through SillyTavern's normal send path, so regex scripts, quick replies and the rest keep working. Any draft in your chat box is preserved.

## Privacy & cost

- Your API keys are stored in SillyTavern's settings file in plain text (like other extension settings), and each is sent only to its own provider.
- Live transcription streams microphone audio for the whole call. Standard transcription only uploads the parts where you speak. Grok STT is billed per audio hour; Grok and ElevenLabs TTS per character, HeyGen against your speech quota. Check each provider's pricing.

## Development

```bash
npm test             # unit tests (Node 18+): text cleanup, chunking, tags, DSP, VAD, voice provider clients
npm run mock         # fake xAI, ElevenLabs, HeyGen + OpenAI-compatible LLM on http://localhost:8787
```

To test without keys, run the mock and set **xAI API base URL** to `http://localhost:8787/v1` and the ElevenLabs and HeyGen base URLs to `http://localhost:8787`, with any keys. For a fake LLM, use Chat Completion → Custom (OpenAI-compatible) → `http://localhost:8787/v1`. The mock logs every TTS/STT/LLM request, so you can see exactly what text would be spoken. `POST /mock/config {"tokenDelayMs":150}` slows the fake LLM down to test interruptions mid-generation.

Browser console helpers: `TavernVoice.say("hello")` simulates speech during a call, `TavernVoice.speak("text")` plays text in the current voice, and `TavernVoice.toSpeechText("*laughs* hi")` shows what would be spoken.

### Files

| File | Purpose |
|---|---|
| `index.js` | SillyTavern wiring: settings, card toggle, call session, events, slash commands |
| `src/xai.js` | xAI REST client (TTS, STT, voices, client secrets) and streaming STT socket |
| `src/elevenlabs.js`, `src/heygen.js` | ElevenLabs and HeyGen TTS and voice-list clients |
| `src/voices.js` | Voice IDs by provider, and the router that speaks any voice with the right tag style |
| `src/http.js` | fetch() with retries and readable errors, shared by the clients |
| `src/text.js` | Raw reply → speakable text, streaming sentence chunker, tag balancing, chat tag styling |
| `src/audio.js` | AudioContext, mic capture, speech playback queue, synthesized phone sounds |
| `src/dsp.js` | Resampler, PCM/WAV encoding, voice activity detector |
| `src/prompt.js` | The "you are on a live call" prompt and tag guide |
| `src/ui.js` | The floating call window |
| `dev/mock-xai.mjs` | Local mock server |
