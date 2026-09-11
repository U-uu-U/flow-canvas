export const VIDEO_CONTROL_HEIGHT = 28;
export const VIDEO_CONTROL_VISIBLE_BG_HEIGHT = 22;
export const VIDEO_CONTROL_BUTTON_WIDTH = 28;
export const VIDEO_CONTROL_GLYPH_SCALE = 2;
export const VIDEO_CONTROL_PROGRESS_X = 61;
export const VIDEO_CONTROL_PROGRESS_RIGHT_PADDING = 8;
export const VIDEO_CONTROL_PROGRESS_HEIGHT = 4;

export function getVideoControlLayout(stageScale, width, height) {
    const scale = Math.max(0.01, Number(stageScale) || 1);
    const contentWidth = Math.max(0, Number(width) || 0);
    const contentHeight = Math.max(0, Number(height) || 0);
    const controlHeight = VIDEO_CONTROL_HEIGHT / scale;
    const progressX = VIDEO_CONTROL_PROGRESS_X / scale;
    const progressHeight = VIDEO_CONTROL_PROGRESS_HEIGHT / scale;

    return {
        visible: contentWidth * scale >= VIDEO_CONTROL_BUTTON_WIDTH * 2 + 8
            && contentHeight * scale >= VIDEO_CONTROL_HEIGHT + 8,
        groupY: contentHeight - controlHeight,
        controlHeight,
        backgroundY: (VIDEO_CONTROL_HEIGHT - VIDEO_CONTROL_VISIBLE_BG_HEIGHT) / scale,
        backgroundHeight: VIDEO_CONTROL_VISIBLE_BG_HEIGHT / scale,
        glyphScale: VIDEO_CONTROL_GLYPH_SCALE / scale,
        glyphCenterY: (VIDEO_CONTROL_HEIGHT / 2) / scale,
        playCenterX: (VIDEO_CONTROL_BUTTON_WIDTH / 2) / scale,
        volumeCenterX: (VIDEO_CONTROL_BUTTON_WIDTH * 1.5) / scale,
        buttonWidth: VIDEO_CONTROL_BUTTON_WIDTH / scale,
        progressX,
        progressY: ((VIDEO_CONTROL_HEIGHT - VIDEO_CONTROL_PROGRESS_HEIGHT) / 2) / scale,
        progressHeight,
        progressCornerRadius: (VIDEO_CONTROL_PROGRESS_HEIGHT / 2) / scale,
        progressWidth: Math.max(
            0,
            contentWidth - progressX - VIDEO_CONTROL_PROGRESS_RIGHT_PADDING / scale
        )
    };
}
