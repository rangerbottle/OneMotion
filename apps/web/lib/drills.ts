import type { AnalysisResult } from "./api";

export type DrillCategory = "foundation" | "footwork" | "range" | "game";
export type DrillLevel = "beginner" | "intermediate" | "advanced";
export type CourtSpot = { x: number; y: number; label?: string };
export type Drill = {
  id: string;
  title: string;
  category: DrillCategory;
  level: DrillLevel;
  description: string;
  minutes: number;
  sets: number;
  /** Attempts per set, including misses. */
  reps: number;
  restSeconds: number;
  cues: string[];
  steps: string[];
  spots: CourtSpot[];
  focusMetrics: string[];
  captureGuidance: string[];
  /** Spot indices in movement order. */
  route?: number[];
};

export const drillCategories: { id: DrillCategory; title: string; description: string }[] = [
  { id: "foundation", title: "Fundamentals", description: "Start close to the basket and find a smooth release." },
  { id: "footwork", title: "Footwork", description: "Get your feet set, then carry that balance into your shot." },
  { id: "range", title: "Shooting range", description: "Keep your motion consistent as you change spots." },
  { id: "game", title: "Game situations", description: "Practice balanced shots after a catch or a move." },
];

export const drillLevelLabels: Record<DrillLevel, string> = {
  beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced",
};
export const levelLabels = drillLevelLabels;
export const categoryLabels: Record<DrillCategory, string> = {
  foundation: "Fundamentals", footwork: "Footwork", range: "Shooting range", game: "Game situations",
};

const front: CourtSpot[] = [{ x: 0.5, y: 0.24, label: "Close range" }];
const five: CourtSpot[] = [
  { x: 0.16, y: 0.32, label: "Left corner" }, { x: 0.25, y: 0.56, label: "Left wing" },
  { x: 0.5, y: 0.67, label: "Center" }, { x: 0.75, y: 0.56, label: "Right wing" }, { x: 0.84, y: 0.32, label: "Right corner" },
];
const fixedCamera = "Fix your phone about 3–5 m to your shooting side. Keep your full body in view, from your feet to your fingertips at the end of the shot.";

/** Original OneMotion practice descriptions. Workload counts attempts, never makes. */
export const drills: Drill[] = [
  {
    id: "close-form", title: "Close-range form", category: "foundation", level: "beginner",
    description: "Shoot from 1–1.5 m in front of the basket. With less distance to cover, focus on a smooth release through your fingers.",
    minutes: 8, sets: 4, reps: 6, restSeconds: 30,
    steps: ["Stand directly in front of the basket with your feet comfortably apart. Support the ball with your shooting hand and steady it with your guide hand.", "Remove your guide hand before shooting. Bend your knees slightly, then extend your shooting arm naturally.", "Notice where your fingers finish. Retrieve the ball and return to the same spot for each of the 6 attempts in a set."],
    cues: ["Stay close enough that you can shoot without rushing.", "Let your fingers finish toward the basket without forcing your elbow to lock.", "Find a comfortable motion before focusing on makes."],
    spots: front, focusMetrics: ["release_angle_deg", "elbow_angle_at_release_deg", "release_height_ratio"],
    captureGuidance: [fixedCamera, "Record one complete shot, including your preparation and follow-through."],
  },
  {
    id: "guide-hand", title: "Quiet guide hand", category: "foundation", level: "beginner",
    description: "Start close to the basket with both hands on the ball. Practice using your guide hand to steady the ball without pushing it.",
    minutes: 7, sets: 3, reps: 8, restSeconds: 30,
    steps: ["Set your feet about 2 m in front of the basket. Rest your guide hand lightly against the side of the ball, with your shooting hand underneath.", "As the ball rises, let your guide hand relax away without flicking your thumb.", "Check where both hands finish after each shot. Take 8 attempts per set, then relax your hands during the rest."],
    cues: ["The guide hand steadies the ball; the shooting hand sends it.", "Let the guide hand leave naturally instead of pulling it away sharply.", "Practice slowly at close range to feel the ball leave both hands."],
    spots: [{ x: 0.5, y: 0.33, label: "About 2 m" }], focusMetrics: [],
    captureGuidance: ["To review your guide hand, film both hands from slightly in front. Use that view for observation rather than precise joint-angle measurements.", "For Curry motion analysis, record a separate fixed side view with your full body in frame."],
  },
  {
    id: "follow-through", title: "Hold the follow-through", category: "foundation", level: "beginner",
    description: "Hold a relaxed finish after a comfortable close-range shot, instead of pulling your arm back as soon as the ball leaves your hand.",
    minutes: 6, sets: 3, reps: 6, restSeconds: 30,
    steps: ["Choose a comfortable spot about 2 m in front of the basket and use your usual shooting motion.", "After release, keep your arm naturally extended with your fingertips toward the basket. Relax once the ball reaches the rim.", "Reset your balance before the next shot. Take 6 attempts per set without rushing between them."],
    cues: ["Hold the finish, not tension.", "Watch the ball reach the rim, then relax your arm.", "Land balanced before going after the ball."],
    spots: [{ x: 0.5, y: 0.33, label: "Close range" }], focusMetrics: ["follow_through_hold_s", "elbow_angle_at_release_deg"],
    captureGuidance: [fixedCamera, "Leave about 1 second after release so the video includes your follow-through."],
  },
  {
    id: "free-throw", title: "Free-throw routine", category: "foundation", level: "beginner",
    description: "Use the same stance, ball position and preparation for every free throw. Keep your rhythm independent of the previous result.",
    minutes: 8, sets: 4, reps: 5, restSeconds: 45,
    steps: ["Stand behind the free-throw line. Set your feet and choose a target on the rim.", "Choose a short, repeatable routine: for example, two dribbles, an exhale, ball preparation, then the shot.", "Take 5 attempts per set, using the same routine after makes and misses. Rest before starting the next set."],
    cues: ["Let the last shot go and start the next one fresh.", "Keep your preparation consistent and your release unhurried.", "Record each actual attempt and result."],
    spots: [{ x: 0.5, y: 0.45, label: "Free-throw line" }], focusMetrics: ["shot_tempo_s", "hip_shoulder_offset_ratio"],
    captureGuidance: [fixedCamera, "Start the single-shot selection after your last dribble. Include all preparation through the follow-through."],
  },
  {
    id: "five-spots", title: "Five-spot shooting", category: "range", level: "intermediate",
    description: "Shoot from both corners, both wings and the center. See whether your motion stays consistent when the angle changes.",
    minutes: 12, sets: 3, reps: 10, restSeconds: 60,
    steps: ["Choose a comfortable shooting arc and mark five spots: left corner, left wing, center, right wing and right corner.", "Move left to right, taking 2 attempts at each spot for a set of 10. Set your feet before each shot.", "Rest 60 seconds after each set and reverse direction for the next one. Count attempts rather than staying at a spot until you make enough."],
    cues: ["Change spots while keeping your preparation consistent.", "Set your feet toward the current shooting direction.", "If the distance strains your motion, move the whole arc closer."],
    spots: five, route: [0, 1, 2, 3, 4], focusMetrics: ["release_angle_deg", "release_height_ratio"],
    captureGuidance: ["For analysis at one spot, set a fixed side-view camera there. Avoid comparing joint angles from different camera angles.", "For history comparisons, use the same shooting spot and camera position."],
  },
  {
    id: "baseline-corners", title: "Baseline corners", category: "range", level: "intermediate",
    description: "Practice from both baseline corners and check your stance, aim and landing as you switch sides.",
    minutes: 8, sets: 4, reps: 5, restSeconds: 40,
    steps: ["Choose the same comfortable distance in each corner. Leave room inside the sideline for your stance and landing.", "Take 5 attempts on the left in set one and on the right in set two. Repeat both sides in sets three and four.", "Reset your stance and target each time you switch sides rather than keeping your body pointed toward the previous spot."],
    cues: ["Set your feet before preparing the ball.", "Leave enough space that you do not need to twist away from the sideline.", "Use the same preparation routine on both sides."],
    spots: [five[0], five[4]], route: [0, 1], focusMetrics: ["hip_shoulder_offset_ratio", "release_height_ratio"],
    captureGuidance: ["Record one corner at a time from a fixed side view.", "Compare left-corner shots with left-corner shots, and right with right."],
  },
  {
    id: "distance-ladder", title: "Distance ladder", category: "range", level: "intermediate",
    description: "Increase distance gradually to find the range where you can keep a complete, comfortable shooting motion.",
    minutes: 10, sets: 3, reps: 9, restSeconds: 45,
    steps: ["Mark spots about 2, 3 and 4 m in front of the basket. If 4 m forces you to heave the ball, bring the farthest spot closer.", "Take 3 attempts at each spot, moving near to far for a set of 9. Begin every shot with your feet set.", "Rest after each set, return to the closest spot and repeat the ladder."],
    cues: ["Add distance without adding a pause.", "Keep your leg extension and ball lift connected.", "If your motion breaks down, move closer first."],
    spots: [{ x: 0.5, y: 0.3, label: "2 m" }, { x: 0.5, y: 0.43, label: "3 m" }, { x: 0.5, y: 0.57, label: "4 m" }],
    route: [0, 1, 2], focusMetrics: ["knee_flexion_deg", "set_point_ratio", "release_height_ratio"],
    captureGuidance: ["Keep the camera fixed and your full body visible at the farthest spot. Update the camera label if you move it.", "Select one complete shot from a single distance at a time."],
  },
  {
    id: "star-rotation", title: "Star rotation", category: "footwork", level: "intermediate",
    description: "Move between five spots in a star pattern. Reset your balance after each move before starting your shot.",
    minutes: 12, sets: 3, reps: 10, restSeconds: 60,
    steps: ["Place five markers on a comfortable shooting arc. Follow this order: left corner, center, right corner, left wing, right wing.", "Stop and take 1 attempt at each spot. Retrieve the ball yourself or use a partner; complete two rotations for a set of 10.", "Rest 60 seconds after each set. Build balance at every spot before increasing your movement speed."],
    cues: ["Move at your own pace, then stop balanced before shooting.", "Use your last two steps to settle into your stance.", "Find your balance again for every shot."],
    spots: five, route: [0, 2, 4, 1, 3], focusMetrics: ["hip_shoulder_offset_ratio", "knee_flexion_deg"],
    captureGuidance: ["Frame the whole movement route and keep your full body visible.", "Select one complete shot for analysis and compare shots from the same spot."],
  },
  {
    id: "catch-and-shoot", title: "Catch and shoot", category: "game", level: "intermediate",
    description: "Connect the catch, your footwork and the ball lift into a balanced shot.",
    minutes: 10, sets: 4, reps: 6, restSeconds: 45,
    steps: ["At a comfortable shooting spot, show your hands for a partner passing from slightly in front and to the side. When alone, gently toss the ball, let it bounce and catch it.", "Use a natural one-two step or small hop to arrive in your shooting stance as you catch, then lift and release in one motion.", "Take 6 attempts per set and rest 45 seconds. Choose one footwork pattern to practice first."],
    cues: ["Find the basket before the ball arrives.", "Prepare your feet with the catch, rather than after it.", "Build a smooth connection before adding speed."],
    spots: [{ x: 0.72, y: 0.54, label: "Catch spot" }], focusMetrics: ["shot_tempo_s", "set_point_ratio"],
    captureGuidance: [fixedCamera, "Start about half a second before the catch. If your partner is visible, select yourself with the player box after importing."],
  },
  {
    id: "one-dribble", title: "One-dribble pull-up", category: "footwork", level: "intermediate",
    description: "Take one dribble left or right, gather the ball, stop balanced and shoot.",
    minutes: 10, sets: 4, reps: 6, restSeconds: 45,
    steps: ["Start with the ball at a comfortable distance in front of the basket. Take one dribble left, gather and settle into a balanced shooting stance.", "After the shot, return to the same starting point and go right. Alternate directions for 3 attempts on each side.", "Rest after the set of 6. Control your movement distance before adding speed."],
    cues: ["Use one dribble and prepare your feet as you gather.", "Stop your forward momentum before releasing.", "Keep a comfortable shooting distance on both sides."],
    spots: [{ x: 0.5, y: 0.59, label: "Start" }, { x: 0.37, y: 0.57, label: "Left" }, { x: 0.63, y: 0.57, label: "Right" }],
    route: [1, 0, 2], focusMetrics: ["hip_shoulder_offset_ratio", "knee_flexion_deg"],
    captureGuidance: ["Leave room for movement and landing in both directions so your feet stay in frame.", "Include the dribble through the follow-through. Compare the same direction from the same camera position."],
  },
  {
    id: "relocation", title: "Pass and relocate", category: "game", level: "advanced",
    description: "Pass, move sideways to a new spot, then catch and shoot. Prepare your hands and stance while moving.",
    minutes: 12, sets: 4, reps: 6, restSeconds: 60,
    steps: ["Mark two comfortable wing spots about 1–2 m apart. Have a partner stand where they can see both spots.", "Pass from the first spot and move sideways to the second. Face the passer to catch, stop your feet and shoot.", "Return and repeat for 6 attempts per set. Mirror the move on the next set and rest 60 seconds. When alone, use a self-toss instead of a pass."],
    cues: ["Have your hands ready while moving.", "Arrive ready to lift the ball, rather than rushing past the catch spot.", "Land balanced before chasing the ball."],
    spots: [{ x: 0.68, y: 0.55, label: "Pass" }, { x: 0.8, y: 0.39, label: "Catch" }], route: [0, 1],
    focusMetrics: ["hip_shoulder_offset_ratio", "shot_tempo_s"],
    captureGuidance: ["Frame both marked spots and the landing area. If a partner is visible, select the shooter with the player box.", "Start the selection before the move. Compare the same movement direction and camera position."],
  },
  {
    id: "one-motion-rhythm", title: "One-motion rhythm", category: "foundation", level: "beginner",
    description: "Connect leg extension and ball lift on a close-range shot, avoiding a pause and a second push after raising the ball.",
    minutes: 8, sets: 3, reps: 8, restSeconds: 40,
    steps: ["Set your feet about 2 m in front of the basket. Hold the ball in both hands in your usual comfortable preparation position.", "After a slight knee bend, extend naturally and let the ball rise with you without an intentional pause.", "Take 8 attempts per set, resetting your balance before each shot. Rest 40 seconds between sets."],
    cues: ["As your legs extend, let the ball rise too.", "Continuous does not mean rushed.", "Keep a comfortable ball path without forcing a lower starting position."],
    spots: [{ x: 0.5, y: 0.33, label: "About 2 m" }], focusMetrics: ["shot_tempo_s", "set_point_ratio", "knee_flexion_deg"],
    captureGuidance: [fixedCamera, "Only assess rhythm from video confirmed to play at real speed. Include preparation before the knee bend."],
  },
];

export function getDrill(id: string): Drill | undefined {
  return drills.find((drill) => drill.id === id);
}

export const workoutPlans: { id: string; title: string; description: string; drillIds: string[] }[] = [
  { id: "smooth-foundation", title: "Find your shooting rhythm", description: "Close-range form → guide hand → continuous release. Build a comfortable motion from simple spots.", drillIds: ["close-form", "guide-hand", "one-motion-rhythm"] },
  { id: "comfortable-range", title: "Build a comfortable range", description: "Find your rhythm at the free-throw line, change spots, then gradually add distance.", drillIds: ["free-throw", "five-spots", "distance-ladder"] },
  { id: "ready-to-shoot", title: "Connect movement and shooting", description: "Catch, dribble and relocate. Practice a balanced stop and release after every move.", drillIds: ["catch-and-shoot", "one-dribble", "relocation"] },
];

/** Suggestions reflect reliable measured feedback, not a diagnosis or a score target. */
export const drillRecommendations: Record<string, string[]> = {
  release_angle_deg: ["close-form", "follow-through"],
  release_height_ratio: ["close-form", "one-motion-rhythm"],
  elbow_angle_at_release_deg: ["close-form", "follow-through"],
  knee_flexion_deg: ["one-motion-rhythm", "distance-ladder"],
  set_point_ratio: ["one-motion-rhythm", "catch-and-shoot"],
  hip_shoulder_offset_ratio: ["free-throw", "one-dribble"],
  follow_through_hold_s: ["follow-through"],
  shot_tempo_s: ["one-motion-rhythm", "catch-and-shoot"],
};

export function recommendDrills(result: Pick<AnalysisResult, "feedback" | "metrics">, limit = 3): Drill[] {
  const count = Math.max(0, Math.floor(limit));
  if (!count) return [];
  const reliable = new Set(result.metrics.filter((metric) => metric.reliable && metric.value !== null).map((metric) => metric.name));
  const selected = new Map<string, Drill>();
  const groups = [...result.feedback].sort((a, b) => a.rank - b.rank)
    .filter((feedback) => reliable.has(feedback.metric))
    .map((feedback) => (drillRecommendations[feedback.metric] ?? []).map(getDrill).filter((drill): drill is Drill => Boolean(drill)));
  for (let index = 0; index < Math.max(0, ...groups.map((group) => group.length)); index += 1) {
    for (const group of groups) {
      const drill = group[index];
      if (!drill) continue;
      selected.set(drill.id, drill);
      if (selected.size >= count) return [...selected.values()];
    }
  }
  return [...selected.values()];
}
