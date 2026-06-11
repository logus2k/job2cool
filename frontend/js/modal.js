/**
 * Modal utilities using jsPanel.modal extension.
 * Drop-in async replacement for native confirm/alert dialogs.
 */

/**
 * Remove any leftover modal backdrops from the DOM.
 * jsPanel sometimes fails to clean these up, leaving the
 * screen unclickable after the modal panel is closed.
 */
function _cleanupBackdrops() {
    document.querySelectorAll('.jsPanel-modal-backdrop').forEach(el => el.remove());
}

export function modalConfirm(message, { title = 'Confirm', confirmText = 'OK', cancelText = 'Cancel' } = {}) {
    return new Promise((resolve) => {
        let resolved = false;
        jsPanel.modal.create({
            headerTitle: title,
            contentSize: { width: 360, height: 'auto' },
            content: `<div style="padding:20px 24px;font-size:13px;color:var(--text-primary,#ccc);line-height:1.5">${message}</div>`,
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => { _cleanupBackdrops(); if (!resolved) resolve(false); return true; }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-cancel">${cancelText}</button>
                    <button class="modal-btn modal-confirm">${confirmText}</button>
                </div>`,
            callback: (panel) => {
                panel.footer.querySelector('.modal-cancel').addEventListener('click', () => {
                    panel.close();
                });
                panel.footer.querySelector('.modal-confirm').addEventListener('click', () => {
                    resolved = true;
                    resolve(true);
                    panel.close();
                });
            }
        });
    });
}

export function modalAlert(message, { title = 'Info', buttonText = 'OK' } = {}) {
    return new Promise((resolve) => {
        jsPanel.modal.create({
            headerTitle: title,
            contentSize: { width: 360, height: 'auto' },
            content: `<div style="padding:20px 24px;font-size:13px;color:var(--text-primary,#ccc);line-height:1.5">${message}</div>`,
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => { _cleanupBackdrops(); resolve(); return true; }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-confirm">${buttonText}</button>
                </div>`,
            callback: (panel) => {
                panel.footer.querySelector('.modal-confirm').addEventListener('click', () => {
                    panel.close();
                });
            }
        });
    });
}

export function modalPrompt(label, { title = 'Input', defaultValue = '', placeholder = '', password = false } = {}) {
    return new Promise((resolve) => {
        let resolved = false;
        jsPanel.modal.create({
            headerTitle: title,
            contentSize: { width: 360, height: 'auto' },
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => { _cleanupBackdrops(); if (!resolved) resolve(null); return true; }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-cancel">Cancel</button>
                    <button class="modal-btn modal-confirm">OK</button>
                </div>`,
            callback: (panel) => {
                const wrap = document.createElement('div');
                wrap.style.cssText = 'padding:16px 20px';

                const lbl = document.createElement('label');
                lbl.style.cssText = 'display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:6px';
                lbl.textContent = label;

                const input = document.createElement('input');
                input.type = password ? 'password' : 'text';
                input.value = defaultValue;
                input.placeholder = placeholder;
                input.style.cssText = 'width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border-color,#444);border-radius:4px;background:var(--bg-secondary,#2a2a2a);color:var(--text-primary,#ccc);outline:none;box-sizing:border-box';

                wrap.append(lbl, input);
                panel.content.innerHTML = '';
                panel.content.appendChild(wrap);

                const submit = () => {
                    const val = input.value.trim();
                    if (val) { resolved = true; resolve(val); panel.close(); }
                };

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') panel.close();
                });

                panel.footer.querySelector('.modal-cancel').addEventListener('click', () => panel.close());
                panel.footer.querySelector('.modal-confirm').addEventListener('click', submit);

                setTimeout(() => { input.focus(); input.select(); }, 50);
            }
        });
    });
}

/**
 * Multi-field form modal. Returns an object with field values, or null if cancelled.
 * @param {Array<{key:string, label:string, type?:string, placeholder?:string, defaultValue?:string, required?:boolean}>} fields
 * @param {object} opts
 * @param {string} [opts.title='Input']
 * @param {string} [opts.confirmText='OK']
 * @param {number} [opts.width=400]
 * @returns {Promise<object|null>}
 */
export function modalForm(fields, { title = 'Input', confirmText = 'OK', width = 400 } = {}) {
    return new Promise((resolve) => {
        let resolved = false;
        jsPanel.modal.create({
            headerTitle: title,
            contentSize: { width, height: 'auto' },
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => { _cleanupBackdrops(); if (!resolved) resolve(null); return true; }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-cancel">Cancel</button>
                    <button class="modal-btn modal-confirm">${confirmText}</button>
                </div>`,
            callback: (panel) => {
                const wrap = document.createElement('div');
                wrap.style.cssText = 'padding:16px 20px;display:flex;flex-direction:column;gap:12px';

                const inputs = {};
                let firstInput = null;

                for (const f of fields) {
                    const row = document.createElement('div');

                    const lbl = document.createElement('label');
                    lbl.style.cssText = 'display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:4px';
                    lbl.textContent = f.label;
                    row.appendChild(lbl);

                    let input;
                    if (f.type === 'select') {
                        // Dropdown. `f.options` is [{label, value}, ...] (required for select).
                        input = document.createElement('select');
                        input.style.cssText = 'width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border-color,#444);border-radius:4px;background:var(--bg-secondary,#2a2a2a);color:var(--text-primary,#ccc);outline:none;box-sizing:border-box';
                        for (const opt of (f.options || [])) {
                            const o = document.createElement('option');
                            o.value = opt.value;
                            o.textContent = opt.label;
                            if (opt.value === (f.defaultValue || '')) o.selected = true;
                            input.appendChild(o);
                        }
                        // Set value AFTER options are appended (browsers don't
                        // reliably honor `selected` set before append).
                        if (f.defaultValue) input.value = f.defaultValue;
                    } else {
                        input = document.createElement('input');
                        input.type = f.type || 'text';
                        if (f.type !== 'file') input.value = f.defaultValue || '';
                        input.placeholder = f.placeholder || '';
                        if (f.accept) input.accept = f.accept;
                        if (f.type === 'file' && f.multiple) input.multiple = true;
                        input.style.cssText = 'width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border-color,#444);border-radius:4px;background:var(--bg-secondary,#2a2a2a);color:var(--text-primary,#ccc);outline:none;box-sizing:border-box';
                    }
                    row.appendChild(input);

                    inputs[f.key] = input;
                    if (!firstInput) firstInput = input;
                    wrap.appendChild(row);
                }

                panel.content.innerHTML = '';
                panel.content.appendChild(wrap);

                const submit = () => {
                    const result = {};
                    for (const f of fields) {
                        const inp = inputs[f.key];
                        const isFile = (f.type === 'file');
                        let val;
                        if (isFile) {
                            val = f.multiple
                                ? (inp.files ? Array.from(inp.files) : [])
                                : (inp.files?.[0] || null);
                            const empty = f.multiple ? !val.length : !val;
                            if (f.required !== false && empty) {
                                inp.style.borderColor = '#e57373';
                                inp.focus();
                                return;
                            }
                        } else {
                            val = inp.value.trim();
                            if (f.required !== false && !val) {
                                inp.style.borderColor = '#e57373';
                                inp.focus();
                                return;
                            }
                        }
                        result[f.key] = val;
                    }
                    resolved = true;
                    resolve(result);
                    panel.close();
                };

                for (const input of Object.values(inputs)) {
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') submit();
                        if (e.key === 'Escape') panel.close();
                    });
                }

                panel.footer.querySelector('.modal-cancel').addEventListener('click', () => panel.close());
                panel.footer.querySelector('.modal-confirm').addEventListener('click', submit);

                // <select> doesn't have a .select() method - guard so the
                // focus call still runs when the first field is a dropdown.
                setTimeout(() => {
                    if (!firstInput) return;
                    firstInput.focus();
                    if (typeof firstInput.select === 'function') firstInput.select();
                }, 50);
            }
        });
    });
}

/**
 * @param {string} message
 * @param {object} opts
 * @param {string} [opts.title='Error']
 * @param {Array<{label:string, icon?:string, onClick:function}>} [opts.actions] - Extra buttons before Close
 */
export function modalError(message, { title = 'Error', actions = [] } = {}) {
    return new Promise((resolve) => {
        jsPanel.modal.create({
            headerTitle: `<i class="fa-solid fa-circle-exclamation" style="color:#e57373;margin-right:6px"></i>${title}`,
            contentSize: { width: 460, height: 'auto' },
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => { _cleanupBackdrops(); resolve(); return true; }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-cancel modal-copy-btn"><i class="fa-regular fa-copy" style="margin-right:4px"></i>Copy</button>
                    <span class="modal-actions-slot"></span>
                    <button class="modal-btn modal-confirm">Close</button>
                </div>`,
            callback: (panel) => {
                const pre = document.createElement('pre');
                pre.style.cssText = 'padding:16px 20px;font-size:12px;font-family:var(--font-mono,monospace);color:var(--text-primary,#ccc);line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;margin:0;user-select:text;cursor:text';
                pre.textContent = message;
                panel.content.innerHTML = '';
                panel.content.appendChild(pre);

                panel.footer.querySelector('.modal-copy-btn').addEventListener('click', () => {
                    navigator.clipboard.writeText(message).then(() => {
                        const btn = panel.footer.querySelector('.modal-copy-btn');
                        btn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:4px"></i>Copied';
                        setTimeout(() => { btn.innerHTML = '<i class="fa-regular fa-copy" style="margin-right:4px"></i>Copy'; }, 2000);
                    });
                });
                panel.footer.querySelector('.modal-confirm').addEventListener('click', () => {
                    panel.close();
                });

                // Render optional action buttons
                const slot = panel.footer.querySelector('.modal-actions-slot');
                for (const action of actions) {
                    const btn = document.createElement('button');
                    btn.className = 'modal-btn modal-cancel';
                    const iconHtml = action.icon ? `<i class="${action.icon}" style="margin-right:4px"></i>` : '';
                    btn.innerHTML = `${iconHtml}${action.label}`;
                    btn.addEventListener('click', () => {
                        panel.close();
                        if (action.onClick) action.onClick();
                    });
                    slot.appendChild(btn);
                }
            }
        });
    });
}

/**
 * Modal dropdown select dialog.
 * @param {string} label
 * @param {Array<{value:string, label:string}>} options
 * @param {object} [opts]
 * @returns {Promise<string|null>} selected value or null if cancelled
 */
export function modalSelect(label, options, { title = 'Select', confirmText = 'OK', cancelText = 'Cancel' } = {}) {
    return new Promise((resolve) => {
        let resolved = false;
        jsPanel.modal.create({
            headerTitle: title,
            contentSize: { width: 420, height: 'auto' },
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => { _cleanupBackdrops(); if (!resolved) resolve(null); return true; }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-cancel">${cancelText}</button>
                    <button class="modal-btn modal-confirm">${confirmText}</button>
                </div>`,
            callback: (panel) => {
                const wrap = document.createElement('div');
                wrap.style.cssText = 'padding:16px 20px';

                const lbl = document.createElement('div');
                lbl.style.cssText = 'font-size:13px;margin-bottom:10px;color:var(--text-primary,#333)';
                lbl.textContent = label;
                wrap.appendChild(lbl);

                const select = document.createElement('select');
                select.style.cssText = 'width:100%;padding:6px 8px;padding-right:25px;font-size:13px;border:0.5px solid #c8c8c8;border-radius:4px;color:#222;outline:none;cursor:pointer;font-family:var(--font-sans)';
                for (const opt of options) {
                    const o = document.createElement('option');
                    o.value = opt.value;
                    o.textContent = opt.label;
                    select.appendChild(o);
                }
                wrap.appendChild(select);
                panel.content.innerHTML = '';
                panel.content.appendChild(wrap);

                panel.footer.querySelector('.modal-cancel').addEventListener('click', () => panel.close());
                panel.footer.querySelector('.modal-confirm').addEventListener('click', () => {
                    resolved = true;
                    const val = select.value;
                    panel.close();
                    resolve(val);
                });

                select.focus();
            }
        });
    });
}


/**
 * Voice Settings modal — chat TTS controls. Returns
 *   { language, gender, voice, speed }   on Save
 *   null                                 on Cancel / close
 *
 * `language === 'auto'` means: keep current auto-detect behavior; the
 * gender + voice fields are not used (the TTS layer continues to switch
 * voice based on detected language).
 *
 * @param {object} initial - current settings to pre-populate the form
 * @param {string} initial.language - 'auto' | language code from SUPPORTED_LANGUAGES
 * @param {'f'|'m'} initial.gender
 * @param {string} initial.voice - voice id, e.g. 'af_heart'
 * @param {number} initial.speed
 */
export async function modalVoiceSettings(initial = {}) {
    const {
        SUPPORTED_LANGUAGES,
        filterVoices,
        defaultVoiceForLanguage,
        voiceDisplayName,
        SPEED_MIN, SPEED_MAX, SPEED_STEP, SPEED_DEFAULT,
    } = await import('./voiceData.js');

    return new Promise((resolve) => {
        let resolved = false;
        let curLang = initial.language || 'auto';
        let curGender = initial.gender || 'f';
        let curVoice = initial.voice || 'af_heart';
        let curSpeed = typeof initial.speed === 'number' ? initial.speed : SPEED_DEFAULT;

        // Same equalizer SVG as the chat-panel button, sized to the
        // header text and inheriting the header's text color (no pill
        // background) so the modal reads as the trigger button's home.
        const headerIcon =
            '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" '
            + 'viewBox="0 0 32 32" fill="currentColor" '
            + 'style="vertical-align:-2px;margin-right:6px">'
            + '<path d="M3 8a1 1 0 0 1 1-1h6.05a3.5 3.5 0 0 1 6.9 0H28a1 1 0 1 1 0 2H16.95a3.5 3.5 0 0 1-6.9 0H4a1 1 0 0 1-1-1m10.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M3 16a1 1 0 0 1 1-1h14.05a3.5 3.5 0 0 1 6.9 0H28a1 1 0 1 1 0 2h-3.05a3.5 3.5 0 0 1-6.9 0H4a1 1 0 0 1-1-1m18.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M3 24a1 1 0 0 1 1-1h2.05a3.5 3.5 0 0 1 6.9 0H28a1 1 0 1 1 0 2H12.95a3.5 3.5 0 0 1-6.9 0H4a1 1 0 0 1-1-1m6.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3"/>'
            + '</svg>';

        jsPanel.modal.create({
            headerTitle: headerIcon + 'Voice Settings',
            contentSize: { width: 360, height: 'auto' },
            position: 'center',
            dragit: false,
            resizeit: false,
            headerControls: 'closeonly',
            border: '1px solid var(--border-color, #444)',
            borderRadius: '6px',
            theme: 'none',
            boxShadow: 4,
            onclosed: [() => { _cleanupBackdrops(); if (!resolved) resolve(null); return true; }],
            footerToolbar: `
                <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;width:100%">
                    <button class="modal-btn modal-cancel">Cancel</button>
                    <button class="modal-btn modal-confirm">Save</button>
                </div>`,
            callback: (panel) => {
                const root = document.createElement('div');
                root.style.cssText = 'padding:16px 20px;display:flex;flex-direction:column;gap:14px';

                const labelStyle = 'display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:6px';
                const inputStyle = 'width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border-color,#444);border-radius:4px;background:var(--bg-secondary,#2a2a2a);color:var(--text-primary,#ccc);outline:none;box-sizing:border-box';

                // ── Language ───────────────────────────────────────────
                const langRow = document.createElement('div');
                const langLbl = document.createElement('label');
                langLbl.style.cssText = labelStyle;
                langLbl.textContent = 'Language';
                const langSelect = document.createElement('select');
                langSelect.style.cssText = inputStyle;
                const autoOpt = document.createElement('option');
                autoOpt.value = 'auto';
                autoOpt.textContent = 'Auto (English as default)';
                langSelect.appendChild(autoOpt);
                for (const lang of SUPPORTED_LANGUAGES) {
                    const o = document.createElement('option');
                    o.value = lang.code;
                    o.textContent = lang.label;
                    langSelect.appendChild(o);
                }
                langSelect.value = curLang;
                langRow.append(langLbl, langSelect);

                // ── Gender (radio) ─────────────────────────────────────
                const genderRow = document.createElement('div');
                const genderLbl = document.createElement('label');
                genderLbl.style.cssText = labelStyle;
                genderLbl.textContent = 'Gender';
                const genderWrap = document.createElement('div');
                genderWrap.style.cssText = 'display:flex;gap:16px;align-items:center;font-size:13px;color:var(--text-primary,#ccc)';
                genderWrap.innerHTML = `
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input type="radio" name="vs-gender" value="f"> Female
                    </label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input type="radio" name="vs-gender" value="m"> Male
                    </label>`;
                const genderRadios = genderWrap.querySelectorAll('input[name="vs-gender"]');
                genderRadios.forEach(r => { r.checked = (r.value === curGender); });
                genderRow.append(genderLbl, genderWrap);

                // ── Voice ──────────────────────────────────────────────
                const voiceRow = document.createElement('div');
                const voiceLbl = document.createElement('label');
                voiceLbl.style.cssText = labelStyle;
                voiceLbl.textContent = 'Voice';
                const voiceSelect = document.createElement('select');
                voiceSelect.style.cssText = inputStyle;
                voiceRow.append(voiceLbl, voiceSelect);

                const refreshVoices = () => {
                    voiceSelect.innerHTML = '';
                    if (curLang === 'auto') {
                        const o = document.createElement('option');
                        o.value = '';
                        o.textContent = '— auto-selected per language —';
                        voiceSelect.appendChild(o);
                        return;
                    }
                    const voices = filterVoices(curLang, curGender);
                    if (voices.length === 0) {
                        // e.g. French + Male — fall back to whatever's available for this language.
                        const fallbackId = defaultVoiceForLanguage(curLang);
                        const o = document.createElement('option');
                        o.value = fallbackId;
                        o.textContent = `${voiceDisplayName(fallbackId)} (no ${curGender === 'f' ? 'female' : 'male'} voices for this language)`;
                        voiceSelect.appendChild(o);
                        curVoice = fallbackId;
                        return;
                    }
                    for (const v of voices) {
                        const o = document.createElement('option');
                        o.value = v.id;
                        o.textContent = voiceDisplayName(v.id);
                        voiceSelect.appendChild(o);
                    }
                    // Try to keep current selection if it still fits; else first.
                    if (voices.some(v => v.id === curVoice)) {
                        voiceSelect.value = curVoice;
                    } else {
                        voiceSelect.value = voices[0].id;
                        curVoice = voices[0].id;
                    }
                };

                const updateLangControlsState = () => {
                    const isAuto = (curLang === 'auto');
                    genderRadios.forEach(r => { r.disabled = isAuto; });
                    voiceSelect.disabled = isAuto;
                    genderWrap.style.opacity = isAuto ? '0.5' : '1';
                };

                // ── Speed (slider + value) ─────────────────────────────
                const speedRow = document.createElement('div');
                const speedHeader = document.createElement('div');
                speedHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px';
                const speedLbl = document.createElement('label');
                speedLbl.style.cssText = 'font-size:12px;color:var(--text-secondary,#aaa)';
                speedLbl.textContent = 'Speed';
                const speedVal = document.createElement('span');
                speedVal.style.cssText = 'font-size:12px;color:var(--text-primary,#ccc);font-variant-numeric:tabular-nums';
                speedVal.textContent = `${curSpeed.toFixed(2)}×`;
                speedHeader.append(speedLbl, speedVal);
                const speedInput = document.createElement('input');
                speedInput.type = 'range';
                speedInput.min = String(SPEED_MIN);
                speedInput.max = String(SPEED_MAX);
                speedInput.step = String(SPEED_STEP);
                speedInput.value = String(curSpeed);
                speedInput.style.cssText = 'width:100%';
                speedRow.append(speedHeader, speedInput);

                // ── Wire up live changes ───────────────────────────────
                langSelect.addEventListener('change', () => {
                    curLang = langSelect.value;
                    updateLangControlsState();
                    refreshVoices();
                });
                genderRadios.forEach(r => r.addEventListener('change', () => {
                    if (r.checked) { curGender = r.value; refreshVoices(); }
                }));
                voiceSelect.addEventListener('change', () => { curVoice = voiceSelect.value; });
                speedInput.addEventListener('input', () => {
                    curSpeed = parseFloat(speedInput.value);
                    speedVal.textContent = `${curSpeed.toFixed(2)}×`;
                });

                // Initial paint
                root.append(langRow, genderRow, voiceRow, speedRow);
                panel.content.innerHTML = '';
                panel.content.appendChild(root);
                refreshVoices();
                updateLangControlsState();

                panel.footer.querySelector('.modal-cancel').addEventListener('click', () => panel.close());
                panel.footer.querySelector('.modal-confirm').addEventListener('click', () => {
                    resolved = true;
                    panel.close();
                    resolve({
                        language: curLang,
                        gender: curGender,
                        voice: curVoice,
                        speed: curSpeed,
                    });
                });
            }
        });
    });
}
