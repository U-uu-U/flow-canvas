// ============================================================
// Flow Canvas — Node Icons (Lucide 描边图标)
// ============================================================
// 从 Lucide 取所需图标的 path，内联为常量，不引入依赖。
// 统一 24x24 / fill=none / stroke=currentColor，靠 currentColor
// 继承标题栏文字色，深浅背景自动适配。
// ============================================================

const ICON_PATHS = {
    // pencil-line
    'pencil-line': '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
    // hash
    hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
    // image-plus
    'image-plus': '<path d="M16 5h6"/><path d="M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/><circle cx="9" cy="9" r="2"/>',
    // image
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    // link
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    // film（视频）
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 7.5h4"/><path d="M17 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 16.5h4"/>',
    // layers（批量）
    layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12.13a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 .59-.92"/><path d="M2 16.87a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 .59-.92"/>',
    // circle-dot（端口/兜底）
    'circle-dot': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
    // play（运行）
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    // loader（运行中）
    loader: '<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>',
    // check
    check: '<path d="M20 6 9 17l-5-5"/>',
    // triangle-alert（错误）
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
};

/** 节点类型 → 图标键名。键名与 node-types.js 的 type 一致。 */
const NODE_ICON_NAMES = {
    text: 'pencil-line',
    image: 'image-plus',
    video: 'film',
    batch: 'layers'
};

/**
 * 生成内联 SVG 字符串。
 * @param {string} name  ICON_PATHS 的键
 * @param {number} size  像素尺寸
 */
export function iconSvg(name, size = 16) {
    const paths = ICON_PATHS[name] || ICON_PATHS['circle-dot'];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** 按节点类型取图标 SVG。 */
export function nodeIconSvg(nodeType, size = 16) {
    return iconSvg(NODE_ICON_NAMES[nodeType] || 'circle-dot', size);
}

/** 执行状态 → 图标键名。 */
export function statusIconName(status) {
    if (status === 'running') return 'loader';
    if (status === 'done') return 'check';
    if (status === 'error') return 'triangle-alert';
    return 'play';
}

export { ICON_PATHS, NODE_ICON_NAMES };
