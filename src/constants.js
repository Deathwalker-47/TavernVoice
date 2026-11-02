// Static data about the voice providers: xAI Grok (voices and listening), ElevenLabs and HeyGen (voices).
// Sources: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech (Oct 2026),
// https://elevenlabs.io/docs/models and https://developers.heygen.com/docs/voices/speech (Nov 2026)

export const EXTENSION_KEY = 'tavern_voice';          // extension_settings key + character card field
export const PROMPT_KEY = 'TAVERN_VOICE_CALL';          // setExtensionPrompt key
export const DEFAULT_API_BASE = 'https://api.x.ai/v1';
export const DEFAULT_ELEVEN_BASE = 'https://api.elevenlabs.io';
export const DEFAULT_HEYGEN_BASE = 'https://api.heygen.com';
export const STT_MODEL = 'grok-voice-transcribe-2.0';

/** ElevenLabs models worth using on a call, fastest and most expressive first. */
export const ELEVEN_MODELS = [
    ['eleven_v4_turbo', 'Eleven v4 Turbo: fast, voice tags, 90+ languages incl. Malayalam'],
    ['eleven_v3_conversational', 'Eleven v3 Conversational: fast, voice tags, 70+ languages incl. Malayalam'],
    ['eleven_flash_v2_5', 'Flash v2.5: fastest and cheapest, 32 languages, no voice tags'],
    ['eleven_multilingual_v2', 'Multilingual v2: steady, 29 languages, no voice tags'],
    ['eleven_v4', 'Eleven v4: most expressive, too slow for calls'],
];

/** Inline tags: dropped at a point in the text, e.g. "No way! [laugh] Really?" */
export const INLINE_TAGS = {
    'Pauses': ['pause', 'long-pause', 'hum-tune'],
    'Laughter & crying': ['laugh', 'chuckle', 'giggle', 'cry'],
    'Mouth sounds': ['tsk', 'tongue-click', 'lip-smack'],
    'Breathing': ['breath', 'inhale', 'exhale', 'sigh'],
};

/** Wrapping tags: wrap a phrase, e.g. "<whisper>It's a secret.</whisper>" */
export const WRAPPING_TAGS = {
    'Volume & intensity': ['soft', 'whisper', 'loud', 'build-intensity', 'decrease-intensity'],
    'Pitch & speed': ['higher-pitch', 'lower-pitch', 'slow', 'fast'],
    'Vocal style': ['sing-song', 'singing', 'emphasis'],
};

/** Tag subsets per "expressiveness" level. */
export const TAG_LEVELS = {
    none: { inline: [], wrapping: [] },
    subtle: {
        inline: ['pause', 'laugh', 'chuckle', 'sigh', 'breath'],
        wrapping: ['whisper', 'soft'],
    },
    full: {
        inline: Object.values(INLINE_TAGS).flat(),
        wrapping: Object.values(WRAPPING_TAGS).flat(),
    },
};

/**
 * Common LLM spellings mapped to the official tag. LLMs love "[laughs]" and "<whispers>".
 * Keys are matched case-insensitively after trimming.
 */
export const TAG_ALIASES = {
    'laughs': 'laugh', 'laughing': 'laugh', 'laughter': 'laugh',
    'chuckles': 'chuckle', 'chuckling': 'chuckle',
    'giggles': 'giggle', 'giggling': 'giggle',
    'cries': 'cry', 'crying': 'cry', 'sobs': 'cry', 'sob': 'cry', 'sobbing': 'cry',
    'sighs': 'sigh', 'sighing': 'sigh',
    'breathes': 'breath', 'breathing': 'breath', 'breathe': 'breath',
    'inhales': 'inhale', 'gasp': 'inhale', 'gasps': 'inhale',
    'exhales': 'exhale',
    'tsks': 'tsk',
    'clicks tongue': 'tongue-click', 'tongue click': 'tongue-click',
    'lip smack': 'lip-smack', 'smacks lips': 'lip-smack',
    'hums': 'hum-tune', 'hum': 'hum-tune', 'humming': 'hum-tune',
    'long pause': 'long-pause', 'pauses': 'pause',
    // wrapping
    'whispers': 'whisper', 'whispering': 'whisper', 'whispered': 'whisper',
    'softly': 'soft', 'quietly': 'soft',
    'loudly': 'loud', 'shouting': 'loud', 'shouts': 'loud', 'yelling': 'loud',
    'sings': 'singing', 'sing': 'singing',
    'singsong': 'sing-song',
    'slowly': 'slow', 'quickly': 'fast',
    'emphasize': 'emphasis', 'emphasized': 'emphasis', 'stress': 'emphasis',
};

/**
 * Verbs inside *roleplay actions* that map to an audible inline tag.
 * "*laughs softly*" -> "[laugh]". First match wins, so order matters.
 */
export const ACTION_SOUNDS = [
    [/\b(laugh(s|ing|ed)?|burst(s)? out laughing|cackl(e|es|ing))\b/i, 'laugh'],
    [/\bchuckl(e|es|ing|ed)\b/i, 'chuckle'],
    [/\bgiggl(e|es|ing|ed)\b/i, 'giggle'],
    [/\b(cr(y|ies|ying)|sob(s|bing)?|sniffl(e|es|ing)|tear(s|ing) up)\b/i, 'cry'],
    [/\bsigh(s|ing|ed)?\b/i, 'sigh'],
    [/\b(gasp(s|ing|ed)?|inhal(e|es|ing)|breath(es)? in)\b/i, 'inhale'],
    [/\b(exhal(e|es|ing)|breath(es)? out|blows? out a breath)\b/i, 'exhale'],
    [/\b(breath(e|es|ing)|pant(s|ing)?)\b/i, 'breath'],
    [/\btsk(s)?\b/i, 'tsk'],
    [/\bclick(s)? (her|his|their|my) tongue\b/i, 'tongue-click'],
    [/\b(smack(s)? (her|his|their|my) lips|lip smack)\b/i, 'lip-smack'],
    [/\bhum(s|ming)?\b/i, 'hum-tune'],
    [/\b(paus(e|es|ing)|falls? silent|goes quiet)\b/i, 'pause'],
];

/** Built-in voices; the live list is fetched from GET /v1/tts/voices when a key is set. */
export const FALLBACK_VOICES = [
    { voice_id: 'eve', name: 'Eve', description: 'Energetic, upbeat' },
    { voice_id: 'ara', name: 'Ara', description: 'Warm, friendly' },
    { voice_id: 'rex', name: 'Rex', description: 'Confident, clear' },
    { voice_id: 'sal', name: 'Sal', description: 'Smooth, balanced' },
    { voice_id: 'leo', name: 'Leo', description: 'Authoritative, strong' },
    { voice_id: 'sirius', name: 'Sirius', description: 'Commentary, characters' },
    { voice_id: 'zagan', name: 'Zagan', description: 'Characters, narration' },
    { voice_id: 'orion', name: 'Orion', description: 'Narration, audiobooks' },
    { voice_id: 'luna', name: 'Luna', description: 'Education, assistant' },
    { voice_id: 'liora', name: 'Liora', description: 'Wellness, assistant' },
    { voice_id: 'lux', name: 'Lux', description: 'Wellness, narration' },
    { voice_id: 'celeste', name: 'Celeste', description: 'Support, assistant' },
    { voice_id: 'aurora', name: 'Aurora', description: 'Support, assistant' },
    { voice_id: 'iris', name: 'Iris', description: 'Sales, support' },
    { voice_id: 'carina', name: 'Carina', description: 'Wellness, support' },
    { voice_id: 'helios', name: 'Helios', description: 'Assistant, wellness' },
    { voice_id: 'helix', name: 'Helix', description: 'Commentary, podcast' },
    { voice_id: 'cosmo', name: 'Cosmo', description: 'Education, podcast' },
    { voice_id: 'kepler', name: 'Kepler', description: 'Advertising, podcast' },
    { voice_id: 'lumen', name: 'Lumen', description: 'Education, advertising' },
    { voice_id: 'atlas', name: 'Atlas', description: 'Sales, assistant' },
    { voice_id: 'castor', name: 'Castor', description: 'Sales, support' },
    { voice_id: 'altair', name: 'Altair', description: 'Advertising, narration' },
    { voice_id: 'perseus', name: 'Perseus', description: 'Advertising, narration' },
    { voice_id: 'zenith', name: 'Zenith', description: 'Sales, advertising' },
    { voice_id: 'ursa', name: 'Ursa', description: 'Assistant, podcast' },
    { voice_id: 'naksh', name: 'Naksh', description: 'Assistant, Indian accent' },
    { voice_id: 'rigel', name: 'Rigel', description: 'Assistant, Australian accent' },
];

/** TTS languages (BCP-47). STT receives the base code (e.g. "pt" for "pt-BR"). */
export const LANGUAGES = [
    ['auto', 'Auto-detect'], ['en', 'English'], ['ar-EG', 'Arabic (Egypt)'], ['ar-SA', 'Arabic (Saudi)'],
    ['ar-AE', 'Arabic (UAE)'], ['bn', 'Bengali'], ['zh', 'Chinese (Simplified)'], ['fr', 'French'],
    ['de', 'German'], ['hi', 'Hindi'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'],
    ['ko', 'Korean'], ['pt-BR', 'Portuguese (Brazil)'], ['pt-PT', 'Portuguese (Portugal)'], ['ru', 'Russian'],
    ['es-MX', 'Spanish (Mexico)'], ['es-ES', 'Spanish (Spain)'], ['tr', 'Turkish'], ['vi', 'Vietnamese'],
];

/** Spoken by ElevenLabs and HeyGen voices but not by Grok's, which read them with auto-detect. */
export const MORE_LANGUAGES = [
    ['ml', 'Malayalam'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['mr', 'Marathi'],
    ['gu', 'Gujarati'], ['pa', 'Punjabi'], ['ur', 'Urdu'],
];

/** Languages Grok STT can be told to expect. Anything else is left to its auto-detect. */
export const STT_LANGUAGES = new Set(['ar', 'bg', 'bs', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fil', 'fr',
    'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'mk', 'ms', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv', 'th', 'tr',
    'uk', 'ur', 'vi', 'yue', 'zh']);
