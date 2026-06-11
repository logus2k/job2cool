/**
 * app-menu.js - Menu bar command registration for the noted application.
 *
 * Registers all commands from menu.json to their implementations:
 * - File: new project, new file, save, import, upload, export
 * - Edit: undo, cell operations, format, organize imports, go-to-definition
 * - View: explorer, source control, MLflow, Airflow, MinIO, Evidently, minimap, settings
 * - Tools: terminal, DVC push/pull
 * - Help: manual, about
 *
 * All commands reference App instance state (editors, tabs, panels).
 * Attached to the App instance via initMenuCommands(app).
 */

import { notify } from './Notify.js';
import { FileEditor } from './FileEditor.js';
import { openProjectTerminal } from './ProjectTerminal.js';

/**
 * Register all menu bar commands on the App instance.
 * @param {object} app - The App instance
 */
export function initMenuCommands(app) {

    app._registerMenuCommands = function() {
        const mb = app._menuBar;

        // File
        mb.registerCommand('file.newProject', () => {
            if (!app._sidebar.openViews.has('projects')) {
                app._onIconBarClick('projects');
            }
            const projectsRoot = app._explorerPanel._tree?.findKey('root-projects');
            if (projectsRoot) {
                projectsRoot.setActive(true);
                requestAnimationFrame(() => {
                    app._explorerPanel._detailEl?.querySelector('.explorer-create-form input')?.focus();
                });
            }
        });
        mb.registerCommand('file.newFile', () => {
            if (!app._sidebar.openViews.has('projects')) {
                app._onIconBarClick('projects');
            }
            const pid = app._currentProject;
            const nodeKey = pid ? `project:${pid}` : 'root-projects';
            const node = app._explorerPanel._tree?.findKey(nodeKey);
            if (node) {
                node.setActive(true);
                requestAnimationFrame(() => {
                    app._explorerPanel._detailEl?.querySelector('.explorer-create-form input')?.focus();
                });
            }
        });
        mb.registerCommand('file.save', () => {
            // Check if focus is inside an undocked panel first
            const focused = document.activeElement;
            for (const [key, panel] of app._undockedPanels) {
                if (panel.contains(focused)) {
                    if (key.startsWith('notebook:')) {
                        const entry = app._editors.get(key);
                        if (entry) entry.editor.save();
                    } else if (key.startsWith('pyfile:') && app._fileEditors?.has(key)) {
                        app._fileEditors.get(key).save();
                    }
                    return;
                }
            }
            // Fall back to docked tabs
            const activeTab = app._tabBar.activeKey;
            if (activeTab && app._fileEditors?.has(activeTab)) {
                app._fileEditors.get(activeTab).save();
            } else if (app._editor) {
                app._editor.save();
            }
        });
        mb.registerCommand('file.import', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.ipynb';
            input.addEventListener('change', () => {
                const file = input.files?.[0];
                if (file) app._editor?.importFile?.(file);
            });
            input.click();
        });
        mb.registerCommand('file.upload', () => {
            const node = app._explorerPanel._tree?.getActiveNode();
            const nodeKey = node?.key || '';
            let rootType, rootName, relPath = '';

            if (nodeKey.startsWith('project:')) {
                rootType = 'project'; rootName = nodeKey.substring(8);
            } else if (nodeKey.startsWith('mount:')) {
                rootType = 'mount'; rootName = nodeKey.substring(6);
            } else if (nodeKey.startsWith('pdir:')) {
                const parsed = app._explorerPanel._parseFileKey(nodeKey);
                rootType = 'project'; rootName = parsed.rootName; relPath = parsed.relPath;
            } else if (nodeKey.startsWith('mdir:')) {
                const parsed = app._explorerPanel._parseFileKey(nodeKey);
                rootType = 'mount'; rootName = parsed.rootName; relPath = parsed.relPath;
            } else if (nodeKey.startsWith('pfile:')) {
                const parsed = app._explorerPanel._parseFileKey(nodeKey);
                rootType = 'project'; rootName = parsed.rootName;
                relPath = parsed.relPath.includes('/') ? parsed.relPath.substring(0, parsed.relPath.lastIndexOf('/')) : '';
            } else if (nodeKey.startsWith('mfile:')) {
                const parsed = app._explorerPanel._parseFileKey(nodeKey);
                rootType = 'mount'; rootName = parsed.rootName;
                relPath = parsed.relPath.includes('/') ? parsed.relPath.substring(0, parsed.relPath.lastIndexOf('/')) : '';
            } else if (app._currentProject) {
                rootName = app._currentProject;
                rootType = app._explorerPanel?._projectSources?.[rootName] === 'mount' ? 'mount' : 'project';
            } else {
                import('./modal.js').then(({ modalError }) => modalError('Select a project or folder in Explorer first.'));
                return;
            }
            app._explorerPanel._triggerUpload(rootType, rootName, relPath);
        });
        mb.registerCommand('file.exportIpynb', () => {
            app._editor?.export();
        });
        mb.registerCommand('file.exportMarkdown', () => {
            app._exportPanel.open('markdown');
        });
        mb.registerCommand('file.exportPdf', () => {
            app._exportPanel.open('pdf');
        });
        mb.registerCommand('file.exportHtml', () => {
            app._exportPanel.open('html');
        });
        mb.registerCommand('file.exportWord', () => {
            app._exportPanel.open('word');
        });

        // Edit
        mb.registerCommand('edit.undo', () => {
            const activeKey = app._tabBar?.activeKey;
            if (activeKey?.startsWith('pyfile:')) {
                app._fileEditors.get(activeKey)?.undo();
            } else {
                app._editor?.undo();
            }
        });
        mb.registerCommand('edit.cutCell', () => {
            app._editor?.selection?._copySelectedCells();
            app._editor?.selection?._deleteSelectedCells();
        });
        mb.registerCommand('edit.copyCell', () => {
            app._editor?.selection?._copySelectedCells();
        });
        mb.registerCommand('edit.pasteCell', () => {
            app._editor?.selection?._pasteCells();
        });
        mb.registerCommand('edit.deleteCell', () => {
            app._editor?.selection?._deleteSelectedCells();
        });
        mb.registerCommand('edit.findReplace', () => {
            app._editor?.openFindReplace?.();
        });
        mb.registerCommand('edit.formatDocument', () => {
            const activeKey = app._tabBar?.activeKey;
            if (activeKey?.startsWith('pyfile:')) {
                const editor = app._fileEditors.get(activeKey);
                if (editor) editor._formatDocument();
            }
        });
        mb.registerCommand('edit.organizeImports', () => {
            const activeKey = app._tabBar?.activeKey;
            if (activeKey?.startsWith('pyfile:')) {
                const editor = app._fileEditors.get(activeKey);
                if (editor) editor._organizeImports();
            }
        });
        mb.registerCommand('edit.goToDefinition', () => {
            const activeKey = app._tabBar?.activeKey;
            if (activeKey?.startsWith('pyfile:')) {
                const editor = app._fileEditors.get(activeKey);
                if (editor) editor.goToDefinition();
            }
        });
        mb.registerCommand('edit.findReferences', () => {
            notify.info('Find All References is not yet available');
        });
        mb.registerCommand('edit.renameSymbol', () => {
            notify.info('Rename Symbol is not yet available');
        });
        mb.registerCommand('edit.goToCell', () => {
            app._showGoToCellModal?.();
        });

        // View
        mb.registerCommand('view.explorer', () => {
            app._onIconBarClick('projects');
        });
        mb.registerCommand('view.sourceControl', () => {
            app._onIconBarClick('git');
        });
        mb.registerCommand('view.toc', () => {
            app._onIconBarClick('toc');
        });
        mb.registerCommand('view.mlflow', () => {
            app._onIconBarClick('mlflow');
        });
        mb.registerCommand('view.airflow', () => {
            app._onIconBarClick('airflow');
        });
        mb.registerCommand('view.minio', () => {
            app._onIconBarClick('minio');
        });
        mb.registerCommand('view.evidently', () => {
            app._onIconBarClick('evidently');
        });
        mb.setContext('minimapEnabled', true);
        mb.registerCommand('view.minimap', () => {
            const enabled = !mb.getContext('minimapEnabled');
            mb.setContext('minimapEnabled', enabled);
            mb.refresh();
            FileEditor.setMinimapEnabled(enabled);
        });
        mb.registerCommand('view.settings', () => {
            app._onIconBarClick('settings');
        });
        mb.registerCommand('view.knowledgeGraph', () => {
            app._openKnowledgeGraphTab();
        });
        mb.registerCommand('view.knowledgeBaseMonitor', () => {
            app.showKnowledgeBaseMonitor();
        });
        mb.registerCommand('view.workflowMonitor', () => {
            app.showWorkflowMonitor();
        });

        // Tools
        mb.registerCommand('tools.terminal', () => {
            // Same flow as the per-project / per-debug terminals: openProjectTerminal
            // handles the NOTED_TERMINAL_SECRET prompt and reuses an existing
            // session for the same cwd. Prefer the active project's path so the
            // user lands where they expect; fall back to /app otherwise.
            const socket = app._client?.socket;
            if (!socket) { notify.error('Not connected to backend'); return; }
            let cwd = '/app';
            let label = 'Terminal';
            const proj = app._currentProject;
            if (proj) {
                const isMount = app._explorerPanel?._projectSources?.[proj] === 'mount';
                cwd = isMount ? `/app/mounts/${proj}` : `/app/projects/${proj}`;
                label = `Terminal: ${proj}`;
            }
            openProjectTerminal(socket, cwd, label);
        });
        mb.registerCommand('tools.kbManager', () => {
            app.showKnowledgeBaseManager();
        });
        mb.registerCommand('tools.uploadDoc', () => {
            const cm = app._explorerPanel?._contextMenuMod;
            if (!cm?.uploadDocumentToDomain) {
                notify.error('Upload is not available');
                return;
            }
            cm.uploadDocumentToDomain();
        });

        // Help
        mb.registerCommand('help.manual', () => {
            app._openDocumentTab({
                name: 'noted Platform User Manual',
                category: 'Manuals',
                location: 'noted/noted_platform_user_manual.pdf',
            });
        });
        mb.registerCommand('help.developerManual', () => {
            app._openDocumentTab({
                name: 'noted Platform Developer Manual',
                category: 'Manuals',
                location: 'noted/noted_platform_developer_manual.pdf',
            });
        });
        mb.registerCommand('help.projectCompanion', () => {
            app._openDocumentTab({
                name: 'noted Project Notebook Companion',
                category: 'Manuals',
                location: 'noted/noted_project_notebook_companion.pdf',
            });
        });
        mb.registerCommand('help.setup', () => {
            app._openDocumentTab({
                name: 'noted Platform - Setup and Installation Manual',
                category: 'Manuals',
                location: 'noted/noted_platform_setup_and_installation_manual.pdf',
            });
        });
        mb.registerCommand('help.architecture', () => {
            app._openDocumentTab({
                name: 'noted Platform Technical Architecture',
                category: 'Manuals',
                location: 'noted/noted_platform_technical_architecture.pdf',
            });
        });
        mb.registerCommand('help.github', () => {
            window.open('https://github.com/logus2k/noted', '_blank');
        });
        mb.registerCommand('help.about', () => {
            const existing = document.getElementById('about-noted-overlay');
            if (existing) { existing.remove(); return; }

            const overlay = document.createElement('div');
            overlay.id = 'about-noted-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);cursor:pointer';

            const card = document.createElement('div');
            card.style.cssText = 'position:relative;max-width:90vw;max-height:90vh;cursor:default;border-radius:4px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);border:8px solid #fffaf5';

            const img = document.createElement('img');
            img.src = 'static/images/about_noted.png';
            img.style.cssText = 'display:block;max-width:35vw;max-height:35vh;object-fit:contain';
            img.alt = 'About noted';

            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = '&times;';
            closeBtn.style.cssText = 'position:absolute;top:8px;right:12px;font-size:21px;background:rgba(0,0,0,0.4);color:#fff;border:none;border-radius:50%;width:35px;height:32px;cursor:pointer;line-height:22px;text-align:center';
            closeBtn.addEventListener('click', () => overlay.remove());

            const scroller = document.createElement('div');
            scroller.className = 'about-scroller';
            scroller.style.cssText = 'position:absolute;bottom:10px;left:0;right:0;overflow:hidden;height:44px;background:rgba(0,0,0,0.45);cursor:default';
            const scrollText = document.createElement('span');
            scrollText.textContent = '\u2b50\ud83d\ude80\u2b50 STARSHIP noted \u2014 INTERGALACTIC MLOPS VESSEL \u2b50\ud83d\ude80\u2b50 '
                + '\ud83d\udc68\u200d\ud83d\ude80 MISSION ARCHITECT: Ant\u00f3nio Cruz \u2022 \ud83e\uddd1\u200d\u2708\ufe0f CHIEF NAVIGATION OFFICER: Bruno Santos \u2022 \ud83d\udc68\u200d\ud83d\udd2c SCIENCE OFFICER: Pedro Miranda \u2022 \ud83d\udc68\u200d\ud83d\udd27 PROPULSION ENGINEER: Ricardo Kayseller '
                + ' \ud83d\ude80\ud83d\udca8\ud83d\udca8\ud83d\udca8 '
                + '\ud83d\udd25 PROPULSION CORE \ud83d\udd25 FastAPI \u26a1 Uvicorn \u26a1 python-socketio \ud83d\udd0c asyncio \u267e\ufe0f httpx \ud83c\udf10 nginx reverse thrusters \ud83d\udea2 '
                + ' \ud83d\udee0\ufe0f\u2699\ufe0f\ud83d\udee0\ufe0f '
                + '\ud83e\udded NAVIGATION ARRAY \ud83e\udded MLflow \ud83d\udcca experiment tracking \u2022 DVC \ud83d\udce6 data warp drive \u2022 Hydra \ud83d\udc09 configuration matrix \u2022 OmegaConf \ud83e\udde9 resolver \u2022 Apache Airflow \ud83c\udf2c\ufe0f orchestration engines \u2022 Celery \ud83d\udc1d task fleet \u2022 MinIO \ud83d\uddc4\ufe0f artifact cargo bays '
                + ' \ud83d\udee8\ufe0f\ud83d\udd29\ud83d\udee8\ufe0f '
                + '\ud83c\udfed HULL STRUCTURE \ud83c\udfed Docker \ud83d\udc33 container hull \u2022 Docker Compose \ud83d\udcda multi-container chassis \u2022 PostgreSQL \ud83d\uddc3\ufe0f memory banks \u2022 Redis \u26a1 comm relay \u2022 13 service modules in formation flight \ud83d\ude80\ud83d\ude80\ud83d\ude80 '
                + ' \ud83d\udce1\ud83d\udd2d\ud83d\udce1 '
                + '\ud83d\udcf6 SENSOR GRID \ud83d\udcf6 Evidently \ud83d\udcca data quality scanners \u2022 DataDriftPreset \ud83c\udf0a long-range drift radar \u2022 DataSummaryPreset \u2705 hull integrity checks \u2022 Three.js \ud83c\udf0c Knowledge Graph holographic display '
                + ' \ud83c\udf0d\ud83c\udf31\ud83c\udf0d '
                + '\ud83e\ude90 LIFE SUPPORT SYSTEMS \ud83e\ude90 Python \ud83d\udc0d 3.10-3.14 (including free-threaded variants) \u2022 JavaScript \ud83d\udfe8 Node.js 20-22 LTS \u2022 R \ud83d\udcca 3.6.3/4.0.5/4.2.3/4.3.3/4.4.2/4.5.1 (six atmospheric processors) \u2022 HTML \ud83c\udf10 CSS \ud83c\udfa8 JSON \ud83d\udcdd YAML \ud83d\udcc4 \u2014 seven languages breathing in unison \ud83c\udf2c\ufe0f '
                + ' \u2694\ufe0f\ud83d\udca5\u2694\ufe0f '
                + '\ud83c\udfaf WEAPONS SYSTEMS \ud83c\udfaf TensorFlow \ud83e\udde0 2.21 \u2022 Keras \ud83e\uddea \u2022 PyTorch \ud83d\udd25 \u2022 scikit-learn \ud83d\udcc8 \u2022 XGBoost \ud83d\ude80 \u2022 LightGBM \u26a1 \u2022 NumPy \ud83d\udd22 \u2022 Pandas \ud83d\udc3c \u2014 armed for any prediction theatre \ud83d\udca3 '
                + ' \ud83d\udee1\ufe0f\ud83d\udd12\ud83d\udee1\ufe0f '
                + '\ud83d\udda5\ufe0f SHIELD ARRAY \ud83d\udda5\ufe0f CodeMirror 6 \u270d\ufe0f editor core \u2022 xterm.js \ud83d\udcbb terminal emulators \u2022 Wunderbaum \ud83c\udf33 tree navigation \u2022 Chart.js \ud83d\udcca ECharts \ud83d\udcc9 visualization shields \u2022 KaTeX \u222b math renderer \u2022 marked.js \ud83d\udcdd highlight.js \ud83c\udf08 syntax illuminators \u2022 pdf.js \ud83d\udcc4 document projectors \u2022 jsPanel \ud83d\uddbc\ufe0f floating command decks '
                + ' \ud83d\udcac\ud83d\udef0\ufe0f\ud83d\udcac '
                + '\ud83d\udce1 COMMUNICATIONS DECK \ud83d\udce1 Gemma 4 E4B \ud83e\udd16 local AI (llama-cpp-python, on-board, no signal leaves the ship \ud83d\udd10) \u2022 Anthropic Claude API \ud83e\udde0 (Sonnet 4.6 \u2022 Opus 4.6 \u2022 Haiku 4.5) subspace relay \ud83d\udcf1 \u2022 MCP Server \ud83d\udd17 (Model Context Protocol) for allied vessel docking \u2022 Camoufox \ud83e\udd8a stealth browser for deep-space web reconnaissance \u2022 ~42 skill modules \ud83d\udcda across 7 tactical domains '
                + ' \ud83d\udd2c\ud83e\uddec\ud83d\udd2c '
                + '\ud83e\ude7a DIAGNOSTIC SUBSYSTEMS \ud83e\ude7a Ruff \ud83d\udc3a \u2022 Jedi \u2694\ufe0f \u2022 typescript-language-server \ud83d\udce1 \u2022 Biome \ud83c\udf3f \u2022 yaml-language-server \ud83d\udcc4 \u2022 vscode-langservers-extracted \ud83e\uddf0 \u2022 R languageserver \ud83d\udcca \u2022 debugpy \ud83d\udc1b \u2022 vscode-js-debug \ud83d\udd0d \u2022 ark (Posit) \ud83c\udff9 \u2014 seven LSP beacons \ud83d\udea8, two DAP targeting computers \ud83c\udfaf '
                + ' \ud83d\udce6\ud83d\ude9a\ud83d\udce6 '
                + '\ud83d\udced SUPPLY CHAIN \ud83d\udced pip \ud83d\udce6 \u2022 uv \u26a1 \u2022 pnpm \ud83d\udce6 \u2022 fnm \ud83d\udd04 \u2022 renv \ud83d\udce6 \u2014 five package delivery conduits keeping every deck stocked \ud83d\ude9a\ud83d\udca8 '
                + ' \ud83d\udcdc\ud83d\udcdd\ud83d\udcdc '
                + '\ud83d\udcd6 MISSION LOG \ud83d\udcd6 Git \ud83d\udd00 version control \u2022 DVC \ud83d\udcbe data lineage \u2022 Hydra \ud83d\udc09 config hashing \u2022 per-run bundle archival \ud83d\udce6 \u2022 6-layer lineage chain (Data \u2192 Config \u2192 Pipeline \u2192 Code \u2192 Run \u2192 Model) \ud83d\udd17\ud83d\udd17\ud83d\udd17 \u2014 every voyage fully reproducible \u267b\ufe0f, every course correction traceable \ud83d\udccd '
                + ' \ud83d\udd13\ud83c\udf0d\ud83d\udd13 '
                + '\ud83c\udff4 ZERO VENDOR LOCK-IN \ud83c\udff4 If this ship is ever decommissioned, every artifact \u2014 notebooks \ud83d\udcd3, runs \ud83c\udfc3, configs \u2699\ufe0f, DAGs \ud83d\udd04, datasets \ud83d\udcbe \u2014 remains standard and operational without noted. The engines survive the cockpit. \ud83d\ude80\u2728 '
                + '\u2b50\u2b50\u2b50 END TRANSMISSION \u2b50\u2b50\u2b50';
            scrollText.style.cssText = 'display:inline-block;white-space:nowrap;font-size:12px;font-family:"SairaStencil","Courier New",monospace;font-weight:400;color:#ff8800;text-shadow:0 0 4px #ff8800;text-transform:uppercase;line-height:44px;padding-left:100%;animation:about-scroll 130s linear infinite';
            scroller.appendChild(scrollText);
            scroller.addEventListener('mouseenter', () => { scrollText.style.animationPlayState = 'paused'; });
            scroller.addEventListener('mouseleave', () => { scrollText.style.animationPlayState = 'running'; });

            if (!document.getElementById('about-scroll-style')) {
                const style = document.createElement('style');
                style.id = 'about-scroll-style';
                style.textContent = '@font-face { font-family: "SairaStencil"; src: url("static/fonts/SairaStencil-VariableFont_wdth,wght.ttf") format("truetype"); font-weight: 100 900; font-display: swap; } @keyframes about-scroll { 0% { transform: translateX(0); } 100% { transform: translateX(-100%); } }';
                document.head.appendChild(style);
            }

            card.appendChild(img);
            card.appendChild(scroller);
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
    };
}
