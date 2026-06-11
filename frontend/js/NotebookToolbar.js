import { PostItIndexPanel } from './PostItIndexPanel.js';

/**
 * NotebookToolbar - Navigation, file actions, settings, connected users.
 */
export class NotebookToolbar {
    /**
     * @param {HTMLElement} containerEl
     * @param {import('./KernelClient.js').KernelClient} kernelClient
     * @param {object} callbacks - { onBrowse, onImport, onSave, onExport, onSettingsToggle }
     */
    constructor(containerEl, kernelClient, callbacks = {}) {
        this._container = containerEl;
        this._client = kernelClient;
        this._callbacks = callbacks;
        this._connectedUsers = {};
        this._servicePanels = {};
        this._postItIndex = new PostItIndexPanel(callbacks.getCells || (() => []));

        this._build();
        this._setupListeners();
    }

    _build() {
        this._container.innerHTML = '';

        // Spacer
        const spacer = document.createElement('div');
        spacer.className = 'toolbar-spacer';
        this._container.appendChild(spacer);

        // Connected users (right-aligned)
        this._usersEl = document.createElement('div');
        this._usersEl.className = 'connected-users';
        this._container.appendChild(this._usersEl);
    }

    _setupListeners() {
        this._client.on('user:joined', (data) => {
            this._connectedUsers[data.sid] = data.name;
            this._renderUsers();
        });
        this._client.on('user:left', (data) => {
            delete this._connectedUsers[data.sid];
            this._renderUsers();
        });
        this._client.on('notebook:state', (data) => {
            this._connectedUsers = {};
            const users = data.connected_users || {};
            for (const [sid, info] of Object.entries(users)) {
                this._connectedUsers[sid] = info.name || 'Anonymous';
            }
            this._renderUsers();
        });
    }

    _renderUsers() {
        this._usersEl.innerHTML = '';
        for (const [sid, name] of Object.entries(this._connectedUsers)) {
            const avatar = document.createElement('div');
            avatar.className = 'user-avatar';
            avatar.textContent = (name || '?')[0].toUpperCase();
            avatar.title = name;
            this._usersEl.appendChild(avatar);
        }
    }

    countNotes() {
        const getCells = this._callbacks.getCells || (() => []);
        const cells = getCells();
        let count = 0;
        for (const cell of cells) {
            const meta = cell._data?.metadata?.noted;
            if (meta && meta.annotation !== undefined) count++;
        }
        return count;
    }

    // --- Service panels ---

    _openServicePanel(svc) {
        if (this._servicePanels[svc.key]) {
            this._servicePanels[svc.key].front();
            return;
        }

        const panel = jsPanel.create({
            id: `service-panel-${svc.key}`,
            headerTitle: svc.title,
            theme: 'none',
            borderRadius: '5px',
            border: '1px solid var(--border-color)',
            boxShadow: 3,
            position: 'center',
            panelSize: { width: '80vw', height: '80vh' },
            headerControls: { minimize: 'remove', smallify: 'remove', normalize: 'remove', maximize: 'remove' },
            onclosed: () => {
                delete this._servicePanels[svc.key];
            },
            callback: (panel) => {
                const content = panel.content;
                content.style.padding = '0';
                content.style.overflow = 'hidden';

                const iframe = document.createElement('iframe');
                iframe.src = svc.url;
                iframe.style.cssText = 'width:100%;height:100%;border:none;';
                content.appendChild(iframe);
            },
        });

        this._servicePanels[svc.key] = panel;
    }

    // --- Helpers ---

    _createGroup() {
        const div = document.createElement('div');
        div.className = 'toolbar-group';
        return div;
    }

    _iconButton(svgHtml, title, onClick) {
        const btn = document.createElement('button');
        btn.className = 'toolbar-icon-btn';
        btn.innerHTML = svgHtml;
        btn.title = title;
        btn.addEventListener('click', onClick);
        return btn;
    }
}
