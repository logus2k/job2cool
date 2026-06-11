/**
 * KnowledgeGraph3D - Three.js scene for the Knowledge Graph.
 *
 * Renders entities as 3D nodes and relationships as edges.
 * Supports force-directed layout, entity-type shapes/colors,
 * click to navigate, search highlight, and perspective views.
 */

import * as THREE from '../../vendor/three/three.module.min.js';
import { OrbitControls } from '../../vendor/three/OrbitControls.js';
import { ENTITY_STYLES, getCommunityColor } from './GraphNodeRenderer.js';

export class KnowledgeGraph3D {

    constructor(container, options = {}) {
        this._container = container;
        this._options = options;
        this._disposed = false;

        // Three.js core
        this._scene = null;
        this._camera = null;
        this._renderer = null;
        this._controls = null;

        // Graph data
        this._entities = [];
        this._relationships = [];
        this._nodeMeshes = {};   // entity.id -> THREE.Mesh
        this._edgeLines = [];    // THREE.Line[]
        this._labels = {};       // entity.id -> HTMLElement

        // Interaction
        this._raycaster = new THREE.Raycaster();
        this._mouse = new THREE.Vector2();
        this._hoveredId = null;
        this._selectedId = null;
        this._dragging = null;      // { entityId, mesh, plane }
        this._dragPlane = new THREE.Plane();
        this._dragOffset = new THREE.Vector3();
        this._dragIntersect = new THREE.Vector3();

        // Layout
        this._positions = {};    // entity.id -> {x, y, z}
        this._velocities = {};   // for force simulation
        this._neighbors = {};    // entity.id -> [neighbor ids]

        // Visual encoding state (computed at loadGraph time)
        this._sizeRoleById = {}; // entity.id -> 'primary' | 'secondary' | 'tertiary' (from rank percentile)
        this._entryIds = new Set(options.entryIds || []); // entry entities get a gold halo

        // Animation
        this._needsRender = true;
        this._animationId = null;
        this._liveSimulation = false;
        this._liveSimCooldown = 0;

        this._init();
    }

    _init() {
        const w = this._container.clientWidth || 800;
        const h = this._container.clientHeight || 600;

        // Scene
        this._scene = new THREE.Scene();
        this._scene.background = new THREE.Color(0xffffff);

        // Camera
        this._camera = new THREE.PerspectiveCamera(35, w / h, 1, 5000);
        this._camera.position.set(0, 30, 80);

        // Renderer
        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._renderer.setSize(w, h);
        this._container.appendChild(this._renderer.domElement);

        // Controls
        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = false;
        this._controls.screenSpacePanning = true;
        this._controls.minDistance = 1;
        this._controls.maxDistance = 5000;
        this._controls.addEventListener('change', () => { this._needsRender = true; });

        // Lights
        this._scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
        dirLight.position.set(100, 200, 150);
        this._scene.add(dirLight);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        fillLight.position.set(-100, 100, -100);
        this._scene.add(fillLight);

        // Events
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onClick = this._handleClick.bind(this);
        this._renderer.domElement.addEventListener('mousemove', this._onMouseMove);
        this._renderer.domElement.addEventListener('mousedown', this._onMouseDown);
        this._renderer.domElement.addEventListener('mouseup', this._onMouseUp);
        this._renderer.domElement.addEventListener('click', this._onClick);
        // Right-click on a node activates "repel mode" instead of opening
        // the browser context menu. Suppressed at the canvas level only.
        this._renderer.domElement.addEventListener('contextmenu', (e) => {
            if (this._hoveredId) e.preventDefault();
        });

        // Resize
        this._resizeObserver = new ResizeObserver(() => this._handleResize());
        this._resizeObserver.observe(this._container);

        this._animate();
    }

    // ── Data Loading ─────────────────────────────────────────────

    loadGraph(graphData) {
        this._clearScene();
        this._entities = graphData.entities || [];
        this._relationships = graphData.relationships || [];

        if (!this._entities.length) return;

        // Rank percentile -> size role. Top 20% = primary (largest),
        // next 50% = secondary, bottom 30% = tertiary. If no rank info
        // is available the simulation falls back to whatever role each
        // entity declared in its properties (or tertiary by default).
        const ranked = [...this._entities].sort((a, b) => {
            const ra = ((a.properties || {}).rank ?? a.rank ?? 0);
            const rb = ((b.properties || {}).rank ?? b.rank ?? 0);
            return rb - ra;
        });
        const N = ranked.length;
        this._sizeRoleById = {};
        for (let i = 0; i < N; i++) {
            const role = i < N * 0.2 ? 'primary'
                       : i < N * 0.7 ? 'secondary' : 'tertiary';
            this._sizeRoleById[ranked[i].id] = role;
        }

        // Compute layout
        this._computeForceLayout();

        // Build nodes
        for (const entity of this._entities) {
            this._createNode(entity);
        }

        // Build edges
        for (const rel of this._relationships) {
            this._createEdge(rel);
        }

        // Build labels
        for (const entity of this._entities) {
            this._createLabel(entity);
        }

        this._fitCamera();
        this._needsRender = true;
    }

    // ── Force-Directed Layout ────────────────────────────────────

    _computeForceLayout() {
        const entities = this._entities;
        const relationships = this._relationships;

        // Initialize random positions (tight initial spread)
        for (const e of entities) {
            this._positions[e.id] = {
                x: (Math.random() - 0.5) * 15,
                y: (Math.random() - 0.5) * 10,
                z: (Math.random() - 0.5) * 5,
            };
            this._velocities[e.id] = { x: 0, y: 0, z: 0 };
        }

        // Build adjacency for attraction (stored for live simulation)
        this._neighbors = {};
        for (const r of relationships) {
            this._neighbors[r.source] = this._neighbors[r.source] || [];
            this._neighbors[r.target] = this._neighbors[r.target] || [];
            this._neighbors[r.source].push(r.target);
            this._neighbors[r.target].push(r.source);
        }
        const neighbors = this._neighbors;

        // Run simulation steps
        const iterations = Math.min(200, 50 + entities.length * 2);
        const repulsion = 35;
        const attraction = 0.15;
        const damping = 0.85;

        for (let step = 0; step < iterations; step++) {
            const temperature = 1 - step / iterations;

            for (const e of entities) {
                const pos = this._positions[e.id];
                const vel = this._velocities[e.id];
                let fx = 0, fy = 0, fz = 0;

                // Repulsion from all other nodes
                for (const other of entities) {
                    if (other.id === e.id) continue;
                    const opos = this._positions[other.id];
                    const dx = pos.x - opos.x;
                    const dy = pos.y - opos.y;
                    const dz = pos.z - opos.z;
                    const dist2 = dx * dx + dy * dy + dz * dz + 0.1;
                    const force = repulsion / dist2;
                    fx += dx * force;
                    fy += dy * force;
                    fz += dz * force * 0.3; // Less Z spread
                }

                // Attraction to neighbors
                for (const nid of (neighbors[e.id] || [])) {
                    const npos = this._positions[nid];
                    if (!npos) continue;
                    const dx = npos.x - pos.x;
                    const dy = npos.y - pos.y;
                    const dz = npos.z - pos.z;
                    fx += dx * attraction;
                    fy += dy * attraction;
                    fz += dz * attraction * 0.3;
                }

                // Center gravity (very strong to keep everything tight)
                fx -= pos.x * 0.05;
                fy -= pos.y * 0.05;
                fz -= pos.z * 0.1;

                vel.x = (vel.x + fx) * damping * temperature;
                vel.y = (vel.y + fy) * damping * temperature;
                vel.z = (vel.z + fz) * damping * temperature;

                // Cap per-step velocity so a sparse graph (many nodes,
                // few edges) doesn't fly past the camera far plane.
                // Without this, repulsion at small initial distances
                // kicks nodes outside the visible scene before the
                // simulation converges, and only the rare node that
                // stays near origin actually renders.
                const VCAP = 8;
                const vmag2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;
                if (vmag2 > VCAP * VCAP) {
                    const k = VCAP / Math.sqrt(vmag2);
                    vel.x *= k; vel.y *= k; vel.z *= k;
                }

                pos.x += vel.x;
                pos.y += vel.y;
                pos.z += vel.z;
            }
        }

        // Scale positions for 3D scene (tight)
        const scale = 0.15;
        for (const e of entities) {
            const p = this._positions[e.id];
            p.x *= scale;
            p.y *= scale;
            p.z *= scale;
        }
    }

    // ── Node Creation ────────────────────────────────────────────

    _createNode(entity) {
        const style = ENTITY_STYLES[entity.type] || ENTITY_STYLES._default;
        const props = entity.properties || {};
        // Role precedence: explicit _view_role override > rank-percentile
        // computed at loadGraph time > tertiary fallback.
        const role = props._view_role || this._sizeRoleById[entity.id] || 'tertiary';
        const sizeScale = role === 'primary' ? 1.4 : (role === 'secondary' ? 1.0 : 0.65);

        // Color: community-derived if community_id is present (groups
        // related entities visually across types), else type-derived
        // fallback. Adjacent community ids get distinct hues via the
        // golden-angle distribution in getCommunityColor.
        const cid = props.community_id;
        const color = (typeof cid === 'number')
            ? getCommunityColor(cid)
            : style.color;

        const S = 0.9;
        let geometry;
        switch (style.shape) {
            case 'sphere':
                geometry = new THREE.SphereGeometry(S * 0.8 * sizeScale, 16, 12);
                break;
            case 'box':
                geometry = new THREE.BoxGeometry(S * 1.4 * sizeScale, S * 1.0 * sizeScale, S * 1.0 * sizeScale);
                break;
            case 'cylinder':
                geometry = new THREE.CylinderGeometry(S * 0.6 * sizeScale, S * 0.6 * sizeScale, S * 1.2 * sizeScale, 12);
                break;
            case 'octahedron':
                geometry = new THREE.OctahedronGeometry(S * 0.8 * sizeScale);
                break;
            case 'cone':
                geometry = new THREE.ConeGeometry(S * 0.7 * sizeScale, S * 1.2 * sizeScale, 8);
                break;
            default:
                geometry = new THREE.SphereGeometry(S * 0.8 * sizeScale, 16, 12);
        }

        const material = new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: role === 'primary' ? 0.3 : 0.15,
            metalness: 0.3,
            roughness: 0.5,
            transparent: role === 'tertiary',
            opacity: role === 'tertiary' ? 0.75 : 1.0,
        });

        const mesh = new THREE.Mesh(geometry, material);
        const pos = this._positions[entity.id];
        mesh.position.set(pos.x, pos.y, pos.z);
        // Store shape + sizeScale + S so setSelectedEntity() can build a
        // matching glass shell at any time without re-deriving them.
        mesh.userData = {
            entityId: entity.id,
            type: entity.type,
            label: entity.label,
            shape: style.shape,
            sizeScale,
            baseSize: S,
        };
        this._scene.add(mesh);
        this._nodeMeshes[entity.id] = mesh;

        // Entry-entity halo: a wireframe sphere around the node so the
        // user can see WHERE the trace started from (vector hits that
        // seeded the BFS). Added as a CHILD of the mesh so it follows
        // position changes from drag / live simulation automatically.
        if (this._entryIds.has(entity.id)) {
            const haloRadius = S * 1.3 * sizeScale;
            const haloGeom = new THREE.SphereGeometry(haloRadius, 16, 12);
            const haloMat = new THREE.MeshBasicMaterial({
                color: 0xffd700,
                wireframe: true,
                transparent: true,
                opacity: 0.55,
            });
            const halo = new THREE.Mesh(haloGeom, haloMat);
            halo.userData = { isHalo: true };
            // Halos must not absorb pointer events - the underlying node
            // mesh has to remain hoverable / draggable. Raycaster recurses
            // into children by default, so without this the halo (which
            // visually surrounds the node) eats every click.
            halo.raycast = () => {};
            mesh.add(halo); // child, inherits parent transform
        }
    }

    // ── Edge Creation ────────────────────────────────────────────

    _createEdge(rel) {
        const sourcePos = this._positions[rel.source];
        const targetPos = this._positions[rel.target];
        if (!sourcePos || !targetPos) return;

        const emphasized = rel.properties?._emphasized;
        const points = [
            new THREE.Vector3(sourcePos.x, sourcePos.y, sourcePos.z),
            new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z),
        ];

        // GraphRAG edge semantics: sameAs = identity (Levenshtein),
        // similar_to = topical (cosine), member_of = community structure.
        // Project-graph layer can flag _emphasized for highlighted paths.
        const EDGE_COLORS = {
            sameAs:     0x4caf50, // green - strong identity
            similar_to: 0x42a5f5, // blue - topical similarity
            member_of:  0xb0bec5, // faint gray - community membership
        };
        const color = emphasized ? 0x1565c0 : (EDGE_COLORS[rel.type] ?? 0x666666);

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
            color,
            linewidth: 2,
            transparent: false,
            opacity: 1.0,
        });

        const line = new THREE.Line(geometry, material);
        line.userData = { source: rel.source, target: rel.target, type: rel.type };
        this._scene.add(line);
        this._edgeLines.push(line);
    }

    // ── Labels ───────────────────────────────────────────────────

    _createLabel(entity) {
        const style = ENTITY_STYLES[entity.type] || ENTITY_STYLES._default;
        const label = document.createElement('div');
        label.style.cssText = 'position:absolute;pointer-events:none;font-size:10px;font-family:var(--font-sans);text-align:center;color:#1d1d1d;font-weight:600;white-space:nowrap;text-shadow:0 0 4px rgba(255,255,255,1),0 0 8px rgba(255,255,255,0.8);max-width:120px;overflow:hidden;text-overflow:ellipsis';
        label.textContent = entity.label;
        this._container.appendChild(label);
        this._labels[entity.id] = label;
    }

    _updateLabels() {
        if (!this._camera || !this._renderer) return;
        const w = this._renderer.domElement.clientWidth;
        const h = this._renderer.domElement.clientHeight;

        for (const [id, label] of Object.entries(this._labels)) {
            const mesh = this._nodeMeshes[id];
            if (!mesh) { label.style.display = 'none'; continue; }

            const pos = mesh.position.clone();
            pos.y += 1.2;
            pos.project(this._camera);

            if (pos.z > 1) {
                label.style.display = 'none';
            } else {
                label.style.display = '';
                label.style.left = `${(pos.x * 0.5 + 0.5) * w}px`;
                label.style.top = `${(-pos.y * 0.5 + 0.5) * h}px`;
                label.style.transform = 'translate(-50%, -100%)';
            }
        }
    }

    // ── Interaction ──────────────────────────────────────────────

    _handleMouseMove(event) {
        const rect = this._renderer.domElement.getBoundingClientRect();
        this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // If dragging a node, move it
        if (this._dragging) {
            if (this._dragStartPos) {
                const dx = event.clientX - this._dragStartPos.x;
                const dy = event.clientY - this._dragStartPos.y;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                    if (!this._dragDidMove) {
                        // First real motion - this is now an active drag.
                        // Disable the simulation (cancel hold-timer if it
                        // hasn't fired yet, and turn off the sim if it
                        // already started). Only the dragged node moves;
                        // attract / repel forces stay quiet WHILE moving.
                        this._dragDidMove = true;
                        if (this._holdTimer) {
                            clearTimeout(this._holdTimer);
                            this._holdTimer = null;
                        }
                        this._liveSimulation = false;
                        this._renderer.domElement.style.cursor = 'grabbing';
                    }
                }
            }
            if (!this._dragDidMove) return;

            this._raycaster.setFromCamera(this._mouse, this._camera);
            if (this._raycaster.ray.intersectPlane(this._dragPlane, this._dragIntersect)) {
                this._dragging.mesh.position.copy(this._dragIntersect.sub(this._dragOffset));
                this._updateEdgesForNode(this._dragging.entityId);
                this._needsRender = true;
            }
            return;
        }

        this._raycaster.setFromCamera(this._mouse, this._camera);
        const meshes = Object.values(this._nodeMeshes);
        const intersects = this._raycaster.intersectObjects(meshes);

        const newHovered = intersects.length ? intersects[0].object.userData.entityId : null;
        if (newHovered !== this._hoveredId) {
            if (this._hoveredId && this._nodeMeshes[this._hoveredId]) {
                this._nodeMeshes[this._hoveredId].scale.setScalar(1);
            }
            if (newHovered && this._nodeMeshes[newHovered]) {
                this._nodeMeshes[newHovered].scale.setScalar(1.2);
                this._renderer.domElement.style.cursor = 'pointer';
                // Show detail panel on hover
                const entity = this._entities.find(e => e.id === newHovered);
                if (entity) this._showDetailPanel(entity);
            } else {
                this._renderer.domElement.style.cursor = 'grab';
                // Hide panel when not hovering any node (unless pinned)
                if (!this._detailPinned) this._hideDetailPanel();
            }
            this._hoveredId = newHovered;
            this._needsRender = true;
        }
    }

    _handleMouseDown(event) {
        event.stopPropagation();
        if (!this._hoveredId) return;

        const mesh = this._nodeMeshes[this._hoveredId];
        if (!mesh) return;

        // event.button: 0 = left (drag/attract), 2 = right (repel-only).
        // Middle and other buttons are ignored.
        const button = event.button;
        if (button !== 0 && button !== 2) return;
        const mode = button === 2 ? 'repel' : 'attract';

        event.preventDefault();
        this._dragStartPos = { x: event.clientX, y: event.clientY };
        this._dragDidMove = false;
        this._controls.enabled = false;

        if (mode === 'attract') {
            // Drag plane for moving the node along with the mouse.
            const cameraDir = new THREE.Vector3();
            this._camera.getWorldDirection(cameraDir);
            this._dragPlane.setFromNormalAndCoplanarPoint(cameraDir, mesh.position);
            this._raycaster.setFromCamera(this._mouse, this._camera);
            this._raycaster.ray.intersectPlane(this._dragPlane, this._dragIntersect);
            this._dragOffset.copy(this._dragIntersect).sub(mesh.position);
        }

        this._dragging = { entityId: this._hoveredId, mesh, mode };
        // Defer enabling the live simulation. We don't want a pure click
        // (mousedown + immediate mouseup, no motion) to perturb the
        // layout, but we DO want a sustained hold to attract / repel.
        // Two triggers enable the sim:
        //   1. mouse moves > 3px (handled in _handleMouseMove)
        //   2. button held for > 250ms (timer below)
        // Mouseup cancels the timer if it hasn't fired yet.
        if (this._holdTimer) clearTimeout(this._holdTimer);
        this._holdTimer = setTimeout(() => {
            this._holdTimer = null;
            if (this._dragging && !this._liveSimulation) {
                this._liveSimulation = true;
            }
        }, 250);
    }

    _handleMouseUp(event) {
        event?.stopPropagation();
        // Cancel the hold-to-start-sim timer if the user releases
        // before it fires - that's the "single click" case.
        if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
        if (this._dragging) {
            this._controls.enabled = true;
            this._renderer.domElement.style.cursor = this._hoveredId ? 'pointer' : 'grab';
            this._wasDragging = this._dragDidMove;
            this._liveSimulation = false;
            const wasMode = this._dragging.mode;
            this._dragging = null;
            // Keep simulation running briefly after release for settling
            // (only meaningful for the attract/drag path).
            if (this._dragDidMove && wasMode === 'attract') this._liveSimCooldown = 90;
        }
    }

    _updateEdgesForNode(entityId) {
        for (const line of this._edgeLines) {
            const { source, target } = line.userData;
            if (source !== entityId && target !== entityId) continue;

            const srcMesh = this._nodeMeshes[source];
            const tgtMesh = this._nodeMeshes[target];
            if (!srcMesh || !tgtMesh) continue;

            const positions = line.geometry.attributes.position;
            positions.setXYZ(0, srcMesh.position.x, srcMesh.position.y, srcMesh.position.z);
            positions.setXYZ(1, tgtMesh.position.x, tgtMesh.position.y, tgtMesh.position.z);
            positions.needsUpdate = true;
        }
    }

    _handleClick(event) {
        event.stopPropagation();
        event.preventDefault();

        // Skip if we just finished dragging
        if (this._wasDragging) {
            this._wasDragging = false;
            return;
        }

        if (!this._hoveredId) {
            if (this._selectedId) {
                this._clearHighlight();
                this._selectedId = null;
                this.setSelectedEntity(null);
                this._hideDetailPanel();
            }
            return;
        }

        this._selectedId = this._hoveredId;
        this._highlightNeighborhood(this._selectedId);
        this.setSelectedEntity(this._selectedId);

        // Pin the detail panel on click so it stays when mouse leaves
        this._detailPinned = true;
        const pinBtn = this._detailPanel?.querySelector('.fa-thumbtack')?.parentElement;
        if (pinBtn) pinBtn.style.color = '#1565c0';

        const entity = this._entities.find(e => e.id === this._selectedId);
        if (entity && this._options.onEntityClick) this._options.onEntityClick(entity);
    }

    // ── Detail Panel (HTML overlay) ──────────────────────────────

    _showDetailPanel(entity) {
        // If pinned and showing a different entity, don't replace
        if (this._detailPinned && this._detailPanel) return;
        this._hideDetailPanel();

        const panel = document.createElement('div');
        panel.className = 'kg-detail-panel';
        panel.style.cssText = 'position:absolute;top:10px;right:10px;width:240px;max-height:350px;overflow-y:auto;background:rgba(255,255,255,0.95);border:0.5px solid #ccc;border-radius:6px;font-size:11px;font-family:var(--font-sans);box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10;resize:both;overflow:auto;min-width:180px;min-height:100px';

        // Drag handle (title bar)
        const titleBar = document.createElement('div');
        titleBar.style.cssText = 'padding:8px 12px 4px;cursor:move;user-select:none;border-bottom:0.5px solid #eee;margin-bottom:6px';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:6px';
        const style = ENTITY_STYLES[entity.type] || ENTITY_STYLES._default;
        const color = '#' + style.color.toString(16).padStart(6, '0');
        header.innerHTML = `<i class="fa-solid ${style.icon}" style="font-size:12px;color:${color}"></i>`
            + `<span style="font-weight:700;color:#333;font-size:12px">${this._escapeHtml(entity.label)}</span>`;
        titleBar.appendChild(header);

        // Type badge
        const typeBadge = document.createElement('div');
        typeBadge.style.cssText = 'font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px';
        typeBadge.textContent = entity.type.replace(/_/g, ' ');
        titleBar.appendChild(typeBadge);
        panel.appendChild(titleBar);

        // Make draggable via title bar
        this._makeDraggable(panel, titleBar);

        // Content area
        const content = document.createElement('div');
        content.style.cssText = 'padding:0 12px 8px';

        // Properties
        const props = entity.properties || {};
        const skipKeys = ['_view_role'];
        for (const [key, value] of Object.entries(props)) {
            if (skipKeys.includes(key)) continue;
            if (value === '' || value === null || value === undefined) continue;

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:4px;margin-bottom:3px;line-height:1.4';

            const label = document.createElement('span');
            label.style.cssText = 'color:#888;flex-shrink:0;min-width:70px;font-size:10px';
            label.textContent = key.replace(/_/g, ' ');
            row.appendChild(label);

            const val = document.createElement('span');
            val.style.cssText = 'color:#333;font-family:var(--font-mono);font-size:10px;word-break:break-all';
            if (typeof value === 'object') {
                val.textContent = JSON.stringify(value).substring(0, 80);
            } else {
                val.textContent = String(value).substring(0, 60);
            }
            row.appendChild(val);
            content.appendChild(row);
        }

        // "Open in Explorer" button - only rendered when the panel was
        // constructed with an `onEntityNavigate` callback. The new
        // chat-trace / live-preview / mode-dropdown paths don't wire it
        // (GraphRAG entity ids don't map to project-explorer tree nodes
        // anyway), so showing a no-op button there is just confusing.
        if (typeof this._options.onEntityNavigate === 'function') {
            const navBtn = document.createElement('div');
            navBtn.style.cssText = 'margin-top:8px;padding:4px 8px;background:#d0e8ff;border-radius:3px;cursor:pointer;font-size:10px;text-align:center;color:#1565c0;font-weight:500';
            navBtn.textContent = 'Open in Explorer';
            navBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._options.onEntityNavigate(entity);
            });
            content.appendChild(navBtn);
        }
        panel.appendChild(content);

        // Pin button (keeps panel open when mouse leaves node)
        const pinBtn = document.createElement('div');
        pinBtn.style.cssText = 'position:absolute;top:8px;right:26px;cursor:pointer;color:#bbb;font-size:11px';
        pinBtn.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
        pinBtn.title = 'Pin panel';
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._detailPinned = !this._detailPinned;
            pinBtn.style.color = this._detailPinned ? '#1565c0' : '#bbb';
        });
        panel.appendChild(pinBtn);

        // Close button
        const closeBtn = document.createElement('div');
        closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;cursor:pointer;color:#999;font-size:14px';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._detailPinned = false;
            this._hideDetailPanel();
            this._clearHighlight();
            this._selectedId = null;
        });
        panel.appendChild(closeBtn);

        this._container.appendChild(panel);
        this._detailPanel = panel;
    }

    _hideDetailPanel() {
        if (this._detailPinned) return;
        if (this._detailPanel) {
            this._detailPanel.remove();
            this._detailPanel = null;
        }
    }

    _makeDraggable(panel, handle) {
        let startX, startY, startLeft, startTop;

        const onMouseDown = (e) => {
            e.stopPropagation();
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            const parentRect = this._container.getBoundingClientRect();
            startLeft = rect.left - parentRect.left;
            startTop = rect.top - parentRect.top;

            panel.style.right = 'auto';
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };

        const onMouseMove = (e) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.left = (startLeft + dx) + 'px';
            panel.style.top = (startTop + dy) + 'px';
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        handle.addEventListener('mousedown', onMouseDown);
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    _highlightNeighborhood(entityId) {
        const connected = new Set([entityId]);
        for (const rel of this._relationships) {
            if (rel.source === entityId) connected.add(rel.target);
            if (rel.target === entityId) connected.add(rel.source);
        }

        for (const [id, mesh] of Object.entries(this._nodeMeshes)) {
            if (connected.has(id)) {
                mesh.material.opacity = 1;
                mesh.material.transparent = false;
                if (this._labels[id]) this._labels[id].style.opacity = '1';
            } else {
                mesh.material.opacity = 0.1;
                mesh.material.transparent = true;
                if (this._labels[id]) this._labels[id].style.opacity = '0.15';
            }
        }
        for (const line of this._edgeLines) {
            const { source, target } = line.userData;
            const isConnected = connected.has(source) && connected.has(target);
            line.material.opacity = isConnected ? 1.0 : 0.05;
            line.material.transparent = !isConnected;
        }
        this._needsRender = true;
    }

    _clearHighlight() {
        for (const [id, mesh] of Object.entries(this._nodeMeshes)) {
            const entity = this._entities.find(e => e.id === id);
            const role = entity?.properties?._view_role || 'tertiary';
            mesh.material.opacity = role === 'tertiary' ? 0.7 : 1.0;
            mesh.material.transparent = role === 'tertiary';
            if (this._labels[id]) this._labels[id].style.opacity = '1';
        }
        for (const line of this._edgeLines) {
            line.material.opacity = 1.0;
            line.material.transparent = false;
        }
        this._needsRender = true;
    }

    // ── Search Highlight ─────────────────────────────────────────

    /** Wrap the currently selected node in a translucent pastel-green
     * shell of the same shape so the user sees what's selected from the
     * list without the camera moving. Replaces any previous shell. Pass
     * null to clear the selection visual. */
    setSelectedEntity(entityId) {
        // Remove old shell from whichever node was carrying it.
        if (this._selectionShell && this._selectionShell.parent) {
            this._selectionShell.parent.remove(this._selectionShell);
            this._selectionShell.geometry?.dispose();
            this._selectionShell.material?.dispose();
        }
        this._selectionShell = null;
        if (!entityId) {
            this._needsRender = true;
            return;
        }
        const mesh = this._nodeMeshes[entityId];
        if (!mesh) return;

        const ud = mesh.userData || {};
        const shellGeom = this._buildShellGeometry(
            ud.shape || 'sphere',
            ud.baseSize ?? 0.9,
            ud.sizeScale ?? 1.0,
            1.55, // grow factor - the shell hugs the node from the outside
        );
        const shellMat = new THREE.MeshStandardMaterial({
            color: 0xa8e6cf,         // pastel green
            emissive: 0x66c597,
            emissiveIntensity: 0.18,
            metalness: 0.0,
            roughness: 0.35,
            transparent: true,
            opacity: 0.28,
        });
        const shell = new THREE.Mesh(shellGeom, shellMat);
        shell.userData = { isSelectionShell: true };
        shell.raycast = () => {}; // never absorb pointer events
        mesh.add(shell);
        this._selectionShell = shell;
        this._needsRender = true;
    }

    /** Same shape map as _createNode, parametrized so setSelectedEntity()
     * can build a slightly-larger version that wraps the original node. */
    _buildShellGeometry(shape, S, sizeScale, growth) {
        const k = (sizeScale || 1) * (growth || 1.5);
        switch (shape) {
            case 'box':
                return new THREE.BoxGeometry(S * 1.4 * k, S * 1.0 * k, S * 1.0 * k);
            case 'cylinder':
                return new THREE.CylinderGeometry(S * 0.6 * k, S * 0.6 * k, S * 1.2 * k, 12);
            case 'octahedron':
                return new THREE.OctahedronGeometry(S * 0.8 * k);
            case 'cone':
                return new THREE.ConeGeometry(S * 0.7 * k, S * 1.2 * k, 8);
            case 'sphere':
            default:
                return new THREE.SphereGeometry(S * 0.8 * k, 16, 12);
        }
    }

    highlightEntity(entityId) {
        const mesh = this._nodeMeshes[entityId];
        if (!mesh) return;

        this._selectedId = entityId;
        this._highlightNeighborhood(entityId);

        // Show detail panel
        const entity = this._entities.find(e => e.id === entityId);
        if (entity) this._showDetailPanel(entity);

        // Animate camera to the entity
        const targetPos = mesh.position.clone();
        const startPos = this._camera.position.clone();
        const startTarget = this._controls.target.clone();
        const endPos = targetPos.clone().add(
            new THREE.Vector3(0, 3, 8).applyQuaternion(this._camera.quaternion)
        );
        const startTime = performance.now();
        const duration = 800;

        const animateCamera = () => {
            const t = Math.min((performance.now() - startTime) / duration, 1);
            const ease = t * (2 - t); // ease-out quad
            this._camera.position.lerpVectors(startPos, endPos, ease);
            this._controls.target.lerpVectors(startTarget, targetPos, ease);
            this._controls.update();
            this._needsRender = true;
            if (t < 1 && !this._disposed) requestAnimationFrame(animateCamera);
        };
        animateCamera();

        // Pulse the found entity
        mesh.material.emissiveIntensity = 0.6;
        setTimeout(() => { if (mesh.material) mesh.material.emissiveIntensity = 0.25; }, 2000);
    }

    // ── Camera ───────────────────────────────────────────────────

    _fitCamera() {
        const positions = Object.values(this._positions);
        if (!positions.length) return;

        const xs = positions.map(p => p.x);
        const ys = positions.map(p => p.y);
        const zs = positions.map(p => p.z);

        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;

        const range = Math.max(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
            15,
        );

        this._camera.position.set(cx, cy + range * 0.3, cz + range * 1.5);
        this._controls.target.set(cx, cy, cz);
        this._controls.update();
    }

    // ── Animation ────────────────────────────────────────────────

    _animate() {
        if (this._disposed) return;
        this._animationId = requestAnimationFrame(() => this._animate());

        // Live force simulation during and after drag
        if (this._liveSimulation || this._liveSimCooldown > 0) {
            this._stepLiveSimulation();
            this._needsRender = true;
            if (!this._liveSimulation) {
                this._liveSimCooldown--;
                if (this._liveSimCooldown <= 0) this._liveSimCooldown = 0;
            }
        }

        if (this._needsRender) {
            this._renderer.render(this._scene, this._camera);
            this._updateLabels();
            this._needsRender = false;
        }
    }

    _stepLiveSimulation() {
        const draggedId = this._dragging?.entityId;
        const dragMode = this._dragging?.mode || 'attract';
        const isDragging = !!this._dragging;
        const damping = isDragging ? 0.3 : 0.15;
        const attraction = 0.008;
        const repulsion = 0.15;

        // Right-button "repel" mode: mirror of the attract physics. The
        // attract cascade works because every edge is a spring that
        // pulls connected pairs together; nodes drift toward the held
        // node because it's the fixed anchor. Here every edge becomes
        // a spring that PUSHES connected pairs apart up to an expanded
        // rest length, so the network breathes OUTWARD from the held
        // node - cascading through edges the same way attraction does.
        if (isDragging && dragMode === 'repel') {
            const expansionRest = 8;        // springs push apart up to 8 units
            const repelSpring = 0.012;      // slightly stronger than attraction
            const closeRepulsion = 0.15;    // same anti-overlap repel as attract

            for (const entity of this._entities) {
                if (entity.id === draggedId) continue;
                const mesh = this._nodeMeshes[entity.id];
                if (!mesh) continue;

                let fx = 0, fy = 0, fz = 0;

                // Inverted spring on each edge: push apart inside rest
                // length. This propagates the repulsion through the
                // connected component just like attraction does.
                for (const nid of (this._neighbors[entity.id] || [])) {
                    const nMesh = this._nodeMeshes[nid];
                    if (!nMesh) continue;
                    const dx = nMesh.position.x - mesh.position.x;
                    const dy = nMesh.position.y - mesh.position.y;
                    const dz = nMesh.position.z - mesh.position.z;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
                    if (dist < expansionRest) {
                        const force = (expansionRest - dist) * repelSpring;
                        fx -= (dx / dist) * force;
                        fy -= (dy / dist) * force;
                        fz -= (dz / dist) * force;
                    }
                }

                // Same close-range overlap-prevention as attract mode.
                for (const other of this._entities) {
                    if (other.id === entity.id) continue;
                    const oMesh = this._nodeMeshes[other.id];
                    if (!oMesh) continue;
                    const dx = mesh.position.x - oMesh.position.x;
                    const dy = mesh.position.y - oMesh.position.y;
                    const dz = mesh.position.z - oMesh.position.z;
                    const dist2 = dx * dx + dy * dy + dz * dz + 0.1;
                    if (dist2 < 25) {
                        const force = closeRepulsion / dist2;
                        fx += dx * force;
                        fy += dy * force;
                        fz += dz * force;
                    }
                }

                mesh.position.x += fx * damping;
                mesh.position.y += fy * damping;
                mesh.position.z += fz * damping;
            }

            for (const line of this._edgeLines) {
                const { source, target } = line.userData;
                const srcMesh = this._nodeMeshes[source];
                const tgtMesh = this._nodeMeshes[target];
                if (!srcMesh || !tgtMesh) continue;
                const positions = line.geometry.attributes.position;
                positions.setXYZ(0, srcMesh.position.x, srcMesh.position.y, srcMesh.position.z);
                positions.setXYZ(1, tgtMesh.position.x, tgtMesh.position.y, tgtMesh.position.z);
                positions.needsUpdate = true;
            }
            return;
        }

        for (const entity of this._entities) {
            if (entity.id === draggedId) continue; // Dragged node is moved by mouse

            const mesh = this._nodeMeshes[entity.id];
            if (!mesh) continue;

            let fx = 0, fy = 0, fz = 0;

            // Attraction to neighbours
            for (const nid of (this._neighbors[entity.id] || [])) {
                const nMesh = this._nodeMeshes[nid];
                if (!nMesh) continue;
                const dx = nMesh.position.x - mesh.position.x;
                const dy = nMesh.position.y - mesh.position.y;
                const dz = nMesh.position.z - mesh.position.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
                // Only attract if further than rest length
                const restLength = 3;
                if (dist > restLength) {
                    const force = (dist - restLength) * attraction;
                    fx += (dx / dist) * force;
                    fy += (dy / dist) * force;
                    fz += (dz / dist) * force;
                }
            }

            // Repulsion from all nearby nodes (prevents overlap)
            for (const other of this._entities) {
                if (other.id === entity.id) continue;
                const oMesh = this._nodeMeshes[other.id];
                if (!oMesh) continue;
                const dx = mesh.position.x - oMesh.position.x;
                const dy = mesh.position.y - oMesh.position.y;
                const dz = mesh.position.z - oMesh.position.z;
                const dist2 = dx * dx + dy * dy + dz * dz + 0.1;
                if (dist2 < 25) { // Repel within distance of 5 units
                    const force = repulsion / dist2;
                    fx += dx * force;
                    fy += dy * force;
                    fz += dz * force;
                }
            }

            // Apply force with damping
            mesh.position.x += fx * damping;
            mesh.position.y += fy * damping;
            mesh.position.z += fz * damping;
        }

        // Update all edges
        for (const line of this._edgeLines) {
            const { source, target } = line.userData;
            const srcMesh = this._nodeMeshes[source];
            const tgtMesh = this._nodeMeshes[target];
            if (!srcMesh || !tgtMesh) continue;
            const positions = line.geometry.attributes.position;
            positions.setXYZ(0, srcMesh.position.x, srcMesh.position.y, srcMesh.position.z);
            positions.setXYZ(1, tgtMesh.position.x, tgtMesh.position.y, tgtMesh.position.z);
            positions.needsUpdate = true;
        }
    }

    // ── Resize ───────────────────────────────────────────────────

    _handleResize() {
        const w = this._container.clientWidth;
        const h = this._container.clientHeight;
        if (!w || !h) return;
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h);
        this._needsRender = true;
    }

    // ── Cleanup ──────────────────────────────────────────────────

    _clearScene() {
        for (const mesh of Object.values(this._nodeMeshes)) {
            mesh.geometry?.dispose();
            mesh.material?.dispose();
            this._scene.remove(mesh);
        }
        for (const line of this._edgeLines) {
            line.geometry?.dispose();
            line.material?.dispose();
            this._scene.remove(line);
        }
        for (const label of Object.values(this._labels)) {
            label.remove();
        }
        this._nodeMeshes = {};
        this._edgeLines = [];
        this._labels = {};
        this._positions = {};
        this._velocities = {};
    }

    dispose() {
        this._disposed = true;
        if (this._animationId) cancelAnimationFrame(this._animationId);
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._renderer?.domElement?.removeEventListener('mousemove', this._onMouseMove);
        this._renderer?.domElement?.removeEventListener('mousedown', this._onMouseDown);
        this._renderer?.domElement?.removeEventListener('mouseup', this._onMouseUp);
        this._renderer?.domElement?.removeEventListener('click', this._onClick);
        this._hideDetailPanel();
        this._clearScene();
        this._renderer?.dispose();
        this._renderer?.domElement?.remove();
    }
}
