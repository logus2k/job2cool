/**
 * TabBar - Manages tabs above the notebook area.
 *
 * Tab types:
 *   - 'notebook': notebook tabs (closable)
 *   - 'service':  iframe-based service tabs (closable) — MLflow, Airflow, MinIO
 *   - 'pyfile':   file editor tabs (closable, may be preview/transient)
 *
 * Preview tabs: single-click opens a transient preview tab (italic label).
 * Double-click or editing pins the tab. A new preview replaces the old one.
 */
export class TabBar {

    /**
     * @param {HTMLElement} containerEl - The element to render into (e.g. #center-column)
     * @param {object} callbacks
     * @param {function(string)} callbacks.onActivateTab - called with tab key when a tab is activated
     * @param {function(string)} callbacks.onCloseTab - called with tab key when a service tab is closed
     * @param {function(string)} [callbacks.onUndockTab] - called with tab key when undock is requested
     * @param {function(string)} [callbacks.onDockTab] - called with tab key when re-dock is requested
     */
    constructor(containerEl, callbacks = {}) {
        this._container = containerEl;
        this._callbacks = callbacks;

        /** @type {Map<string, {key:string, label:string, type:string, icon?:string, closable:boolean, preview:boolean, undockable:boolean, undocked:boolean}>} */
        this._tabs = new Map();
        this._activeKey = null;
        this._previewKey = null;  // key of the current preview tab (at most one)

        // Create the tab bar wrapper and insert at the top of the container
        this._barEl = document.createElement('div');
        this._barEl.className = 'tab-bar';
        this._container.insertBefore(this._barEl, this._container.firstChild);
    }

    /**
     * Add a tab. If it already exists, just activate it.
     * @param {{key:string, label:string, type:string, icon?:string, closable?:boolean, preview?:boolean}} tab
     */
    addTab(tab) {
        if (this._tabs.has(tab.key)) {
            const existing = this._tabs.get(tab.key);
            // Update undockable if provided
            if (tab.undockable !== undefined) existing.undockable = !!tab.undockable;
            // If existing tab is preview and this is a non-preview add, pin it
            if (existing.preview && !tab.preview) {
                this.pinTab(tab.key);
            }
            this.activate(tab.key);
            return;
        }

        // If adding a preview tab, close the existing preview tab first
        if (tab.preview && this._previewKey && this._previewKey !== tab.key) {
            this.closeTab(this._previewKey);
        }

        this._tabs.set(tab.key, {
            key: tab.key,
            label: tab.label,
            tooltip: tab.tooltip || tab.label,
            type: tab.type || 'service',
            icon: tab.icon || null,
            closable: tab.closable !== false,
            preview: !!tab.preview,
            undockable: !!tab.undockable,
            undocked: false,
        });

        if (tab.preview) this._previewKey = tab.key;

        this._render();
        this.activate(tab.key);
    }

    /**
     * Pin a preview tab (make it permanent).
     */
    pinTab(key) {
        const tab = this._tabs.get(key);
        if (!tab || !tab.preview) return;
        tab.preview = false;
        if (this._previewKey === key) this._previewKey = null;
        this._render();
    }

    /**
     * Close the current preview tab (if any).
     */
    closePreview() {
        if (this._previewKey) this.closeTab(this._previewKey);
    }

    /**
     * Close (remove) a tab.
     */
    closeTab(key) {
        const tab = this._tabs.get(key);
        if (!tab || !tab.closable) return;

        if (this._previewKey === key) this._previewKey = null;
        this._tabs.delete(key);

        // If closing the active tab, switch to a neighbor (skip undocked)
        if (this._activeKey === key) {
            const remaining = [...this._tabs.entries()]
                .filter(([, t]) => !t.undocked)
                .map(([k]) => k);
            if (remaining.length > 0) {
                this._activeKey = remaining[remaining.length - 1];
                this._callbacks.onActivateTab?.(this._activeKey);
            } else {
                this._activeKey = null;
                this._callbacks.onActivateTab?.(null);
            }
        }

        this._callbacks.onCloseTab?.(key);
        this._render();
    }

    /**
     * Activate a tab by key.
     */
    activate(key) {
        if (!this._tabs.has(key)) return;
        if (this._activeKey === key) return;
        this._activeKey = key;
        this._updateActiveState();
        this._callbacks.onActivateTab?.(key);
    }

    /**
     * Get the active tab key.
     */
    get activeKey() {
        return this._activeKey;
    }

    /**
     * Update a tab's label and tooltip.
     */
    setTabLabel(key, label, tooltip) {
        const tab = this._tabs.get(key);
        if (tab) {
            tab.label = label || tab.label;
            if (tooltip) tab.tooltip = tooltip;
            this._render();
        }
    }

    /** @deprecated Use setTabLabel instead */
    setNotebookLabel(label, tooltip) {
        this.setTabLabel('notebook', label, tooltip);
    }

    /**
     * Check if a tab exists.
     */
    hasTab(key) {
        return this._tabs.has(key);
    }

    /**
     * Undock a tab to a floating panel.
     */
    undockTab(key) {
        const tab = this._tabs.get(key);
        if (!tab || !tab.undockable || tab.undocked) return;
        tab.undocked = true;

        // Notify BEFORE switching tabs so the callback can capture
        // content (e.g., clone a document viewer) while it's still active.
        this._callbacks.onUndockTab?.(key);

        // Switch to another tab if this was active
        if (this._activeKey === key) {
            const remaining = [...this._tabs.entries()].filter(([k, t]) => !t.undocked && k !== key);
            if (remaining.length > 0) {
                this.activate(remaining[remaining.length - 1][0]);
            } else {
                this._activeKey = null;
                this._callbacks.onActivateTab?.(null);
            }
        }

        this._render();
    }

    /**
     * Re-dock a floating tab back into the tab bar.
     */
    dockTab(key) {
        const tab = this._tabs.get(key);
        if (!tab || !tab.undocked) return;
        tab.undocked = false;
        this._render();
        // Force re-activation even if this tab was already the active
        // key. Without clearing _activeKey first, activate() returns
        // early because it thinks the tab is already active - but the
        // content was in a floating panel and needs to be re-rendered
        // in the docked service container.
        this._activeKey = null;
        this.activate(key);
        this._callbacks.onDockTab?.(key);
    }

    /**
     * Check if a tab is currently undocked.
     */
    isUndocked(key) {
        return this._tabs.get(key)?.undocked || false;
    }

    // --- Internal ---

    _render() {
        this._barEl.innerHTML = '';

        for (const [key, tab] of this._tabs) {
            const el = document.createElement('div');
            el.className = 'tab';
            if (tab.preview) el.classList.add('tab-preview');
            el.dataset.tabKey = key;
            el.title = tab.tooltip || tab.label;

            if (tab.icon) {
                const img = document.createElement('img');
                img.className = 'tab-icon';
                img.src = tab.icon;
                img.alt = '';
                el.appendChild(img);
            }

            const labelSpan = document.createTextNode(tab.label);
            el.appendChild(labelSpan);

            el.addEventListener('click', () => {
                // Clicking a preview tab pins it (makes it sticky)
                if (tab.preview) this.pinTab(key);
                this.activate(key);
            });

            // Double-click also pins (for consistency)
            if (tab.preview) {
                el.addEventListener('dblclick', () => this.pinTab(key));
            }

            // Close button for closable tabs
            if (tab.closable) {
                const closeBtn = document.createElement('span');
                closeBtn.className = 'tab-close-btn';
                closeBtn.textContent = '\u00d7';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeTab(key);
                });
                el.appendChild(closeBtn);
            }

            // Hide undocked tabs
            if (tab.undocked) el.style.display = 'none';

            this._barEl.appendChild(el);
        }

        this._updateActiveState();
    }

    _updateActiveState() {
        const tabs = this._barEl.querySelectorAll('.tab');
        tabs.forEach(el => {
            if (el.dataset.tabKey === this._activeKey) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
    }
}
