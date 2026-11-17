/**
 * Frames out of a video file in the browser, for the recording reader (../scan/).
 *
 * The video plays in a hidden <video> element and each frame it shows is drawn onto a canvas at the width
 * the reader wants (720 pixels) and handed over as RGBA. Reading a frame takes the reader a few to a few
 * dozen milliseconds, during which the video keeps playing, so the playback speed is tuned as it goes:
 * the aim is to see the box about every 33 ms of the recording. That loses nothing, because the game
 * draws about 30 frames a second however fast the phone records (a 60 fps recording holds each game frame
 * twice). On a fast computer the video runs at 2-4x; on a slow phone below 1x.
 *
 * Browsers without requestVideoFrameCallback, and pages that are not being drawn (a tab in the background),
 * step through the video by seeking instead, which is slower. A tab sent to the background part way holds
 * the video until it is in front again.
 */

export const FRAME_WIDTH = 720;
/** Media time wanted between two frames read, in seconds. */
const STEP = 1 / 30;

/** Rejects with an Error a person can act on when this browser cannot play the file. */
async function openVideo(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // A video that isn't on the page is never drawn, and then requestVideoFrameCallback never fires: keep it
  // on the page, too small and faint to see.
  Object.assign(video.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.append(video);
  const url = URL.createObjectURL(file);
  video.src = url;
  const close = () => {
    URL.revokeObjectURL(url);
    video.remove();
  };
  try {
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error(cantPlay(file))), { once: true });
    });
  } catch (err) {
    close();
    throw err;
  }
  if (!video.videoWidth) {
    close();
    throw new Error(cantPlay(file));
  }
  return { video, close };
}

const cantPlay = (file) =>
  `This browser can't play "${file.name}". iPhone recordings are often HEVC, which some browsers on Windows can't decode.`;

/**
 * Calls onFrame({ data, width, height, time }) for frames of `file` in order, synchronously, until the
 * video ends or `signal` aborts. onProgress(fraction) now and then. Resolves to { frames, seconds }.
 */
export async function readVideoFrames(file, onFrame, { signal, onProgress = () => {} } = {}) {
  const { video, close } = await openVideo(file);
  const width = FRAME_WIDTH;
  const height = 2 * Math.round((video.videoHeight * width) / video.videoWidth / 2);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const duration = video.duration;
  let frames = 0;
  const started = performance.now();

  const grab = () => {
    ctx.drawImage(video, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    onFrame({ data, width, height, time: video.currentTime });
    frames++;
  };

  /** Plays the video and reads each frame it shows. Resolves false if no frame ever came (not drawn). */
  const playThrough = () =>
    new Promise((resolve, reject) => {
      let lastProgress = 0;
      let avg = 20;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        video.pause();
        document.removeEventListener('visibilitychange', onVisibility);
        clearTimeout(watchdog);
        resolve(ok);
      };
      // A tab in the background is not drawn, so no frames come while the video plays on: hold it.
      const onVisibility = () => {
        if (done) return;
        if (document.hidden) video.pause();
        else video.play().catch(() => {});
      };
      document.addEventListener('visibilitychange', onVisibility);
      signal?.addEventListener('abort', () => finish(true), { once: true });
      video.addEventListener('ended', () => finish(true), { once: true });
      video.addEventListener('error', () => reject(new Error(cantPlay(file))), { once: true });
      // nothing drawn after a while of playing: this page is not being drawn at all
      const watchdog = setTimeout(() => {
        if (!frames) finish(false);
      }, 2500);
      const onVideoFrame = () => {
        if (done || signal?.aborted) return;
        const t0 = performance.now();
        try {
          grab();
        } catch (err) {
          finish(true);
          reject(err);
          return;
        }
        // keep the media time between two reads near STEP
        avg = avg * 0.8 + (performance.now() - t0) * 0.2;
        const rate = Math.min(4, Math.max(0.2, (STEP * 1000) / Math.max(avg, 4)));
        if (Math.abs(rate - video.playbackRate) > 0.1) video.playbackRate = rate;
        if (performance.now() - lastProgress > 250) {
          lastProgress = performance.now();
          onProgress(Math.min(1, video.currentTime / duration));
        }
        if (!video.ended) video.requestVideoFrameCallback(onVideoFrame);
      };
      video.requestVideoFrameCallback(onVideoFrame);
      if (!document.hidden) video.play().catch(reject);
    });

  /** Steps through the video by seeking: slower, but it needs nothing drawn and every browser can. */
  const stepThrough = async () => {
    for (let t = 0; t < duration && !signal?.aborted; t += STEP) {
      await new Promise((resolve) => {
        video.addEventListener('seeked', resolve, { once: true });
        video.currentTime = t;
      });
      grab();
      if (frames % 15 === 0) {
        onProgress(t / duration);
        await new Promise((r) => setTimeout(r));
      }
    }
  };

  try {
    const played = 'requestVideoFrameCallback' in HTMLVideoElement.prototype && !document.hidden ? await playThrough() : false;
    if (!played && !signal?.aborted) {
      if (frames) throw new Error('Reading stopped part way; try again with this tab in front.');
      await stepThrough();
    }
  } finally {
    video.removeAttribute('src');
    video.load();
    close();
  }
  if (!frames && !signal?.aborted) {
    throw new Error(document.hidden ? 'The page was in the background, where the browser does not draw videos. Keep this tab in front while it reads.' : cantPlay(file));
  }
  onProgress(1);
  return { frames, seconds: (performance.now() - started) / 1000, aborted: Boolean(signal?.aborted) };
}
