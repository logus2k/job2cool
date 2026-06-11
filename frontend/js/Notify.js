/**
 * Notify - thin singleton wrapper around Notyf with notification history.
 * Usage:
 *   import { notify } from './Notify.js';
 *   notify.success('Saved');
 *   notify.error('Something went wrong');
 *   notify.history // => [{type, message, time}, ...]
 */

let instance = null;
const MAX_HISTORY = 10;
const _history = [];
const _listeners = [];

function get() {
    if (!instance) {
        instance = new Notyf({
            duration: 2500,
            ripple: false,
            dismissible: true,
            position: { x: 'right', y: 'bottom' },
            types: [
                { type: 'success', background: '#3a9a5c' },
                { type: 'error', background: '#c0392b' },
                { type: 'info', background: '#4a6eef' },
                { type: 'warning', background: '#c89520' },
            ],
        });
    }
    return instance;
}

function _record(type, msg) {
    _history.unshift({ type, message: msg, time: new Date() });
    if (_history.length > MAX_HISTORY) _history.length = MAX_HISTORY;
    for (const fn of _listeners) fn();
}

function _injectCopyButton(msg) {
    requestAnimationFrame(() => {
        const toasts = document.querySelectorAll('.notyf__toast');
        const toast = toasts[toasts.length - 1];
        if (!toast || toast.querySelector('.notyf-copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'notyf-copy-btn';
        btn.innerHTML = '<i class="fa-regular fa-copy"></i>';
        btn.title = 'Copy to clipboard';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(msg);
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        });
        toast.appendChild(btn);
    });
}

export const notify = {
    success(msg) { _record('success', msg); get().success(msg); _injectCopyButton(msg); },
    error(msg)   { _record('error', msg); get().error(msg); _injectCopyButton(msg); },
    info(msg)    { _record('info', msg); get().open({ type: 'info', message: msg }); _injectCopyButton(msg); },
    warning(msg) { _record('warning', msg); get().open({ type: 'warning', message: msg }); _injectCopyButton(msg); },
    open(opts)   { _record(opts.type || 'info', opts.message || ''); get().open(opts); _injectCopyButton(opts.message || ''); },
    dismissAll() { get().dismissAll(); },
    get history() { return _history; },
    onChange(fn) { _listeners.push(fn); },
    offChange(fn) { const i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); },
};
