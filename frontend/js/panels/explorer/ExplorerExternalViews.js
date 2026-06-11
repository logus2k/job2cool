/**
 * ExplorerExternalViews - Thin orchestrator that delegates to domain-specific
 * view modules for Knowledge Base, Experiments, Storage, Pipelines, Hydra, and Data.
 */

import { createDocsViews } from './ExplorerDocsViews.js';
import { createMlflowViews } from './ExplorerMlflowViews.js';
import { createStorageViews } from './ExplorerStorageViews.js';
import { createPipelineViews } from './ExplorerPipelineViews.js';
import { createHydraViews } from './ExplorerHydraViews.js';
import { createDataViews } from './ExplorerDataViews.js';
import { createRegistryViews } from './ExplorerRegistryViews.js';
import { createServingViews } from './ExplorerServingViews.js';

/**
 * @param {object} ctx - Shared explorer context (getters for live state).
 * @returns {object} View methods for docs, experiments, storage, pipelines, hydra, data, and registry.
 */
export function createExternalViews(ctx) {
    // MLflow must be created first - it sets ctx._renderKvGrid used by Hydra
    const mlflow = createMlflowViews(ctx);

    return {
        ...createDocsViews(ctx),
        ...mlflow,
        ...createStorageViews(ctx),
        ...createPipelineViews(ctx),
        ...createHydraViews(ctx),
        ...createDataViews(ctx),
        ...createRegistryViews(ctx),
        ...createServingViews(ctx),
    };
}
