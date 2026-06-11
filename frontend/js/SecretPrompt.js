/**
 * Shared access-key prompt + sessionStorage cache.
 * Used by ProjectTerminal (Socket.io auth handshake) and by HTTP-side
 * write/delete endpoints that gate on NOTED_TERMINAL_SECRET.
 *
 * The cache key is shared with ProjectTerminal so a user who unlocks
 * one surface in a session is also unlocked for the other.
 */

const SESSION_KEY = 'noted_terminal_secret';

export function getCachedSecret() {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}

export function setCachedSecret(secret) {
    try { sessionStorage.setItem(SESSION_KEY, secret || ''); } catch { /* ignore */ }
}

export function clearCachedSecret() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/**
 * Modal overlay asking for the access key. Returns the entered string,
 * or null on cancel / Esc / backdrop-click.
 *
 * @param {object} [opts]
 * @param {string} [opts.title='Access Key Required']
 * @param {string} [opts.body='Enter the noted access key to proceed.']
 * @param {string} [opts.confirmLabel='Continue']
 * @param {string} [opts.errorMessage] - shown above the input on retry
 */
export function promptForSecret({
    title = 'Access Key Required',
    body = 'Enter the noted access key to proceed.',
    confirmLabel = 'Continue',
    errorMessage = '',
} = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff;border-radius:6px;padding:24px;min-width:340px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:var(--font-family,system-ui)';

        const errBlock = errorMessage
            ? `<div style="color:#d32f2f;font-size:12px;margin-bottom:8px"><i class="fa-solid fa-triangle-exclamation" style="margin-right:4px"></i>${errorMessage}</div>`
            : '';

        dialog.innerHTML = `
            <div style="font-size:14px;font-weight:600;color:#333;margin-bottom:12px">
                <i class="fa-solid fa-lock" style="margin-right:6px;color:#1a73e8"></i>${title}
            </div>
            <div style="font-size:12px;color:#666;margin-bottom:14px">${body}</div>
            ${errBlock}
            <input type="password" id="noted-secret-input"
                   placeholder="Access key"
                   style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;outline:none" />
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button id="noted-secret-cancel"
                        style="padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#333;cursor:pointer;font-size:12px">Cancel</button>
                <button id="noted-secret-ok"
                        style="padding:6px 16px;border:none;border-radius:4px;background:#1a73e8;color:#fff;cursor:pointer;font-size:12px">${confirmLabel}</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const input = dialog.querySelector('#noted-secret-input');
        const okBtn = dialog.querySelector('#noted-secret-ok');
        const cancelBtn = dialog.querySelector('#noted-secret-cancel');

        const cleanup = (val) => { overlay.remove(); resolve(val); };

        okBtn.addEventListener('click', () => cleanup(input.value || null));
        cancelBtn.addEventListener('click', () => cleanup(null));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') cleanup(input.value || null);
            if (e.key === 'Escape') cleanup(null);
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

        requestAnimationFrame(() => input.focus());
    });
}

/**
 * Get a verified-by-HTTP secret. Tries the cache first; on cache miss
 * or 403 from the verifier, prompts and re-tries.
 *
 * @param {function(string): Promise<boolean>} verify - async fn that
 *        returns true if the secret authenticates, false otherwise.
 * @param {object} [opts] - passed through to promptForSecret
 * @returns {Promise<string|null>} verified secret, or null on cancel
 */
export async function getVerifiedSecret(verify, opts = {}) {
    const cached = getCachedSecret();
    if (cached) {
        const ok = await verify(cached);
        if (ok) return cached;
        clearCachedSecret();
    }

    let attempts = 0;
    let lastError = '';
    while (attempts < 3) {
        const entered = await promptForSecret({ ...opts, errorMessage: lastError });
        if (!entered) return null;
        const ok = await verify(entered);
        if (ok) {
            setCachedSecret(entered);
            return entered;
        }
        lastError = 'Invalid access key.';
        attempts += 1;
    }
    return null;
}
