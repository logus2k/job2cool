/**
 * ProjectTerminal - Reusable floating terminal for any directory.
 * Opens a jsPanel with an InteractiveTerminal inside, cd'd to the given path.
 * Maintains a registry keyed by cwd so terminals are reused per directory.
 * Requires a terminal access key (NOTED_TERMINAL_SECRET) if configured on the server.
 *
 * Usage:
 *   import { openProjectTerminal } from './ProjectTerminal.js';
 *   openProjectTerminal(socket, '/app/mounts/my-project', 'my-project');
 */

import { InteractiveTerminal } from './InteractiveTerminal.js';
import { getTerminalTheme } from './TerminalThemes.js';

const _registry = new Map(); // cwd -> { panel, terminal }
// Exposed for the R debug flow which needs to write to an existing
// terminal session after R starts (Option A: post-launch injection).
window._projectTerminalRegistry = _registry;
const SESSION_KEY = 'noted_terminal_secret';

/**
 * Prompt the user for the terminal access key.
 * Returns the key string, or null if cancelled.
 */
function _promptSecret() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff;border-radius:6px;padding:24px;min-width:340px;box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:var(--font-family)';

        dialog.innerHTML = `
            <div style="font-size:14px;font-weight:600;color:#333;margin-bottom:12px">
                <i class="fa-solid fa-lock" style="margin-right:6px;color:#1a73e8"></i>Terminal Access Key
            </div>
            <div style="font-size:12px;color:#666;margin-bottom:14px">
                Enter the terminal access key to open a shell session.
            </div>
            <input type="password" id="noted-term-secret-input"
                   placeholder="Access key"
                   style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;outline:none" />
            <div id="noted-term-secret-error" style="color:#d32f2f;font-size:12px;margin-top:6px;display:none"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button id="noted-term-secret-cancel"
                        style="padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#333;cursor:pointer;font-size:12px">Cancel</button>
                <button id="noted-term-secret-ok"
                        style="padding:6px 16px;border:none;border-radius:4px;background:#1a73e8;color:#fefefe;cursor:pointer;font-size:12px">Connect</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const input = dialog.querySelector('#noted-term-secret-input');
        const okBtn = dialog.querySelector('#noted-term-secret-ok');
        const cancelBtn = dialog.querySelector('#noted-term-secret-cancel');

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
 * Verify the secret against the server via terminal:auth handshake.
 * Returns true if auth succeeded, false otherwise.
 */
function _verifySecret(socket, secret) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            socket.off('terminal:auth_ok', onOk);
            socket.off('terminal:auth_failed', onFail);
            resolve(false);
        }, 5000);

        const onOk = () => {
            clearTimeout(timeout);
            socket.off('terminal:auth_ok', onOk);
            socket.off('terminal:auth_failed', onFail);
            resolve(true);
        };
        const onFail = () => {
            clearTimeout(timeout);
            socket.off('terminal:auth_ok', onOk);
            socket.off('terminal:auth_failed', onFail);
            resolve(false);
        };

        socket.on('terminal:auth_ok', onOk);
        socket.on('terminal:auth_failed', onFail);
        socket.emit('terminal:auth', { secret: secret || '' });
    });
}

/**
 * Get a verified terminal secret - from cache or by prompting.
 * Returns the secret string or null if user cancelled or auth failed.
 */
async function _getVerifiedSecret(socket) {
    // Try cached secret first
    const cached = sessionStorage.getItem(SESSION_KEY);
    if (cached) {
        const ok = await _verifySecret(socket, cached);
        if (ok) return cached;
        sessionStorage.removeItem(SESSION_KEY);
    }

    // Prompt user
    const secret = await _promptSecret();
    if (!secret) return null;

    const ok = await _verifySecret(socket, secret);
    if (ok) {
        sessionStorage.setItem(SESSION_KEY, secret);
        return secret;
    }

    // Auth failed - clear and show error
    sessionStorage.removeItem(SESSION_KEY);
    alert('Invalid terminal access key');
    return null;
}

/**
 * Open (or bring to front) a floating terminal at the given directory.
 * @param {object} socket - Raw Socket.IO socket (e.g., kernelClient.socket)
 * @param {string} cwd - Absolute path inside the container
 * @param {string} label - Display name for the panel title
 * @param {object} [opts] - Optional settings
 * @param {string} [opts.initialCommand] - Command to auto-execute after terminal starts
 * @param {string} [opts.panelIcon] - FontAwesome icon class (default: fa-window-maximize)
 * @param {string} [opts.panelIconColor] - Icon color (default: #6fa374)
 */
export async function openProjectTerminal(socket, cwd, label, opts = {}) {
    if (!socket || !cwd) return;

    // Reuse existing terminal for this path
    const existing = _registry.get(cwd);
    if (existing && existing.panel) {
        try {
            existing.panel.front();
            existing.terminal?.focus();
            // Re-run the command in the existing terminal
            if (opts.initialCommand && existing.terminal?.sessionId) {
                socket.emit('terminal:input', {
                    session_id: existing.terminal.sessionId,
                    data: opts.initialCommand + '\n',
                });
            }
            return;
        } catch {
            _registry.delete(cwd);
        }
    }

    // Authenticate before opening the panel
    const secret = await _getVerifiedSecret(socket);
    if (!secret) return;

    // Offset position based on how many terminals are open
    const offset = _registry.size * 25;

    jsPanel.create({
        headerTitle: `<i class="fa-solid ${opts.panelIcon || 'fa-window-maximize'}" style="color:${opts.panelIconColor || '#6fa374'};margin-right:6px"></i>${label || 'Terminal'}`,
        theme: 'none',
        borderRadius: '5px',
        border: '1px solid var(--border-color)',
        panelSize: { width: 680, height: 400 },
        position: { my: 'center', at: 'center', offsetX: offset, offsetY: offset },
        boxShadow: 3,
        headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
        addCloseControl: 1,
        onclosed: () => {
            const entry = _registry.get(cwd);
            if (entry?.terminal) entry.terminal.dispose();
            _registry.delete(cwd);
        },
        callback: async (p) => {
            const content = p.content;
            const themeBg = getTerminalTheme()?.background || '#040404';
            content.style.cssText = `padding:0;overflow:hidden;background:${themeBg};border-radius:0 0 5px 5px`;

            const termContainer = document.createElement('div');
            termContainer.style.cssText = 'width:100%;height:100%';
            content.appendChild(termContainer);

            const terminal = new InteractiveTerminal(termContainer, socket, {
                cwd,
                cmd: ['bash'],
                secret,
            });

            _registry.set(cwd, { panel: p, terminal });

            await terminal.open();
            await terminal.start();
            terminal.focus();

            // Auto-execute initial command if provided
            if (opts.initialCommand) {
                setTimeout(() => {
                    socket.emit('terminal:input', {
                        session_id: terminal.sessionId,
                        data: opts.initialCommand + '\n',
                    });
                }, 500);
            }
        }
    });
}
