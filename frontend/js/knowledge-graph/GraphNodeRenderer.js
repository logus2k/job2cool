/**
 * GraphNodeRenderer - Entity type visual definitions.
 *
 * Maps each entity type to a shape, color, and icon for the 3D graph.
 * Used by KnowledgeGraph3D.js to create appropriately styled nodes.
 */

export const ENTITY_STYLES = {
    project:        { shape: 'box',         color: 0x66bb6a, icon: 'fa-clipboard-list' },
    notebook:       { shape: 'box',         color: 0xffb74d, icon: 'fa-file-code' },
    file:           { shape: 'box',         color: 0x90a4ae, icon: 'fa-file' },
    experiment:     { shape: 'octahedron',  color: 0xab47bc, icon: 'fa-vial' },
    run:            { shape: 'sphere',      color: 0x42a5f5, icon: 'fa-circle-play' },
    snapshot:       { shape: 'sphere',      color: 0xfdd835, icon: 'fa-camera' },
    model:          { shape: 'cylinder',    color: 0xce93d8, icon: 'fa-brain' },
    model_version:  { shape: 'cylinder',    color: 0xba68c8, icon: 'fa-cube' },
    data_file:      { shape: 'box',         color: 0x26a69a, icon: 'fa-database' },
    data_version:   { shape: 'sphere',      color: 0x00897b, icon: 'fa-clock-rotate-left' },
    config:         { shape: 'octahedron',  color: 0x64b5f6, icon: 'fa-sliders' },
    config_group:   { shape: 'box',         color: 0x90caf9, icon: 'fa-layer-group' },
    config_option:  { shape: 'sphere',      color: 0xbbdefb, icon: 'fa-file-code' },
    dag:            { shape: 'cone',        color: 0xff9800, icon: 'fa-diagram-project' },
    dag_task:       { shape: 'box',         color: 0xffcc80, icon: 'fa-square' },
    dag_run:        { shape: 'sphere',      color: 0xffa726, icon: 'fa-play' },
    environment:    { shape: 'cylinder',    color: 0xa5d6a7, icon: 'fa-cube' },
    tag:            { shape: 'sphere',      color: 0xf48fb1, icon: 'fa-tag' },
    // GraphRAG entity types (Answer Trace + Entity neighborhood + Communities).
    // Distinct shape AND color so the visual is parsable even for colorblind viewers.
    term:              { shape: 'cylinder',   color: 0x42a5f5, icon: 'fa-code' },
    concept:           { shape: 'sphere',     color: 0xab47bc, icon: 'fa-lightbulb' },
    organization:      { shape: 'box',        color: 0x66bb6a, icon: 'fa-building' },
    person:            { shape: 'cone',       color: 0xff9800, icon: 'fa-user' },
    // GraphRAG structural types (rare in trace mode, possible elsewhere)
    community:         { shape: 'octahedron', color: 0xfdd835, icon: 'fa-circle-nodes' },
    community_summary: { shape: 'octahedron', color: 0xffd54f, icon: 'fa-file-lines' },
    markdown_chunk:    { shape: 'box',        color: 0xb0bec5, icon: 'fa-file-lines' },
    markdown_doc:      { shape: 'box',        color: 0x78909c, icon: 'fa-file' },
    _default:       { shape: 'sphere',      color: 0xbdbdbd, icon: 'fa-circle' },
};

/**
 * Get the CSS color string for an entity type (for labels, tooltips).
 */
export function getEntityColor(type) {
    const style = ENTITY_STYLES[type] || ENTITY_STYLES._default;
    return '#' + style.color.toString(16).padStart(6, '0');
}

/**
 * Get the FontAwesome icon class for an entity type.
 */
export function getEntityIcon(type) {
    const style = ENTITY_STYLES[type] || ENTITY_STYLES._default;
    return `fa-solid ${style.icon}`;
}

/** Convert HSL (0..1, 0..1, 0..1) to a 24-bit RGB integer. Used by
 * getCommunityColor so callers can hand the value directly to THREE.js
 * material color params. */
function _hslToHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h * 6;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let r1 = 0, g1 = 0, b1 = 0;
    if (hp < 1)      { r1 = c; g1 = x; b1 = 0; }
    else if (hp < 2) { r1 = x; g1 = c; b1 = 0; }
    else if (hp < 3) { r1 = 0; g1 = c; b1 = x; }
    else if (hp < 4) { r1 = 0; g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; g1 = 0; b1 = c; }
    else             { r1 = c; g1 = 0; b1 = x; }
    const m = l - c / 2;
    const r = Math.round((r1 + m) * 255);
    const g = Math.round((g1 + m) * 255);
    const b = Math.round((b1 + m) * 255);
    return (r << 16) | (g << 8) | b;
}

/** Deterministic color for a community id. Uses the golden-angle hue
 * distribution so adjacent ids get distinct hues across any number of
 * communities, with consistent saturation/lightness. Returns an integer
 * suitable for THREE.js material colors. */
export function getCommunityColor(communityId) {
    const id = Number.isInteger(communityId) ? communityId : 0;
    const hue = (((id * 137.508) % 360) + 360) % 360;
    return _hslToHex(hue / 360, 0.62, 0.55);
}

/** CSS color string version of getCommunityColor for HTML elements. */
export function getCommunityColorCss(communityId) {
    return '#' + getCommunityColor(communityId).toString(16).padStart(6, '0');
}
