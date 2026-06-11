/**
 * DiffView - shared side-by-side diff rendering utility.
 *
 * Used by ChatService (assistant code changes) and FileEditor (lint fixes).
 */

/** Line diff producing pairs: [oldIdx, oldLine, newIdx, newLine, status]
 *  status: 'equal', 'removed', 'added', 'changed'
 */
export function diffLines(oldLines, newLines) {
    const pairs = [];
    let oi = 0, ni = 0;
    while (oi < oldLines.length || ni < newLines.length) {
        if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
            pairs.push([oi, oldLines[oi], ni, newLines[ni], 'equal']);
            oi++; ni++;
        } else {
            let foundOld = -1, foundNew = -1;
            for (let look = 1; look < 10; look++) {
                if (foundNew < 0 && ni + look < newLines.length && oi < oldLines.length && oldLines[oi] === newLines[ni + look])
                    foundNew = ni + look;
                if (foundOld < 0 && oi + look < oldLines.length && ni < newLines.length && oldLines[oi + look] === newLines[ni])
                    foundOld = oi + look;
            }
            if (foundOld >= 0 && (foundNew < 0 || (foundOld - oi) <= (foundNew - ni))) {
                while (oi < foundOld) { pairs.push([oi, oldLines[oi], null, null, 'removed']); oi++; }
            } else if (foundNew >= 0) {
                while (ni < foundNew) { pairs.push([null, null, ni, newLines[ni], 'added']); ni++; }
            } else if (oi < oldLines.length && ni < newLines.length) {
                pairs.push([oi, oldLines[oi], ni, newLines[ni], 'changed']); oi++; ni++;
            } else if (oi < oldLines.length) {
                pairs.push([oi, oldLines[oi], null, null, 'removed']); oi++;
            } else {
                pairs.push([null, null, ni, newLines[ni], 'added']); ni++;
            }
        }
    }
    return pairs;
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

/**
 * Build side-by-side diff HTML table.
 * @param {string} before - original text
 * @param {string} after - modified text
 * @returns {string} HTML table string
 */
export function buildDiffHtml(before, after) {
    const oldLines = (before || '').replace(/\\n/g, '\n').split('\n');
    const newLines = (after || '').replace(/\\n/g, '\n').split('\n');
    const pairs = diffLines(oldLines, newLines);

    const cellStyle = 'padding:2px 6px;white-space:pre;overflow-x:auto;font-size:11px;border-bottom:1px solid #eee;vertical-align:top';
    const numStyle = 'padding:2px 4px;color:#999;text-align:right;font-size:10px;border-bottom:1px solid #eee;border-right:1px solid #e0e0e0;min-width:24px;user-select:none';

    let html = `<table style="width:100%;border-collapse:collapse;table-layout:fixed">
        <colgroup><col style="width:28px"><col style="width:calc(50% - 28px)"><col style="width:28px"><col style="width:calc(50% - 28px)"></colgroup>
        <thead><tr>
            <th colspan="2" style="padding:4px 34px;background:#fce4ec;color:#b71c1c;font-size:10px;font-weight:600;text-align:left">Current</th>
            <th colspan="2" style="padding:4px 34px;background:#e8f5e9;color:#1b5e20;font-size:10px;font-weight:600;text-align:left">Proposed</th>
        </tr></thead><tbody>`;

    for (const [oldIdx, oldLine, newIdx, newLine, status] of pairs) {
        const leftNum = oldIdx != null ? oldIdx + 1 : '';
        const rightNum = newIdx != null ? newIdx + 1 : '';
        const leftText = oldLine != null ? escapeHtml(oldLine) : '';
        const rightText = newLine != null ? escapeHtml(newLine) : '';

        let leftBg = '', rightBg = '';
        if (status === 'removed') { leftBg = 'background:#fce4ec'; }
        else if (status === 'added') { rightBg = 'background:#e8f5e9'; }
        else if (status === 'changed') { leftBg = 'background:#fce4ec'; rightBg = 'background:#e8f5e9'; }

        html += `<tr>
            <td style="${numStyle};${leftBg}">${leftNum}</td>
            <td style="${cellStyle};${leftBg}">${leftText || '&nbsp;'}</td>
            <td style="${numStyle};${rightBg}">${rightNum}</td>
            <td style="${cellStyle};${rightBg}">${rightText || '&nbsp;'}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    return html;
}
