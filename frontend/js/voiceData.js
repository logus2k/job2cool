/**
 * TTS voice catalog. Mirror of tts_server's VOICE_LANGUAGE_MAP +
 * SUPPORTED_LANGUAGES (see ~/env/assets/tts_server/tts_server.py).
 * If the TTS server's voice list changes, update both halves.
 *
 * Voice naming convention:
 *   <language_code><gender_code>_<friendly_name>
 *     language_code: a|b|j|z|e|f|h|i|p
 *     gender_code:   f (female) | m (male)
 *
 * Example: af_heart = American + Female + heart
 */

export const SUPPORTED_LANGUAGES = [
    { code: 'a', label: 'American English' },
    { code: 'b', label: 'British English' },
    { code: 'j', label: 'Japanese' },
    { code: 'z', label: 'Mandarin Chinese' },
    { code: 'e', label: 'Spanish' },
    { code: 'f', label: 'French' },
    { code: 'h', label: 'Hindi' },
    { code: 'i', label: 'Italian' },
    { code: 'p', label: 'Brazilian Portuguese' },
];

// Flat list — easy to filter by language + gender at render time.
export const VOICES = [
    // American English
    { id: 'af_heart',     lang: 'a', gender: 'f' },
    { id: 'af_alloy',     lang: 'a', gender: 'f' },
    { id: 'af_aoede',     lang: 'a', gender: 'f' },
    { id: 'af_bella',     lang: 'a', gender: 'f' },
    { id: 'af_jessica',   lang: 'a', gender: 'f' },
    { id: 'af_kore',      lang: 'a', gender: 'f' },
    { id: 'af_nicole',    lang: 'a', gender: 'f' },
    { id: 'af_nova',      lang: 'a', gender: 'f' },
    { id: 'af_river',     lang: 'a', gender: 'f' },
    { id: 'af_sarah',     lang: 'a', gender: 'f' },
    { id: 'af_sky',       lang: 'a', gender: 'f' },
    { id: 'am_adam',      lang: 'a', gender: 'm' },
    { id: 'am_echo',      lang: 'a', gender: 'm' },
    { id: 'am_eric',      lang: 'a', gender: 'm' },
    { id: 'am_fenrir',    lang: 'a', gender: 'm' },
    { id: 'am_liam',      lang: 'a', gender: 'm' },
    { id: 'am_michael',   lang: 'a', gender: 'm' },
    { id: 'am_onyx',      lang: 'a', gender: 'm' },
    { id: 'am_puck',      lang: 'a', gender: 'm' },
    { id: 'am_santa',     lang: 'a', gender: 'm' },
    // British English
    { id: 'bf_alice',     lang: 'b', gender: 'f' },
    { id: 'bf_emma',      lang: 'b', gender: 'f' },
    { id: 'bf_isabella',  lang: 'b', gender: 'f' },
    { id: 'bf_lily',      lang: 'b', gender: 'f' },
    { id: 'bm_daniel',    lang: 'b', gender: 'm' },
    { id: 'bm_fable',     lang: 'b', gender: 'm' },
    { id: 'bm_george',    lang: 'b', gender: 'm' },
    { id: 'bm_lewis',     lang: 'b', gender: 'm' },
    // Japanese
    { id: 'jf_alpha',     lang: 'j', gender: 'f' },
    { id: 'jf_gongitsune',lang: 'j', gender: 'f' },
    { id: 'jf_nezumi',    lang: 'j', gender: 'f' },
    { id: 'jf_tebukuro',  lang: 'j', gender: 'f' },
    { id: 'jm_kumo',      lang: 'j', gender: 'm' },
    // Mandarin Chinese
    { id: 'zf_xiaobei',   lang: 'z', gender: 'f' },
    { id: 'zf_xiaoni',    lang: 'z', gender: 'f' },
    { id: 'zf_xiaoxiao',  lang: 'z', gender: 'f' },
    { id: 'zf_xiaoyi',    lang: 'z', gender: 'f' },
    { id: 'zm_yunjian',   lang: 'z', gender: 'm' },
    { id: 'zm_yunxi',     lang: 'z', gender: 'm' },
    { id: 'zm_yunxia',    lang: 'z', gender: 'm' },
    { id: 'zm_yunyang',   lang: 'z', gender: 'm' },
    // Spanish
    { id: 'ef_dora',      lang: 'e', gender: 'f' },
    { id: 'em_alex',      lang: 'e', gender: 'm' },
    { id: 'em_santa',     lang: 'e', gender: 'm' },
    // French (female only)
    { id: 'ff_siwis',     lang: 'f', gender: 'f' },
    // Hindi
    { id: 'hf_alpha',     lang: 'h', gender: 'f' },
    { id: 'hf_beta',      lang: 'h', gender: 'f' },
    { id: 'hm_omega',     lang: 'h', gender: 'm' },
    { id: 'hm_psi',       lang: 'h', gender: 'm' },
    // Italian
    { id: 'if_sara',      lang: 'i', gender: 'f' },
    { id: 'im_nicola',    lang: 'i', gender: 'm' },
    // Brazilian Portuguese
    { id: 'pf_dora',      lang: 'p', gender: 'f' },
    { id: 'pm_alex',      lang: 'p', gender: 'm' },
    { id: 'pm_santa',     lang: 'p', gender: 'm' },
];

// Friendly display: strip the lang/gender prefix and capitalize.
//   af_heart  → "Heart"
//   bm_lewis  → "Lewis"
export function voiceDisplayName(voiceId) {
    const idx = voiceId.indexOf('_');
    const tail = idx >= 0 ? voiceId.slice(idx + 1) : voiceId;
    return tail.charAt(0).toUpperCase() + tail.slice(1);
}

// Voices for a given language code + gender ('f' | 'm'), alphabetical by id.
export function filterVoices(langCode, gender) {
    return VOICES
        .filter(v => v.lang === langCode && v.gender === gender)
        .sort((a, b) => a.id.localeCompare(b.id));
}

// Default fallback when the chosen (lang, gender) yields zero voices —
// e.g. user picks French + Male (French has only ff_siwis).
export function defaultVoiceForLanguage(langCode) {
    const v = VOICES.find(v => v.lang === langCode);
    return v ? v.id : 'af_heart';
}

// Speed slider bounds — match tts_server's current config range.
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;
export const SPEED_STEP = 0.05;
export const SPEED_DEFAULT = 1.1;
