/**
 * Menu command registration for noted.
 *
 * Call registerMenuCommands(menuBar, app) after both the MenuBar
 * and the App instance are initialized.
 *
 * Each command maps to an existing app.js method or action.
 */

function registerMenuCommands(menuBar, app) {

    // --- File ---

    menuBar.registerCommand('file.newProject', () => {
        app._sidebar.activate('explorer');
        // Trigger the create-project prompt in the explorer
        app._tree?.createProject?.();
    });

    menuBar.registerCommand('file.newNotebook', () => {
        // Requires a selected project node - activate explorer first
        app._sidebar.activate('explorer');
    });

    menuBar.registerCommand('file.save', () => {
        // Context-aware save: notebook or file editor
        const activeTab = app._activeTab;
        if (activeTab && app._fileEditors?.has(activeTab)) {
            app._fileEditors.get(activeTab).save();
        } else if (app._editor) {
            app._editor.save();
        }
    });

    menuBar.registerCommand('file.import', () => {
        app._editor?.import?.();
    });

    menuBar.registerCommand('file.export', () => {
        app._editor?.export();
    });

    // --- Edit ---

    menuBar.registerCommand('edit.undo', () => {
        app._editor?.undo();
    });

    menuBar.registerCommand('edit.cutCell', () => {
        app._editor?.selection?._copySelectedCells();
        app._editor?.selection?._deleteSelectedCells();
    });

    menuBar.registerCommand('edit.copyCell', () => {
        app._editor?.selection?._copySelectedCells();
    });

    menuBar.registerCommand('edit.pasteCell', () => {
        app._editor?.selection?._pasteCells();
    });

    menuBar.registerCommand('edit.deleteCell', () => {
        app._editor?.selection?._deleteSelectedCells();
    });

    menuBar.registerCommand('edit.findReplace', () => {
        app._editor?.openFindReplace?.();
    });

    // --- View ---

    menuBar.registerCommand('view.explorer', () => {
        app._sidebar.activate('explorer');
    });

    menuBar.registerCommand('view.sourceControl', () => {
        app._sidebar.activate('git');
    });

    menuBar.registerCommand('view.mlflow', () => {
        app._onIconBarClick('mlflow');
    });

    menuBar.registerCommand('view.airflow', () => {
        app._onIconBarClick('airflow');
    });

    menuBar.registerCommand('view.minio', () => {
        app._onIconBarClick('minio');
    });

    menuBar.registerCommand('view.evidently', () => {
        app._onIconBarClick('evidently');
    });

    menuBar.registerCommand('view.settings', () => {
        app._onIconBarClick('settings');
    });

    // --- Tools ---

    menuBar.registerCommand('tools.terminal', () => {
        app._onIconBarClick('terminal');
    });

    menuBar.registerCommand('tools.dvcPush', () => {
        app._sidebar.activate('git');
        // DVC push is triggered from the git panel's DVC section
        app._gitPanel?.dvcPush?.();
    });

    menuBar.registerCommand('tools.dvcPull', () => {
        app._sidebar.activate('git');
        app._gitPanel?.dvcPull?.();
    });

    // --- Help ---

    menuBar.registerCommand('help.manual', () => {
        window.open('https://github.com/noted-project/noted/wiki', '_blank');
    });

    menuBar.registerCommand('help.about', () => {
        const existing = document.getElementById('about-noted-overlay');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.id = 'about-noted-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);cursor:pointer';

        const card = document.createElement('div');
        card.style.cssText = 'position:relative;max-width:90vw;max-height:90vh;cursor:default;border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4)';

        const img = document.createElement('img');
        img.src = 'static/images/about_noted.png';
        img.style.cssText = 'display:block;max-width:90vw;max-height:90vh;object-fit:contain';
        img.alt = 'About noted';

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.style.cssText = 'position:absolute;top:8px;right:12px;font-size:24px;background:rgba(0,0,0,0.4);color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;line-height:30px;text-align:center';
        closeBtn.addEventListener('click', () => overlay.remove());

        card.appendChild(img);
        card.appendChild(closeBtn);
        overlay.appendChild(card);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        const onKey = (e) => {
            if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
        };
        document.addEventListener('keydown', onKey);

        document.body.appendChild(overlay);
    });

}

/**
 * Update menu context flags. Call this whenever the active tab
 * or editor state changes (e.g., in tab switch callbacks).
 */
function updateMenuContext(menuBar, app) {
    menuBar.setContext('hasNotebook', !!app._editor?.notebook);
    menuBar.setContext('hasDvc', !!app._gitPanel?.hasDvc?.());
    menuBar.refresh();
}
