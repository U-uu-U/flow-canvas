window.readAgentFrames = async (url, requestedTime) => {
    const video = document.getElementById('source');
    const canvas = document.getElementById('frame');
    const wait = (event, action) => new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); video.removeEventListener(event, ready); video.removeEventListener('error', failed); error ? reject(error) : resolve(); };
        const ready = () => finish();
        const failed = () => finish(new Error('Video codec is unsupported or the file is unreadable'));
        const timer = setTimeout(() => finish(new Error('Video frame decoding timed out')), 15000);
        video.addEventListener(event, ready, { once: true });
        video.addEventListener('error', failed, { once: true });
        action();
    });
    try {
        await wait('loadeddata', () => { video.src = url; video.load(); });
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration');
        if (requestedTime != null && (!Number.isFinite(requestedTime) || requestedTime < 0 || requestedTime > duration)) throw new Error('Requested frame is outside the video');
        const times = requestedTime == null ? [0, duration / 3, duration * 2 / 3, Math.max(0, duration - 0.05)] : [Math.min(requestedTime, Math.max(0, duration - 0.05))];
        const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const frames = [];
        for (const time of times) {
            if (Math.abs(video.currentTime - time) > 0.001) await wait('seeked', () => { video.currentTime = time; });
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push({ time, dataUrl: canvas.toDataURL('image/jpeg', 0.82) });
        }
        return { duration, frames };
    } finally { video.removeAttribute('src'); video.load(); }
};
