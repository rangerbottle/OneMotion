/** Curated display metadata from docs/research/curry-reference-candidates.json.
 * Kept inside the web package so standalone builds do not require research docs.
 * These sources never select a scoring template or grant measurement eligibility.
 */
export const referenceViews = ["all", "front", "side", "rear", "oblique", "unreviewed"] as const;
export type ReferenceView = typeof referenceViews[number];
export const viewLabels: Record<ReferenceView, string> = {
  all: "All views", front: "Front", side: "Side", rear: "Rear", oblique: "Oblique", unreviewed: "View unreviewed",
};
export type ReferencePlatform = "all" | "youtube" | "bilibili";
export type CurryReference = {
  id: string;
  platform: Exclude<ReferencePlatform, "all">;
  videoId: string;
  title: string;
  publisher: string;
  views: Exclude<ReferenceView, "all">[];
  reviewed: boolean;
  speed: "unknown" | "slow_motion";
  description: string;
  limitations: string[];
  bookmarks: { seconds: number; label: string }[];
};
export const referencesCheckedOn = "October 8, 2026";
export const curryReferences: CurryReference[] = [
  {
    id: "yt-curry-offseason-6mnujT_fzlY", platform: "youtube", videoId: "6mnujT_fzlY",
    title: "Curry's off-season workout", publisher: "Stephen Curry & PLYRS UNTD",
    views: ["oblique"], reviewed: true, speed: "unknown",
    description: "A first look at Curry's training with Brandon Payne. Wide court views offer full-body setups and movement drills.",
    limitations: ["Camera views change between chapters.", "Several people share the frame; identify Curry before studying a shot.", "Moving drills differ from a stationary jump shot."],
    bookmarks: [{ seconds: 103, label: "Shooting foundation chapter" }, { seconds: 291, label: "Lateral shooting chapter" }],
  },
  {
    id: "yt-warriors-105-VDAExNXyP_Q", platform: "youtube", videoId: "VDAExNXyP_Q",
    title: "105 threes in a row", publisher: "Golden State Warriors",
    views: ["rear", "oblique"], reviewed: true, speed: "unknown",
    description: "Official Warriors footage with a rear to rear-oblique view. Curry's head and feet are visible in the inspected setup.",
    limitations: ["The torso can hide the shooting elbow and wrist.", "Portrait footage is surrounded by blurred padding.", "Other uploads of this run may contain the same shots."],
    bookmarks: [{ seconds: 55, label: "Rear-view setup" }],
  },
  {
    id: "yt-englert-S0S48xGfNAU", platform: "youtube", videoId: "S0S48xGfNAU",
    title: "Curry's pregame shooting workout", publisher: "Josh Englert",
    views: ["oblique", "rear"], reviewed: true, speed: "unknown",
    description: "The source upload linked by several Bilibili edits. Includes front-oblique setups and rear or side-oblique close-ups.",
    limitations: ["Some close-ups crop out the legs and feet.", "People in the foreground can obstruct the shooter.", "Slowed and enhanced reposts are the same source family, not extra independent shots."],
    bookmarks: [{ seconds: 33, label: "Full-body dribbling setup" }, { seconds: 61, label: "Rear follow-through close-up" }, { seconds: 169, label: "Side-oblique close-up" }],
  },
  {
    id: "bili-rowfit-BV1ww411f7ap", platform: "bilibili", videoId: "BV1ww411f7ap",
    title: "Extended pregame workout", publisher: "Rowfit Training",
    views: ["oblique"], reviewed: true, speed: "unknown",
    description: "An elevated front-oblique view of a long training session. The uploader describes a continuous workout in Houston.",
    limitations: ["The full video's continuity has not been verified.", "Curry's lower body leaves the frame in the inspected sequence.", "The original camera source has not been traced."],
    bookmarks: [{ seconds: 5, label: "Elevated front-oblique setup" }, { seconds: 18, label: "Framing limitation" }],
  },
  {
    id: "yt-letsgowarriors-x4pXabPgCpo", platform: "youtube", videoId: "x4pXabPgCpo",
    title: "Playoff practice shooting routine", publisher: "LetsGoWarriors",
    views: ["unreviewed"], reviewed: false, speed: "unknown",
    description: "Practice coverage before the second playoff round. A candidate for finding additional complete shots.",
    limitations: ["Only the source details have been reviewed.", "Camera view, full-body visibility and shot continuity remain unverified."],
    bookmarks: [],
  },
  {
    id: "bili-china-BV1BaYDzuEFG", platform: "bilibili", videoId: "BV1BaYDzuEFG",
    title: "China tour courtside workout", publisher: "Yun Qiu Mi",
    views: ["unreviewed"], reviewed: false, speed: "unknown",
    description: "A courtside training upload described by its publisher as uncut, 1080p60 footage.",
    limitations: ["Camera direction and full-body visibility have not been inspected.", "The resolution and continuity claims remain unverified.", "A 60fps label does not establish original playback speed."],
    bookmarks: [],
  },
  {
    id: "bili-front-BV1iu41167Jd", platform: "bilibili", videoId: "BV1iu41167Jd",
    title: "Front-view hand placement", publisher: "Shang Shan Ruo Shui Xing Xing 1",
    views: ["front"], reviewed: true, speed: "slow_motion",
    description: "A front-facing upper-body close-up for observing how Curry holds and raises the ball.",
    limitations: ["Knees and feet are outside the image.", "Slow-motion scale is unknown; do not compare tempo or velocity.", "This is not a verified full-body jump-shot window."],
    bookmarks: [{ seconds: 19, label: "Front upper-body detail" }],
  },
  {
    id: "bili-rear-BV1GY411V7Tq", platform: "bilibili", videoId: "BV1GY411V7Tq",
    title: "Close rear-view shooting", publisher: "Basketball Beginner Village",
    views: ["rear"], reviewed: true, speed: "unknown",
    description: "Rear footage of Curry in training. The inspected view is predominantly rear, despite the upload's rear-oblique title.",
    limitations: ["Framing changes within the video.", "A foreground coach obstructs the shooting scene.", "Rear projection hides some joints; this is not a clean side view."],
    bookmarks: [{ seconds: 12, label: "Rear-view setup" }, { seconds: 19, label: "Foreground obstruction" }],
  },
];

export function referenceSourceUrl(reference: CurryReference, seconds = 0): string {
  const url = reference.platform === "youtube"
    ? new URL(`https://www.youtube.com/watch?v=${reference.videoId}`)
    : new URL(`https://www.bilibili.com/video/${reference.videoId}/`);
  if (seconds > 0) url.searchParams.set("t", `${Math.floor(seconds)}`);
  return url.toString();
}

export function referenceEmbedUrl(reference: CurryReference, seconds = 0): string {
  const url = reference.platform === "youtube"
    ? new URL(`https://www.youtube-nocookie.com/embed/${reference.videoId}`)
    : new URL(`https://player.bilibili.com/player.html?bvid=${reference.videoId}`);
  url.searchParams.set("autoplay", "0");
  url.searchParams.set(reference.platform === "youtube" ? "start" : "t", `${Math.floor(seconds)}`);
  if (reference.platform === "youtube") url.searchParams.set("playsinline", "1");
  return url.toString();
}

export function referenceLibraryHref({ view = "all", platform = "all", reference, analysis }: {
  view?: ReferenceView; platform?: ReferencePlatform; reference?: string; analysis?: string;
} = {}): string {
  const query = new URLSearchParams();
  if (view !== "all") query.set("view", view);
  if (platform !== "all") query.set("platform", platform);
  if (reference) query.set("reference", reference);
  if (analysis) query.set("analysis", analysis);
  return `/references${query.size ? `?${query}` : ""}`;
}

export function formatReferenceTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${`${Math.floor(seconds % 60)}`.padStart(2, "0")}`;
}
