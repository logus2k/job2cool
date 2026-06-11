/**
 * TTS Player - standalone text-to-speech client.
 *
 * Connects to the TTS Socket.IO service, sends text, plays audio,
 * and optionally records the output to a downloadable WAV file.
 */

const TTS_URL = 'https://logus2k.com/tts';
const TTS_PATH = '/tts/socket.io';
const SAMPLE_RATE = 48000;

// ---- DOM ----
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const textInput = document.getElementById('textInput');
const btnSpeak = document.getElementById('btnSpeak');
const btnStop = document.getElementById('btnStop');
const chkSave = document.getElementById('chkSave');
const voiceSelect = document.getElementById('voiceSelect');
const speedRange = document.getElementById('speedRange');
const speedLabel = document.getElementById('speedLabel');
const logEl = document.getElementById('log');

// ---- State ----
let socket = null;
let audioCtx = null;
let playQueue = Promise.resolve();
let speaking = false;
let serverDone = false;     // true once tts_response_complete is received
let recordedBuffers = [];
let currentRequestId = 0;
const clientId = crypto.randomUUID();

// ---- Logging ----
function log(msg, cls = '') {
    const div = document.createElement('div');
    div.className = 'entry' + (cls ? ' ' + cls : '');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.prepend(div);
}

// ---- Audio context ----
function ensureAudioCtx() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }
    return audioCtx;
}

function closeAudioCtx() {
    if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
    }
}

// ---- Connect ----
async function connect() {
    if (socket?.connected) return;

    setStatus('connecting');

    const origin = new URL(TTS_URL, window.location.origin).origin;
    socket = io(origin, {
        path: TTS_PATH,
        transports: ['websocket', 'polling'],
        forceNew: true,
        query: { type: 'browser', format: 'binary', main_client_id: clientId },
    });

    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
            socket.once('connect', () => { clearTimeout(timeout); resolve(); });
            socket.once('connect_error', (err) => { clearTimeout(timeout); reject(err); });
        });

        await new Promise((resolve) => {
            socket.emit('register_audio_client', {
                main_client_id: clientId,
                connection_type: 'browser',
                mode: 'tts',
                format: 'binary',
            }, () => resolve());
        });

        setStatus('connected');
        log('Connected', 'success');
        btnSpeak.disabled = false;

        socket.on('tts_audio_chunk', onAudioChunk);
        socket.on('tts_stop_immediate', onStop);
        socket.on('tts_response_complete', onResponseComplete);

        socket.on('disconnect', () => {
            setStatus('disconnected');
            log('Disconnected');
            btnSpeak.disabled = true;
        });

    } catch (err) {
        setStatus('error');
        log('Connection failed: ' + err.message, 'error');
    }
}

// ---- Audio reception ----
let chunksReceived = 0;
const decodedQueue = [];
let playing = false;

function onAudioChunk(evt) {
    const buf = evt?.audio_buffer;
    if (!buf) return;

    const reqId = currentRequestId;
    chunksReceived++;

    const actx = ensureAudioCtx();
    actx.decodeAudioData(buf.slice(0)).then(audioBuf => {
        if (chkSave.checked) {
            recordedBuffers.push(audioBuf);
        }
        if (reqId !== currentRequestId) return;
        decodedQueue.push({ audioBuf });
        startPlayback();
    }).catch(() => {});
}

async function startPlayback() {
    if (playing) return;
    playing = true;

    const actx = ensureAudioCtx();
    if (actx.state === 'suspended') await actx.resume();

    while (decodedQueue.length > 0) {
        const { audioBuf } = decodedQueue.shift();
        try {
            await new Promise((resolve) => {
                const src = actx.createBufferSource();
                src.buffer = audioBuf;
                src.connect(actx.destination);
                src.onended = resolve;
                src.start();
            });
        } catch {
            // AudioContext closed (user clicked stop)
        }
    }
    playing = false;

    // Only finish if the server has sent all chunks AND playback queue is empty
    if (speaking && serverDone && decodedQueue.length === 0) {
        finishSpeaking();
    }
}

function onResponseComplete() {
    serverDone = true;
    // If playback already finished, wrap up now
    if (speaking && !playing && decodedQueue.length === 0) {
        finishSpeaking();
    }
}

function onStop() {
    finishSpeaking();
}

// ---- Speak ----
function speak() {
    const text = textInput.value.trim();
    if (!text || !socket?.connected) return;

    if (speaking) {
        closeAudioCtx();
        playQueue = Promise.resolve();
        playing = false;
        decodedQueue.length = 0;
    }

    currentRequestId++;
    speaking = true;
    serverDone = false;
    chunksReceived = 0;
    recordedBuffers = [];
    playQueue = Promise.resolve();
    setStatus('speaking');
    btnSpeak.disabled = true;
    btnStop.disabled = false;
    log('Speaking...');

    socket.emit('tts_text_chunk', {
        chunk: text,
        target_client_id: clientId,
        final: true,
    });
}

function stopSpeaking() {
    currentRequestId++;
    speaking = false;
    closeAudioCtx();
    playQueue = Promise.resolve();
    playing = false;
    decodedQueue.length = 0;
    setStatus('connected');
    btnSpeak.disabled = false;
    btnStop.disabled = true;

    if (socket?.connected) {
        socket.emit('stop_generation', { client_id: clientId, reason: 'user_stop' });
    }
    log('Stopped');
}

function finishSpeaking() {
    if (!speaking) return;
    speaking = false;

    playQueue.then(() => {
        setStatus('connected');
        btnSpeak.disabled = false;
        btnStop.disabled = true;
        log('Done', 'success');

        if (chkSave.checked && recordedBuffers.length > 0) {
            saveAudio();
        }
    });
}

// ---- Save audio as WAV ----
function saveAudio() {
    if (recordedBuffers.length === 0) return;

    const totalLength = recordedBuffers.reduce((sum, b) => sum + b.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of recordedBuffers) {
        merged.set(buf.getChannelData(0), offset);
        offset += buf.length;
    }

    const wavBlob = encodeWAV(merged, SAMPLE_RATE);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    a.download = `tts_${timestamp}.wav`;
    a.click();
    URL.revokeObjectURL(url);

    const sizeMB = (wavBlob.size / 1024 / 1024).toFixed(1);
    log(`Saved: ${a.download} (${sizeMB} MB)`, 'success');
}

function encodeWAV(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let pos = 44;
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        pos += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}

// ---- Status ----
function setStatus(state) {
    statusDot.className = 'status-dot';
    switch (state) {
        case 'connecting':
            statusText.textContent = 'Connecting...';
            break;
        case 'connected':
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected';
            break;
        case 'speaking':
            statusDot.classList.add('speaking');
            statusText.textContent = 'Speaking...';
            break;
        case 'error':
            statusDot.classList.add('error');
            statusText.textContent = 'Connection error';
            break;
        default:
            statusText.textContent = 'Disconnected';
    }
}

// ---- Voice & Speed ----
const VOICES = {
    'American English': [
        'af_heart', 'af_bella', 'af_nicole', 'af_nova', 'af_sarah', 'af_sky',
        'af_alloy', 'af_aoede', 'af_jessica', 'af_kore', 'af_river',
        'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
        'am_michael', 'am_onyx', 'am_puck',
    ],
    'British English': [
        'bf_emma', 'bf_alice', 'bf_isabella', 'bf_lily',
        'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
    ],
    'French': ['ff_siwis'],
    'Spanish': ['ef_dora', 'em_alex'],
    'Italian': ['if_sara', 'im_nicola'],
    'Portuguese': ['pf_dora', 'pm_alex'],
    'Japanese': ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'],
    'Chinese': ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi'],
    'Hindi': ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'],
};

function populateVoices() {
    for (const [lang, voices] of Object.entries(VOICES)) {
        const group = document.createElement('optgroup');
        group.label = lang;
        for (const v of voices) {
            const opt = document.createElement('option');
            opt.value = v;
            const name = v.split('_').slice(1).join('_');
            const gender = v[1] === 'f' ? 'F' : 'M';
            opt.textContent = `${name} (${gender})`;
            group.appendChild(opt);
        }
        voiceSelect.appendChild(group);
    }
    voiceSelect.value = 'af_heart';
}

function updateSession() {
    if (!socket?.connected) return;
    socket.emit('register_audio_client', {
        main_client_id: clientId,
        connection_type: 'browser',
        mode: 'tts',
        format: 'binary',
        voice: voiceSelect.value,
        speed: parseFloat(speedRange.value),
    });
    log(`Voice: ${voiceSelect.value}, Speed: ${speedRange.value}x`);
}

// ---- Events ----
btnSpeak.addEventListener('click', speak);
btnStop.addEventListener('click', stopSpeaking);
textInput.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (!btnSpeak.disabled) speak();
    }
});
voiceSelect.addEventListener('change', updateSession);
speedRange.addEventListener('input', () => {
    speedLabel.textContent = speedRange.value + 'x';
});
speedRange.addEventListener('change', updateSession);

// Init
populateVoices();
connect();
