/**
 * Chat-context attachment extractors.
 *
 * Strategy registry for "Attach file to context" — the path that reads a
 * file's contents and inlines them into the next outgoing chat message
 * (NOT the KB-ingestion path). Each strategy decides whether it can
 * handle a given File and how to extract a model-readable text payload
 * from it. New strategies (PDF via Docling, DOCX, etc.) register
 * themselves with the same shape so ChatPanel doesn't need to grow new
 * branches per file type.
 *
 * Strategy contract:
 *   canHandle(file: File): boolean
 *   extract(file, config): Promise<{
 *     text: string,           // model-readable payload (may be truncated)
 *     truncated: boolean,     // true if text was clipped to fit charLimit
 *     charsRead: number,      // length of `text` after any truncation
 *     charLimit: number,      // limit applied (from upload-config)
 *     name: string,           // original filename (for chip display)
 *   }>
 *   kind: string              // short label for diagnostics / logs
 *
 * `config` is the JSON object returned by GET /api/files/upload-config.
 */

export class TextFileExtractor {
    static EXTRACT_KIND = 'text';

    /**
     * Match by extension (whitelist from server config) so we don't
     * accidentally try to readAsText() on a binary file the browser
     * won't refuse but the model can't use.
     */
    canHandle(file, config) {
        const exts = (config && config.chat_context_text_extensions) || [];
        const name = (file && file.name) || '';
        const dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        const ext = name.slice(dot).toLowerCase();
        return exts.includes(ext);
    }

    async extract(file, config) {
        const charLimit = (config && config.chat_context_max_chars) || 50000;
        const raw = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result || '');
            reader.onerror = () => reject(reader.error || new Error('FileReader error'));
            reader.readAsText(file);
        });
        const truncated = raw.length > charLimit;
        const text = truncated ? raw.slice(0, charLimit) : raw;
        return {
            text,
            truncated,
            charsRead: text.length,
            charLimit,
            name: file.name,
        };
    }

    get kind() { return TextFileExtractor.EXTRACT_KIND; }
}


export class ChatContextExtractorRegistry {
    constructor() {
        // Order matters: first matching strategy wins. Keep
        // most-specific strategies (e.g. PDF, DOCX once added) ahead
        // of the generic text reader so binary docs aren't grabbed by
        // the text strategy on a misleading extension.
        this._extractors = [];
    }

    register(extractor) {
        this._extractors.push(extractor);
    }

    findFor(file, config) {
        for (const ex of this._extractors) {
            try {
                if (ex.canHandle(file, config)) return ex;
            } catch (_e) { /* a strategy's matcher throwing should not break the chain */ }
        }
        return null;
    }
}


// Default registry: text-only for Phase 1. PDF / DOCX strategies will
// register themselves here in Phase 2 by importing this module and
// calling `chatContextExtractors.register(new MyExtractor())`.
export const chatContextExtractors = new ChatContextExtractorRegistry();
chatContextExtractors.register(new TextFileExtractor());
