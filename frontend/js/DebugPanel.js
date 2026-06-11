/**
 * DebugPanel.js - Debug inspector panel for the right pane.
 *
 * Shows three collapsible sections when a debug session is active:
 * - Variables: locals/globals tree with lazy expansion
 * - Call Stack: navigable stack frames (cells and files)
 * - Breakpoints: list of all active breakpoints
 *
 * Communicates with the debugger via DebugClient (DAP protocol).
 */

import { toggleBreakpoint } from './BreakpointGutter.js';

export class DebugPanel {
    constructor() {
        this._debugClient = null;
        this._cells = null;
        this._currentFrameId = null;
        this._varCache = new Map();  // variablesReference -> variables[]
        this._disabledBps = new Set();  // "cellIndex:line" keys for disabled breakpoints
        this._el = document.createElement('div');
        this._el.className = 'debug-panel';
        this._onNavigate = null;  // callback(projectId, filePath, line) for cross-file nav
        this._buildUI();
    }

    get element() { return this._el; }

    /** Set callback for navigating to a file/line: fn(sourcePath, line) */
    set onNavigate(fn) { this._onNavigate = fn; }

    /** Attach to an active debug session. */
    attach(debugClient, cells) {
        this._debugClient = debugClient;
        this._cells = cells;
        this._varCache.clear();
        this._renderBreakpoints();
        this._showPlaceholder('Waiting for breakpoint...');
    }

    /** Detach from the debug session. */
    detach() {
        this._debugClient = null;
        this._currentFrameId = null;
        this._varCache.clear();
        this._showPlaceholder('Set breakpoints and start a debug session');
        this._stackBody.innerHTML = '<div class="debug-placeholder">No active debug session</div>';
        // Keep breakpoints visible - don't clear _cells or _bpBody
        if (this._cells) this._renderBreakpoints();
    }

    /** Called when execution stops at a breakpoint/step. */
    async onStopped(threadId, stackFrames) {
        this._varCache.clear();
        this._renderCallStack(stackFrames);

        if (stackFrames.length > 0) {
            await this._selectFrame(stackFrames[0]);
        }
    }

    /** Called when execution continues. */
    onContinued() {
        this._varCache.clear();
        this._varsBody.innerHTML = '<div class="debug-placeholder">Running...</div>';
    }

    // --- UI Construction ---

    _buildUI() {
        // Variables section
        this._varsSection = this._createSection('Variables', true);
        this._varsBody = this._varsSection.querySelector('.debug-section-body');

        // Call Stack section
        this._stackSection = this._createSection('Call Stack', true);
        this._stackBody = this._stackSection.querySelector('.debug-section-body');

        // Breakpoints section
        this._bpSection = this._createSection('Breakpoints', true);
        this._bpBody = this._bpSection.querySelector('.debug-section-body');

        this._el.appendChild(this._varsSection);
        this._el.appendChild(this._stackSection);
        this._el.appendChild(this._bpSection);

        this._showPlaceholder('Set breakpoints and start a debug session');
        this._stackBody.innerHTML = '<div class="debug-placeholder">No active debug session</div>';
        this._bpBody.innerHTML = '<div class="debug-placeholder">No breakpoints set</div>';
    }

    _createSection(title, expanded = true) {
        const section = document.createElement('div');
        section.className = 'debug-section';

        const header = document.createElement('div');
        header.className = 'debug-section-header';
        header.innerHTML = `<span class="debug-section-arrow">${expanded ? '\u25BC' : '\u25B6'}</span>${title}`;
        section.appendChild(header);

        const body = document.createElement('div');
        body.className = 'debug-section-body';
        if (!expanded) body.style.display = 'none';
        section.appendChild(body);

        header.addEventListener('click', () => {
            const visible = body.style.display !== 'none';
            body.style.display = visible ? 'none' : '';
            header.querySelector('.debug-section-arrow').textContent = visible ? '\u25B6' : '\u25BC';
        });

        return section;
    }

    _showPlaceholder(text) {
        this._varsBody.innerHTML = `<div class="debug-placeholder">${text}</div>`;
    }

    // --- Variables ---

    async _selectFrame(frame) {
        this._currentFrameId = frame.id;

        // Highlight active frame in call stack
        for (const row of this._stackBody.querySelectorAll('.debug-frame')) {
            row.classList.toggle('active', row.dataset.frameId === String(frame.id));
        }

        if (!this._debugClient) return;

        this._varsBody.innerHTML = '<div class="debug-placeholder">Loading...</div>';

        try {
            const scopesResult = await this._debugClient.scopes(frame.id);
            const scopes = scopesResult.scopes || [];
            this._varsBody.innerHTML = '';

            for (const scope of scopes) {
                // Skip globals by default (too many entries)
                if (scope.name === 'Globals' || scope.name === 'global') continue;

                const scopeEl = document.createElement('div');
                scopeEl.className = 'debug-scope';

                const scopeHeader = document.createElement('div');
                scopeHeader.className = 'debug-scope-header';
                scopeHeader.textContent = scope.name;
                scopeEl.appendChild(scopeHeader);

                const varsContainer = document.createElement('div');
                scopeEl.appendChild(varsContainer);

                try {
                    const varsResult = await this._debugClient.variables(scope.variablesReference);
                    const vars = varsResult.variables || [];
                    this._varCache.set(scope.variablesReference, vars);
                    this._renderVariableList(vars, varsContainer, 0);
                } catch (e) {
                    varsContainer.innerHTML = `<div class="debug-placeholder">Error: ${e.message}</div>`;
                }

                this._varsBody.appendChild(scopeEl);
            }

            if (this._varsBody.children.length === 0) {
                this._showPlaceholder('No local variables');
            }
        } catch (e) {
            this._varsBody.innerHTML = `<div class="debug-placeholder">Error: ${e.message}</div>`;
        }
    }

    _renderVariableList(variables, container, depth) {
        for (const v of variables) {
            // Skip private/dunder variables at top level
            if (depth === 0 && v.name.startsWith('__') && v.name.endsWith('__')) continue;
            // Skip special IPython variables
            if (depth === 0 && (v.name.startsWith('_i') || v.name === '_' || v.name === '_oh')) continue;

            const row = document.createElement('div');
            row.className = 'debug-var-row';
            row.style.paddingLeft = `${8 + depth * 16}px`;

            const expandable = v.variablesReference > 0;

            if (expandable) {
                const arrow = document.createElement('span');
                arrow.className = 'debug-var-arrow';
                arrow.textContent = '\u25B6';
                row.appendChild(arrow);
            } else {
                const spacer = document.createElement('span');
                spacer.className = 'debug-var-arrow-spacer';
                row.appendChild(spacer);
            }

            const nameEl = document.createElement('span');
            nameEl.className = 'debug-var-name';
            nameEl.textContent = v.name;
            row.appendChild(nameEl);

            const sep = document.createElement('span');
            sep.className = 'debug-var-sep';
            sep.textContent = ' = ';
            row.appendChild(sep);

            const valueEl = document.createElement('span');
            valueEl.className = 'debug-var-value';
            const displayValue = v.value.length > 80 ? v.value.substring(0, 80) + '...' : v.value;
            valueEl.textContent = displayValue;
            valueEl.title = v.value;
            row.appendChild(valueEl);

            if (v.type) {
                const typeEl = document.createElement('span');
                typeEl.className = 'debug-var-type';
                typeEl.textContent = v.type;
                row.appendChild(typeEl);
            }

            container.appendChild(row);

            // Lazy expansion for compound types
            if (expandable) {
                let expanded = false;
                const childContainer = document.createElement('div');
                childContainer.style.display = 'none';
                container.appendChild(childContainer);

                row.style.cursor = 'pointer';
                row.addEventListener('click', async () => {
                    if (expanded) {
                        expanded = false;
                        childContainer.style.display = 'none';
                        row.querySelector('.debug-var-arrow').textContent = '\u25B6';
                        return;
                    }

                    expanded = true;
                    row.querySelector('.debug-var-arrow').textContent = '\u25BC';
                    childContainer.style.display = '';

                    // Check cache first
                    if (this._varCache.has(v.variablesReference)) {
                        childContainer.innerHTML = '';
                        this._renderVariableList(
                            this._varCache.get(v.variablesReference),
                            childContainer, depth + 1
                        );
                        return;
                    }

                    childContainer.innerHTML = '<div class="debug-placeholder" style="padding-left:24px">Loading...</div>';

                    try {
                        const result = await this._debugClient.variables(v.variablesReference);
                        const children = result.variables || [];
                        this._varCache.set(v.variablesReference, children);
                        childContainer.innerHTML = '';
                        this._renderVariableList(children, childContainer, depth + 1);
                    } catch (e) {
                        childContainer.innerHTML = `<div class="debug-placeholder">Error: ${e.message}</div>`;
                    }
                });
            }
        }
    }

    // --- Call Stack ---

    _renderCallStack(frames) {
        this._stackBody.innerHTML = '';

        for (const frame of frames) {
            const row = document.createElement('div');
            row.className = 'debug-frame';
            row.dataset.frameId = String(frame.id);

            const nameEl = document.createElement('span');
            nameEl.className = 'debug-frame-name';
            nameEl.textContent = frame.name || '<anonymous>';
            row.appendChild(nameEl);

            const locEl = document.createElement('span');
            locEl.className = 'debug-frame-location';
            const sourceName = frame.source?.name || frame.source?.path?.split('/').pop() || '?';
            locEl.textContent = `${sourceName}:${frame.line}`;
            row.appendChild(locEl);

            row.addEventListener('click', () => {
                this._selectFrame(frame);

                // Navigate to source
                if (this._onNavigate && frame.source?.path) {
                    this._onNavigate(frame.source.path, frame.line);
                }
            });

            this._stackBody.appendChild(row);
        }

        if (frames.length === 0) {
            this._stackBody.innerHTML = '<div class="debug-placeholder">No frames</div>';
        }
    }

    // --- Breakpoints ---

    _renderBreakpoints() {
        this._bpBody.innerHTML = '';
        if (!this._cells) return;

        let count = 0;
        for (let i = 0; i < this._cells.length; i++) {
            const cell = this._cells[i];
            if (cell.cellType !== 'code') continue;
            const activeBps = cell.getBreakpoints();
            const view = cell._editorView;
            // Merge active breakpoints with disabled ones for this cell
            const disabledLines = [];
            for (const key of this._disabledBps) {
                if (key.startsWith(`${i}:`)) {
                    disabledLines.push(parseInt(key.split(':')[1]));
                }
            }
            const allLines = [...new Set([...activeBps, ...disabledLines])].sort((a, b) => a - b);
            for (const line of allLines) {
                count++;
                const row = document.createElement('div');
                row.className = 'debug-bp-row';

                const bpKey = `${i}:${line}`;
                const isDisabled = !activeBps.includes(line);

                // Enable/disable checkbox
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !isDisabled;
                cb.className = 'debug-bp-checkbox';
                cb.title = 'Enable/disable breakpoint';
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        this._disabledBps.delete(bpKey);
                        // Re-add the breakpoint in the gutter
                        if (view) toggleBreakpoint(view, line);
                    } else {
                        this._disabledBps.add(bpKey);
                        // Remove the breakpoint from the gutter
                        if (view) toggleBreakpoint(view, line);
                    }
                    const dot = row.querySelector('.debug-bp-dot');
                    if (dot) dot.classList.toggle('disabled', !cb.checked);
                    row.classList.toggle('disabled', !cb.checked);
                });
                row.appendChild(cb);

                const dot = document.createElement('span');
                dot.className = 'debug-bp-dot';
                if (isDisabled) dot.classList.add('disabled');
                row.appendChild(dot);
                if (isDisabled) row.classList.add('disabled');

                const label = document.createElement('span');
                label.className = 'debug-bp-label';
                const source = cell._bpLabel || `Cell ${i + 1}`;
                label.textContent = `${source}, Line ${line}`;
                row.appendChild(label);

                // Navigate on label click
                label.style.cursor = 'pointer';
                label.addEventListener('click', () => {
                    cell.setDebugCurrentLine(line);
                    cell.element.scrollIntoView({ block: 'center' });
                });

                // Delete button
                const delBtn = document.createElement('span');
                delBtn.className = 'debug-bp-delete';
                delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#202020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" fill="#f4a0a0"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
                delBtn.title = 'Remove breakpoint';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._disabledBps.delete(bpKey);
                    // Remove from gutter if still enabled
                    if (!isDisabled && view) toggleBreakpoint(view, line);
                    requestAnimationFrame(() => this._renderBreakpoints());
                });
                row.appendChild(delBtn);

                this._bpBody.appendChild(row);
            }
        }

        if (count === 0) {
            this._bpBody.innerHTML = '<div class="debug-placeholder">No breakpoints set</div>';
        }
    }

    /** Refresh breakpoints list (called when breakpoints change). */
    refreshBreakpoints(cells) {
        if (cells) this._cells = cells;
        if (this._cells) this._renderBreakpoints();
    }
}
