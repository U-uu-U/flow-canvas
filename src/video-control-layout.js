import { getUiCompensationScale } from './canvas-ui-scale.js';

export const VIDEO_CONTROL_HEIGHT = 28;
export const VIDEO_CONTROL_VISIBLE_BG_HEIGHT = 22;
export const VIDEO_CONTROL_BUTTON_WIDTH = 28;
export const VIDEO_CONTROL_GLYPH_SCALE = 18 / 24;
export const VIDEO_CONTROL_PROGRESS_X = 61;
export const VIDEO_CONTROL_PROGRESS_RIGHT_PADDING = 8;
export const VIDEO_CONTROL_PROGRESS_HEIGHT = 4;

export function getVideoControlLayout(stageScale, width, height, uiScaleLimit) {
    const scale = Math.max(0.01, Number(stageScale) || 1);
    const compensation = getUiCompensationScale(scale, uiScaleLimit);
    const contentWidth = Math.max(0, Number(width) || 0);
    const contentHeight = Math.max(0, Number(height) || 0);
    const controlHeight = VIDEO_CONTROL_HEIGHT * compensation;
    const progressX = VIDEO_CONTROL_PROGRESS_X * compensation;
    const progressHeight = VIDEO_CONTROL_PROGRESS_HEIGHT * compensation;

    return {
        visible: contentWidth * scale >= VIDEO_CONTROL_BUTTON_WIDTH * 2 + 8
            && contentHeight * scale >= VIDEO_CONTROL_HEIGHT + 8,
        groupY: contentHeight - controlHeight,
        controlHeight,
        backgroundY: (VIDEO_CONTROL_HEIGHT - VIDEO_CONTROL_VISIBLE_BG_HEIGHT) * compensation,
        backgroundHeight: VIDEO_CONTROL_VISIBLE_BG_HEIGHT * compensation,
        glyphScale: VIDEO_CONTROL_GLYPH_SCALE * compensation,
        glyphCenterY: (VIDEO_CONTROL_HEIGHT / 2) * compensation,
        playCenterX: (VIDEO_CONTROL_BUTTON_WIDTH / 2) * compensation,
        volumeCenterX: (VIDEO_CONTROL_BUTTON_WIDTH * 1.5) * compensation,
        buttonWidth: VIDEO_CONTROL_BUTTON_WIDTH * compensation,
        progressX,
        progressY: ((VIDEO_CONTROL_HEIGHT - VIDEO_CONTROL_PROGRESS_HEIGHT) / 2) * compensation,
        progressHeight,
        progressCornerRadius: (VIDEO_CONTROL_PROGRESS_HEIGHT / 2) * compensation,
        progressWidth: Math.max(
            0,
            contentWidth - progressX - VIDEO_CONTROL_PROGRESS_RIGHT_PADDING * compensation
        )
    };
}
