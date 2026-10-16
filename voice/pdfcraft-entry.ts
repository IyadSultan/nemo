// The PDFCraft tools the brain runs by voice. build-pdfcraft.sh bundles this file,
// with PDFCraft's own processors, into second-brain/vendor/pdfcraft-tools.mjs.
export { mergePDFs } from '@/lib/pdf/processors/merge';
export { splitPDF, parsePageRanges, createSplitEveryPage } from '@/lib/pdf/processors/split';
export { extractPages } from '@/lib/pdf/processors/extract';
export { deletePages } from '@/lib/pdf/processors/delete';
export { rotatePDF } from '@/lib/pdf/processors/rotate';
export { reversePages } from '@/lib/pdf/processors/reverse';
export { addPageNumbers } from '@/lib/pdf/processors/page-numbers';
export { addWatermark } from '@/lib/pdf/processors/watermark';
export { signPDF } from '@/lib/pdf/processors/sign';
export { processBookmarks } from '@/lib/pdf/processors/bookmark';
export { addHeaderFooter } from '@/lib/pdf/processors/header-footer';
export { addStamps } from '@/lib/pdf/processors/stamps';
export { addBlankPages } from '@/lib/pdf/processors/add-blank-page';
export { editPDFMetadata } from '@/lib/pdf/processors/edit-metadata';
export { flattenPDF } from '@/lib/pdf/processors/flatten';
export { removeAnnotations } from '@/lib/pdf/processors/remove-annotations';
export { createNUpPDF } from '@/lib/pdf/processors/n-up';
