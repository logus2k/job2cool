/**
 * BreakpointGutter.js - CodeMirror extension for breakpoint management.
 *
 * Provides:
 * - A gutter column with clickable breakpoint markers (red dots)
 * - Current execution line highlight (gold background + arrow marker)
 * - State management for breakpoints per editor instance
 *
 * Usage in CellEditor:
 *   import { breakpointGutter, toggleBreakpoint, setCurrentLine, getBreakpoints } from './BreakpointGutter.js';
 *   extensions.push(breakpointGutter(onBreakpointChange));
 */

import {
    StateField, StateEffect, RangeSetBuilder,
    EditorView, GutterMarker, gutter, Decoration,
} from '../vendor/codemirror/codemirror.bundle.js';


// --- Effects ---

/** Toggle a breakpoint on a line. */
export const toggleBreakpointEffect = StateEffect.define();

/** Set the current execution line (or clear with null). */
export const setCurrentLineEffect = StateEffect.define();

/** Clear all breakpoints. */
export const clearBreakpointsEffect = StateEffect.define();


// --- Breakpoint Marker ---

class BreakpointMarker extends GutterMarker {
    toDOM() {
        const el = document.createElement('div');
        el.className = 'cm-breakpoint-marker';
        el.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="4.5" fill="#e53935"/></svg>';
        return el;
    }
}

const breakpointMarker = new BreakpointMarker();


// --- Current Line Marker ---

class CurrentLineMarker extends GutterMarker {
    toDOM() {
        const el = document.createElement('div');
        el.className = 'cm-debug-current-marker';
        el.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12"><polygon points="3,1 11,6 3,11" fill="#f9a825"/></svg>';
        return el;
    }
}

// --- Combined Marker (paused at breakpoint) ---
// Red arrow with rounded left edge - combines breakpoint dot + current line arrow

class PausedAtBreakpointMarker extends GutterMarker {
    toDOM() {
        const el = document.createElement('div');
        el.className = 'cm-debug-current-marker';
        el.innerHTML = '<svg viewBox="0 0 16 12" width="16" height="12"><path d="M5,1 L14,6 L5,11 C1,11 1,1 5,1 Z" fill="#e53935"/></svg>';
        return el;
    }
}

const currentLineMarker = new CurrentLineMarker();
const pausedAtBreakpointMarker = new PausedAtBreakpointMarker();


// --- State Fields ---

/** Breakpoint state: set of 1-based line numbers. */
const breakpointState = StateField.define({
    create() { return new Set(); },
    update(value, tr) {
        let changed = false;
        for (const effect of tr.effects) {
            if (effect.is(toggleBreakpointEffect)) {
                const newSet = new Set(value);
                if (newSet.has(effect.value)) {
                    newSet.delete(effect.value);
                } else {
                    newSet.add(effect.value);
                }
                value = newSet;
                changed = true;
            } else if (effect.is(clearBreakpointsEffect)) {
                value = new Set();
                changed = true;
            }
        }
        return value;
    },
});

/** Current execution line (1-based, or 0 for none). */
const currentLineState = StateField.define({
    create() { return 0; },
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setCurrentLineEffect)) {
                return effect.value;
            }
        }
        return value;
    },
});

/** Decoration for the current execution line highlight. */
const currentLineDecoration = Decoration.line({ class: 'cm-debug-current-line' });

const currentLineDecorationField = StateField.define({
    create() { return Decoration.none; },
    update(value, tr) {
        const lineNum = tr.state.field(currentLineState);
        if (lineNum > 0 && lineNum <= tr.state.doc.lines) {
            const line = tr.state.doc.line(lineNum);
            const builder = new RangeSetBuilder();
            builder.add(line.from, line.from, currentLineDecoration);
            return builder.finish();
        }
        return Decoration.none;
    },
    provide: f => EditorView.decorations.from(f),
});


// --- Gutter ---

/**
 * Create the breakpoint gutter extension.
 * @param {function} onBreakpointChange - Called with (lineNumbers: number[]) when breakpoints change
 * @returns {Extension[]} CodeMirror extensions to add to the editor
 */
export function breakpointGutter(onBreakpointChange) {
    const bp_gutter = gutter({
        class: 'cm-breakpoint-gutter',
        markers: (view) => {
            const breakpoints = view.state.field(breakpointState);
            const currentLine = view.state.field(currentLineState);
            const builder = new RangeSetBuilder();

            // Collect marker positions. If breakpoint and current line overlap,
            // show only the current line marker (arrow) to avoid pushing.
            const currentLinePos = (currentLine > 0 && currentLine <= view.state.doc.lines)
                ? view.state.doc.line(currentLine).from : -1;

            const markers = [];
            let currentLineHasBreakpoint = false;
            for (const lineNum of breakpoints) {
                if (lineNum <= view.state.doc.lines) {
                    const pos = view.state.doc.line(lineNum).from;
                    if (pos === currentLinePos) {
                        currentLineHasBreakpoint = true;
                        continue; // handled below as combined marker
                    }
                    markers.push({ pos, marker: breakpointMarker });
                }
            }
            if (currentLinePos >= 0) {
                markers.push({
                    pos: currentLinePos,
                    marker: currentLineHasBreakpoint ? pausedAtBreakpointMarker : currentLineMarker,
                });
            }

            markers.sort((a, b) => a.pos - b.pos);
            for (const m of markers) {
                builder.add(m.pos, m.pos, m.marker);
            }

            return builder.finish();
        },
        domEventHandlers: {
            mousedown(view, line) {
                const lineNum = view.state.doc.lineAt(line.from).number;
                const lineText = view.state.doc.line(lineNum).text.trim();
                // Don't allow breakpoints on blank lines or comment-only lines
                if (!lineText || lineText.startsWith('#')) return true;
                view.dispatch({ effects: toggleBreakpointEffect.of(lineNum) });
                if (onBreakpointChange) {
                    // Defer to get updated state
                    requestAnimationFrame(() => {
                        const bps = [...view.state.field(breakpointState)].sort((a, b) => a - b);
                        onBreakpointChange(bps);
                    });
                }
                return true;
            },
        },
    });

    return [
        breakpointState,
        currentLineState,
        currentLineDecorationField,
        bp_gutter,
    ];
}


// --- Public API ---

/** Get current breakpoint line numbers from an EditorView. */
export function getBreakpoints(view) {
    return [...view.state.field(breakpointState)].sort((a, b) => a - b);
}

/** Programmatically set the current execution line (1-based, or 0 to clear). */
export function setCurrentLine(view, lineNum) {
    view.dispatch({ effects: setCurrentLineEffect.of(lineNum || 0) });
}

/** Programmatically toggle a breakpoint. */
export function toggleBreakpoint(view, lineNum) {
    view.dispatch({ effects: toggleBreakpointEffect.of(lineNum) });
}

/** Clear all breakpoints. */
export function clearBreakpoints(view) {
    view.dispatch({ effects: clearBreakpointsEffect.of(null) });
}
