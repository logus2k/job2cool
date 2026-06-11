/**
 * DomainManagerPanel - master-detail panel for Domain + document CRUD.
 *
 * Replaces the legacy KnowledgeBaseManagerPanel. Single canonical surface
 * for every Domain lifecycle and per-Domain document operation.
 *
 * Layout:
 *   ┌──────────────────────────┬─────────────────────────────────────┐
 *   │ [+ New Domain]           │ <selected Domain header>            │
 *   ├──────────────────────────┤ [Documents][Knowledge][Settings]    │
 *   │ ⚪ general               ├─────────────────────────────────────┤
 *   │ ⚫ noted             [×] │ <tab content>                       │
 *   │ ⚪ eu_ai             [×] │                                     │
 *   └──────────────────────────┴─────────────────────────────────────┘
 *
 * Endpoints used (all already wired backend-side):
 *   POST   /api/domains
 *   DELETE /api/domains/{id}
 *   PATCH  /api/domains/{id}        (rename / re-describe)
 *   PATCH  /api/domains/active      (active set)
 *   plus per-tab endpoints (corpus, status, rebuild, document mutations)
 *   handled inside the tab classes.
 */

import { domainState } from '../domain-state.js';
import { modalError, modalForm } from '../modal.js';
import { notify } from '../Notify.js';
import { DomainDocumentsTab } from './DomainDocumentsTab.js';
import { DomainKnowledgeTab } from './DomainKnowledgeTab.js';
import { DomainSettingsTab } from './DomainSettingsTab.js';


// Tab icons match the Explorer tree's branch icons:
//   Documents -> fa-file-lines  (matches kb-documents)
//   Knowledge -> fa-database    (covers Vector + Graph in one icon)
//   Settings  -> fa-sliders
const TABS = [
    { id: 'documents', label: 'Documents', icon: 'fa-solid fa-file-lines', cls: DomainDocumentsTab },
    { id: 'knowledge', label: 'Knowledge', icon: 'fa-solid fa-database',   cls: DomainKnowledgeTab },
    { id: 'settings',  label: 'Settings',  icon: 'fa-solid fa-sliders',    cls: DomainSettingsTab },
];


export class DomainManagerPanel {

    constructor() {
        this._panel = null;
        this._els = {};
        this._selectedDomainId = null;
        this._currentTabId = 'documents';
        this._currentTabInstance = null;
        this._unsubscribeKbState = null;
    }

    /** Open (or front) the panel. `initialDomainId` optionally pre-selects
     *  a Domain in the left list (used by the Explorer's `Manage Domain...`
     *  context-menu entry). */
    open(initialDomainId = null) {
        if (this._panel) {
            this._panel.front();
            if (initialDomainId) this._selectDomain(initialDomainId);
            return;
        }
        this._panel = jsPanel.create({
            id: 'domain-manager-panel',
            headerTitle: '<i class="fa-solid fa-landmark" style="color:#ffffff;-webkit-text-stroke:1.5px #666666;paint-order:stroke fill;margin-right:6px"></i>Domain Manager',
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            position: 'center',
            panelSize: { width: 1288, height: 620 },
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            onclosed: () => this.destroy(),
            callback: (panel) => {
                this._panel = panel;
                panel.content.style.padding = '0';
                panel.content.style.overflow = 'hidden';
                this._buildShell();
                this._unsubscribeKbState = domainState.onChange(() => this._onDomainStateChanged());
                domainState.refresh().then(() => {
                    this._renderLeftList();
                    const target = initialDomainId
                        || this._selectedDomainId
                        || this._defaultSelection();
                    if (target) this._selectDomain(target);
                }).catch(() => {
                    this._renderLeftList();
                });
            },
        });
    }

    close() {
        if (this._panel) this._panel.close();
    }

    destroy() {
        if (this._currentTabInstance && typeof this._currentTabInstance.destroy === 'function') {
            try { this._currentTabInstance.destroy(); } catch (_) { /* noop */ }
            this._currentTabInstance = null;
        }
        if (this._unsubscribeKbState) {
            try { this._unsubscribeKbState(); } catch (_) { /* noop */ }
            this._unsubscribeKbState = null;
        }
        this._panel = null;
        this._els = {};
        this._selectedDomainId = null;
    }

    // ── Shell ───────────────────────────────────────────────────────

    _buildShell() {
        const root = document.createElement('div');
        root.className = 'dm-root';
        root.innerHTML = `
            <div class="dm-left">
                <div class="dm-left__head">
                    <button class="rm-btn dm-create-btn" id="dm-create-btn">
                        <i class="fa-solid fa-folder-plus dm-i-add"></i>
                        <span>New Domain</span>
                    </button>
                </div>
                <div class="dm-left__list" id="dm-list"></div>
            </div>
            <div class="dm-right" id="dm-right">
                <div class="dm-right__empty" id="dm-right-empty">
                    Select a Domain on the left to view its documents and settings.
                </div>
                <div class="dm-right__body" id="dm-right-body" style="display:none">
                    <div class="dm-header" id="dm-header"></div>
                    <div class="dm-tabs" id="dm-tabs"></div>
                    <div class="dm-tab-body" id="dm-tab-body"></div>
                </div>
            </div>
            <div id="dm-error-card" class="dm-error" style="display:none"></div>
        `;
        this._panel.content.appendChild(root);

        this._els.root          = root;
        this._els.createBtn     = root.querySelector('#dm-create-btn');
        this._els.list          = root.querySelector('#dm-list');
        this._els.right         = root.querySelector('#dm-right');
        this._els.rightEmpty    = root.querySelector('#dm-right-empty');
        this._els.rightBody     = root.querySelector('#dm-right-body');
        this._els.header        = root.querySelector('#dm-header');
        this._els.tabs          = root.querySelector('#dm-tabs');
        this._els.tabBody       = root.querySelector('#dm-tab-body');
        this._els.errorCard     = root.querySelector('#dm-error-card');

        this._els.createBtn.addEventListener('click', () => this._openCreateDialog());
        this._els.errorCard.addEventListener('click', () => {
            this._els.errorCard.style.display = 'none';
        });
    }

    // ── Left pane: Domain list ──────────────────────────────────────

    _renderLeftList() {
        const domains = domainState.getDomains();
        const list = this._els.list;
        list.innerHTML = '';
        if (!domains.length) {
            const empty = document.createElement('div');
            empty.className = 'dm-list-empty';
            empty.textContent = 'No Domains yet. Click "New Domain".';
            list.appendChild(empty);
            return;
        }
        for (const d of domains) {
            list.appendChild(this._renderListRow(d));
        }
    }

    _renderListRow(domain) {
        const id = domain.domain_id;
        const isActive   = domainState.isActive(id);
        const isPinned   = !!domain.pinned;
        const isSelected = id === this._selectedDomainId;

        const row = document.createElement('div');
        row.className = 'dm-list-row';
        if (isSelected) row.classList.add('is-selected');
        row.dataset.domainId = id;

        // Active checkbox (multi-active fan-out)
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'dm-list-active';
        cb.checked = isActive;
        cb.title = isPinned ? 'Pinned-active (cannot deactivate)' : 'Active';
        cb.addEventListener('change', (ev) => {
            ev.stopPropagation();
            this._toggleActive(id, cb.checked);
        });
        cb.addEventListener('click', (ev) => ev.stopPropagation());
        row.appendChild(cb);

        // Name + meta
        const info = document.createElement('div');
        info.className = 'dm-list-info';
        const name = document.createElement('div');
        name.className = 'dm-list-name';
        name.textContent = domain.name || id;
        info.appendChild(name);
        const sub = document.createElement('div');
        sub.className = 'dm-list-sub';
        const tags = [];
        if (isPinned) tags.push('PINNED');
        if (!domain.has_knowledge) tags.push('skills/tools only');
        sub.textContent = tags.length ? `${id} · ${tags.join(' · ')}` : id;
        info.appendChild(sub);
        row.appendChild(info);

        row.addEventListener('click', () => this._selectDomain(id));
        return row;
    }

    _defaultSelection() {
        const domains = domainState.getDomains();
        if (!domains.length) return null;
        const active = domainState.getActiveDomains();
        const firstActiveWithKnowledge = domains.find(
            (d) => d.has_knowledge && active.indexOf(d.domain_id) !== -1,
        );
        if (firstActiveWithKnowledge) return firstActiveWithKnowledge.domain_id;
        const firstWithKnowledge = domains.find((d) => d.has_knowledge);
        return firstWithKnowledge ? firstWithKnowledge.domain_id : domains[0].domain_id;
    }

    // ── Right pane: header + tabs ───────────────────────────────────

    _selectDomain(domainId) {
        const domain = domainState.getDomain(domainId);
        if (!domain) return;
        this._selectedDomainId = domainId;

        // Re-paint the row selection state without rebuilding the list.
        this._els.list.querySelectorAll('.dm-list-row').forEach((r) => {
            r.classList.toggle('is-selected', r.dataset.domainId === domainId);
        });

        this._els.rightEmpty.style.display = 'none';
        this._els.rightBody.style.display = '';

        this._renderHeader(domain);
        this._renderTabBar(domain);
        this._mountTab(this._currentTabId, domain);
    }

    _renderHeader(domain) {
        const head = this._els.header;
        head.innerHTML = '';

        const title = document.createElement('h2');
        title.className = 'dm-header-title';
        title.textContent = domain.name || domain.domain_id;
        head.appendChild(title);

        const slug = document.createElement('span');
        slug.className = 'dm-header-slug';
        slug.textContent = domain.domain_id;
        head.appendChild(slug);

        if (domain.pinned) {
            const pin = document.createElement('span');
            pin.className = 'dm-header-pin';
            pin.innerHTML = '<i class="fa-solid fa-lock dm-i-pin"></i> PINNED';
            head.appendChild(pin);
        }

        const desc = document.createElement('div');
        desc.className = 'dm-header-desc';
        desc.textContent = domain.description || 'No description.';
        head.appendChild(desc);
    }

    _renderTabBar(domain) {
        const bar = this._els.tabs;
        bar.innerHTML = '';
        for (const tab of TABS) {
            const btn = document.createElement('button');
            btn.className = 'dm-tab-btn';
            if (tab.id === this._currentTabId) btn.classList.add('is-active');
            btn.dataset.tabId = tab.id;
            btn.innerHTML = `<i class="${tab.icon}"></i><span>${tab.label}</span>`;
            btn.addEventListener('click', () => {
                if (this._currentTabId === tab.id) return;
                this._currentTabId = tab.id;
                bar.querySelectorAll('.dm-tab-btn').forEach((b) => {
                    b.classList.toggle('is-active', b.dataset.tabId === tab.id);
                });
                this._mountTab(tab.id, domain);
            });
            bar.appendChild(btn);
        }
    }

    _mountTab(tabId, domain) {
        // Tear down the previous tab cleanly before mounting the next one.
        if (this._currentTabInstance && typeof this._currentTabInstance.destroy === 'function') {
            try { this._currentTabInstance.destroy(); } catch (_) { /* noop */ }
        }
        this._currentTabInstance = null;
        this._els.tabBody.innerHTML = '';

        const def = TABS.find((t) => t.id === tabId);
        if (!def) return;
        const ctx = {
            domain,
            container: this._els.tabBody,
            // Tabs sometimes need to ask the parent to refresh the Domain list
            // (e.g. after a rename, the left-pane name should update).
            onDomainMutated: () => this._onDomainMutated(),
            onDomainDeleted: () => this._onDomainDeleted(domain.domain_id),
            // Inline edits in the Settings tab also update the header.
            onHeaderUpdate: (d) => this._renderHeader(d),
            showError: (msg) => this._showError(msg),
        };
        try {
            this._currentTabInstance = new def.cls(ctx);
            this._currentTabInstance.mount();
        } catch (e) {
            this._els.tabBody.innerHTML = '';
            const errBox = document.createElement('div');
            errBox.className = 'dm-tab-error';
            errBox.textContent = `Tab failed to load: ${e && e.message ? e.message : e}`;
            this._els.tabBody.appendChild(errBox);
        }
    }

    // ── Domain CRUD operations (left-pane buttons + dialogs) ────────

    async _toggleActive(domainId, checked) {
        const current = domainState.getActiveDomains();
        let next;
        if (checked) {
            if (current.indexOf(domainId) !== -1) return;
            next = [...current, domainId];
        } else {
            const d = domainState.getDomain(domainId);
            if (d && d.pinned) {
                this._showError(`${d.name || domainId} is pinned-active and cannot be deactivated.`);
                this._renderLeftList();
                return;
            }
            if (current.length <= 1) {
                this._showError('At least one Domain must remain active.');
                this._renderLeftList();
                return;
            }
            next = current.filter((k) => k !== domainId);
        }
        try {
            await domainState.setActive(next);
            notify.info(`Active Domains: ${domainState.getActiveDomains().join(', ')}`);
        } catch (e) {
            this._showError(`Could not update active set: ${e.message}`);
            this._renderLeftList();
        }
    }

    async _openCreateDialog() {
        const result = await modalForm(
            [
                { key: 'domain_id',   label: 'Domain id (lowercase, letters/digits/underscore, max 32)', placeholder: 'e.g. user_domain', required: true },
                { key: 'name',        label: 'Display name', placeholder: 'e.g. My Domain Knowledge', required: false },
                { key: 'description', label: 'Description',  placeholder: 'Optional', required: false },
            ],
            { title: 'Create Domain', confirmText: 'Create' },
        );
        if (!result) return;
        const params = new URLSearchParams({ domain_id: result.domain_id });
        if (result.name) params.set('name', result.name);
        if (result.description) params.set('description', result.description);
        try {
            const r = await fetch(`api/domains?${params.toString()}`, { method: 'POST' });
            if (!r.ok) {
                const body = await r.json().catch(() => ({}));
                throw new Error(body.detail || `HTTP ${r.status}`);
            }
            notify.info(`Created Domain: ${result.domain_id}`);
            await domainState.refresh();
            this._renderLeftList();
            this._selectDomain(result.domain_id);
        } catch (e) {
            modalError(`Could not create Domain: ${e.message}`, { title: 'Create failed' });
        }
    }

    // ── State change handlers ───────────────────────────────────────

    async _onDomainStateChanged() {
        // Active set changed externally - just repaint the list checkmarks.
        // Leave the right pane alone so a tab's in-progress edit isn't lost.
        this._renderLeftList();
    }

    async _onDomainMutated() {
        // A tab (typically Settings) edited the current Domain. Pull a fresh
        // registry snapshot, repaint the list (name may have changed) and
        // refresh the header. The tab itself manages its own body content.
        await domainState.refresh();
        this._renderLeftList();
        const d = domainState.getDomain(this._selectedDomainId);
        if (d) this._renderHeader(d);
    }

    async _onDomainDeleted(domainId) {
        await domainState.refresh();
        if (this._selectedDomainId === domainId) {
            this._selectedDomainId = null;
            if (this._currentTabInstance && typeof this._currentTabInstance.destroy === 'function') {
                try { this._currentTabInstance.destroy(); } catch (_) { /* noop */ }
            }
            this._currentTabInstance = null;
            this._els.tabBody.innerHTML = '';
            this._els.rightBody.style.display = 'none';
            this._els.rightEmpty.style.display = '';
        }
        this._renderLeftList();
    }

    _showError(message) {
        // Stays visible until the user clicks the card (or until the next
        // successful render hides it). No setTimeout per project memory.
        this._els.errorCard.textContent = message;
        this._els.errorCard.style.display = '';
    }
}
