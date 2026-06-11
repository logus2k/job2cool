/**
 * InfoBar - Decorative bar below toolbar.
 * Kernel controls and status have moved to the notebook bars.
 */
export class InfoBar {
    constructor(containerEl) {
        this._container = containerEl;
        this._container.id = 'info-bar';
        this._container.innerHTML = '';
    }
}
