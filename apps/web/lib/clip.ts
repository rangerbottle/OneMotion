export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
export const MAX_CLIP_SECONDS = 12;

export function validateClipFile(file: File) {
  if (!/\.(mp4|mov|webm)$/i.test(file.name)) throw new Error("Use an mp4, mov, or webm video.");
  if (!file.size) throw new Error("The clip is empty. Record or select another video.");
  if (file.size > MAX_CLIP_BYTES) throw new Error("The clip exceeds 50 MB. Select a smaller video.");
}

export async function validateClip(file: File, signal: AbortSignal): Promise<void> {
  validateClipFile(file);
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Could not read the video. Try another clip.")), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      // Some browser recordings have unknown duration. The server checks every decoded frame.
      const tooLong = Number.isFinite(video.duration) && video.duration > MAX_CLIP_SECONDS;
      finish(tooLong ? new Error("The clip exceeds 12 seconds. Trim it to one shot.") : undefined);
    };
    video.onerror = () => finish(new Error("This browser cannot read the video. Try an mp4 or webm clip."));
    video.src = url;
  });
}

export function recordingFilename(mimeType: string): string {
  return mimeType.toLowerCase().includes("mp4") ? "shot.mp4" : "shot.webm";
}
