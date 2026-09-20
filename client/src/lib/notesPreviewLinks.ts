/** The subset of a DOM event target needed to tell a click on a rendered notes link from one on the preview around it. */
interface AncestorLookupSource {
    closest(selector: string): unknown;
}

function canLookUpAncestors(target: unknown): target is AncestorLookupSource {
    return typeof target === 'object' && target !== null && 'closest' in target && typeof target.closest === 'function';
}

/**
 * True when an event originated on (or inside) a hyperlink in the rendered notes. The page-mode
 * preview is click-to-edit, so it must let link activations through instead of swallowing them
 * into an edit-mode switch. Text nodes and non-element targets never count as a link.
 */
export function isLinkActivation(target: EventTarget | null) {
    return canLookUpAncestors(target) && target.closest('a[href]') !== null;
}
