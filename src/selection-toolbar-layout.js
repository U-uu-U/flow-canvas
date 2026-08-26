export const SELECTION_TOOLBAR_GAP = 34;
export const SELECTION_TOOLBAR_VIEWPORT_PADDING = 10;

export function getSelectionToolbarPosition({
    stage = {},
    itemRect = {},
    viewport = {},
    toolbar = {},
    gap = SELECTION_TOOLBAR_GAP,
    padding = SELECTION_TOOLBAR_VIEWPORT_PADDING
} = {}) {
    const scale = Math.max(0.0001, Number(stage.scale) || 1);
    const stageX = Number(stage.x) || 0;
    const stageY = Number(stage.y) || 0;
    const viewportWidth = Math.max(0, Number(viewport.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport.height) || 0);
    const toolbarWidth = Math.max(0, Number(toolbar.width) || 0);
    const toolbarHeight = Math.max(0, Number(toolbar.height) || 0);
    const itemX = Number(itemRect.x) || 0;
    const itemY = Number(itemRect.y) || 0;
    const itemWidth = Math.max(0, Number(itemRect.width) || 0);
    const itemHeight = Math.max(0, Number(itemRect.height) || 0);

    const itemLeft = stageX + itemX * scale;
    const itemTop = stageY + itemY * scale;
    const itemRight = itemLeft + itemWidth * scale;
    const itemBottom = itemTop + itemHeight * scale;
    const visible = itemRight >= 0
        && itemBottom >= 0
        && itemLeft <= viewportWidth
        && itemTop <= viewportHeight;

    const maxLeft = Math.max(padding, viewportWidth - toolbarWidth - padding);
    const centeredLeft = (itemLeft + itemRight - toolbarWidth) / 2;
    const left = Math.min(maxLeft, Math.max(padding, centeredLeft));
    const preferredTop = itemTop - toolbarHeight - gap;
    const placement = preferredTop >= padding ? 'above' : 'below';
    const unclampedTop = placement === 'above' ? preferredTop : itemBottom + gap;
    const maxTop = Math.max(padding, viewportHeight - toolbarHeight - padding);
    const top = Math.min(maxTop, Math.max(padding, unclampedTop));

    return {
        left: Math.round(left),
        top: Math.round(top),
        placement,
        visible
    };
}
