export * from './fixpack';
export { buildImport, renderImportJson } from './build-import';
export { validateGtmExport, GtmExportSchema, neutraliseReferences } from './export-schema';
export { patchContainerResource, type GtmResource, type PatchReport } from './patch-container';
export { patchGtagConfig } from './patch-gtag-config';
export { spliceResourceIntoContainerJs, parseContainerData, findDataObject, findTopLevelValue } from './container-js';
export { findEs5Violations, scriptBodies } from './es5';
