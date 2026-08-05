// ─── SLP-Approved Reading Passages ──────────────────────────────────────
// Each passage targets specific phonetic groups with annotated difficulty.

export interface PhoneticTarget {
  grapheme: string;
  ipa: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface SLPPassage {
  id: string;
  title: string;
  text: string;
  description: string;
  targets: PhoneticTarget[];
  /** Approximate reading time in seconds */
  duration: number;
  /** Difficulty rating */
  difficulty: "beginner" | "intermediate" | "advanced";
}

export const SLP_PASSAGES: SLPPassage[] = [
  {
    id: "th-voiced",
    title: "The Weather This Month",
    description: "Practice the voiced /ð/ sound — 'th' as in 'the', 'this', 'weather'.",
    difficulty: "beginner",
    duration: 60,
    targets: [
      { grapheme: "th", ipa: "/ð/", difficulty: "easy" },
      { grapheme: "th", ipa: "/θ/", difficulty: "medium" },
    ],
    text: `The weather this month has been rather wonderful. The gentle breeze and the warm sunlight make the outdoors thoroughly enjoyable. 
Together with my brother, we gathered smooth stones by the river — each one smoother than the last.
"Weather changes everything," my mother often says thoughtfully. "The rhythm of the seasons teaches us to breathe through every phase."
This Thursday, rather than staying indoors, I think we should bathe in the soothing warmth of the sunlit garden. The earth beneath our feet feels smooth and firm.
Whether we gather those smooth stones or simply breathe the fresh air, there is something truly thoughtful about slowing down and being together.`,
  },
  {
    id: "s-blends",
    title: "The Starry Sky",
    description: "Practice /s/ blends — 'st', 'sp', 'sk', 'sl', 'sm', 'sn', 'sw'.",
    difficulty: "beginner",
    duration: 45,
    targets: [
      { grapheme: "st", ipa: "/st/", difficulty: "easy" },
      { grapheme: "sp", ipa: "/sp/", difficulty: "easy" },
      { grapheme: "sk", ipa: "/sk/", difficulty: "medium" },
      { grapheme: "sm", ipa: "/sm/", difficulty: "medium" },
    ],
    text: `Stand still and stare at the sparkling stars scattered across the sky. Small specks of silver light stretch across the soft darkness, each one spinning slowly in space.
"My sister spotted a shooting star last spring," Steven said softly. "It streaked swiftly past the constellation."
The space between stars is not empty — it is filled with stardust and scattered stories. Sometimes the sky seems still, but everything is speeding along a spectacular journey.
Stop and stare a little longer. Let the stillness speak. Even the smallest spark in the darkness can steer your spirit toward something spectacular.`,
  },
  {
    id: "r-coloring",
    title: "The River Road",
    description: "Practice R-colored vowels — 'ar', 'er', 'ir', 'or', 'ur'.",
    difficulty: "intermediate",
    duration: 70,
    targets: [
      { grapheme: "er", ipa: "/ɜr/", difficulty: "medium" },
      { grapheme: "ar", ipa: "/ɑr/", difficulty: "easy" },
      { grapheme: "or", ipa: "/ɔr/", difficulty: "medium" },
      { grapheme: "ir", ipa: "/ɪr/", difficulty: "hard" },
    ],
    text: `Arthur parked his car near the river and stared at the roaring water. The forest air was crisp and clear, perfect for a brisk walk along the winding road.
"Further up north," the ranger remarked, "there are rare birds performing extraordinary aerial maneuvers over the orchards."
Every corner of the river road revealed another wonder — a deer drinking from the shore, a heron standing perfectly still, the murmur of water over worn stones.
Arthur remembered the first time he heard that sound. "It never gets boring," he murmured, "the river's rhythm — always the same, yet always different."
Further along the path, the roaring water grew louder. Arthur turned the corner and gasped. A great waterfall, broader than he imagined, poured over the rocks in a curtain of silver and sound.`,
  },
  {
    id: "l-blends",
    title: "The Blue Balloon",
    description: "Practice /l/ blends — 'bl', 'cl', 'fl', 'gl', 'pl', 'sl'.",
    difficulty: "beginner",
    duration: 45,
    targets: [
      { grapheme: "bl", ipa: "/bl/", difficulty: "easy" },
      { grapheme: "fl", ipa: "/fl/", difficulty: "easy" },
      { grapheme: "pl", ipa: "/pl/", difficulty: "easy" },
      { grapheme: "gl", ipa: "/gl/", difficulty: "medium" },
    ],
    text: `A blue balloon floated slowly above the blooming flower fields. It was a clear, bright day — perfect for playing and exploring.
"Look at it glow!" Clara clapped her hands, her eyes following the floating blue blur.
The balloon climbed higher, slipping past the clouds, a fleeting flash of color against the endless blue.
"Please come back," Clara pleaded softly. But the balloon simply floated on, a playful little blur drifting over the plains.
Sometimes the things that slip from our grasp are the very things that teach us to let go. And in that letting go, we find a strange and quiet peace.`,
  },
  {
    id: "final-consonants",
    title: "At the End of the Day",
    description: "Practice clear articulation of final consonant sounds — /t/, /d/, /k/, /g/, /p/, /b/.",
    difficulty: "intermediate",
    duration: 60,
    targets: [
      { grapheme: "t", ipa: "/t/", difficulty: "easy" },
      { grapheme: "d", ipa: "/d/", difficulty: "easy" },
      { grapheme: "k", ipa: "/k/", difficulty: "medium" },
      { grapheme: "g", ipa: "/g/", difficulty: "medium" },
    ],
    text: `At the end of the day, David packed his bag and walked toward the garden gate. The cool ground beneath his feet felt solid and good.
"Good night, Dad," he said, tapping the gate shut behind him.
The last light dropped behind the distant hill. A soft wind kicked up dust and dead leaves. David stood and watched the dark spread across the ground.
"Keep going," he told himself. "One step at a time. Don't stop."
And so he walked on, past the gate, past the garden, into the quiet night. The path ahead was dark but he knew every turn, every rock, every root beneath his feet.`,
  },
  {
    id: "vowel-pairs",
    title: "The Rainy Day",
    description: "Practice vowel pairs — 'ai', 'ea', 'oa', 'ee', 'oo'.",
    difficulty: "intermediate",
    duration: 55,
    targets: [
      { grapheme: "ai", ipa: "/eɪ/", difficulty: "easy" },
      { grapheme: "ea", ipa: "/iː/", difficulty: "easy" },
      { grapheme: "oa", ipa: "/oʊ/", difficulty: "medium" },
      { grapheme: "ee", ipa: "/iː/", difficulty: "easy" },
      { grapheme: "oo", ipa: "/uː/", difficulty: "medium" },
    ],
    text: `The rain came down in sheets, beating a steady rhythm on the roof. Each drop seemed to speak a gentle secret as it streamed down the clean glass.
"Please read me a story," Lea pleaded, peeking over the sofa.
I reached for a book about a dreamy boat that sailed across a sea of green leaves. "Each page reveals a new dream," I read aloud.
The rain continued its steady beat. Lea's eyes grew heavy. "The dream boat is floating on a deep green sea," she repeated, her voice soft and sleepy.
Outside, the rain poured. Inside, the words flowed. And in that cozy moment between sleep and waking, the whole world seemed to breathe together.`,
  },
  {
    id: "multi-syllable",
    title: "The Incredible Adventure",
    description: "Practice multi-syllabic words — slow and clear syllabification.",
    difficulty: "advanced",
    duration: 80,
    targets: [
      { grapheme: "tion", ipa: "/ʃən/", difficulty: "hard" },
      { grapheme: "ity", ipa: "/ɪti/", difficulty: "hard" },
      { grapheme: "able", ipa: "/əbəl/", difficulty: "hard" },
      { grapheme: "ment", ipa: "/mənt/", difficulty: "hard" },
    ],
    text: `The incredible adventure began with an unexpected invitation. "Your participation is absolutely essential," the letter read. "The opportunity of a lifetime awaits your consideration."
Imagination painted possibilities. Perhaps a celebration in a faraway civilization. Or an expedition to discover unimaginable treasures.
"This is an extraordinary opportunity," Eleanor announced, her voice full of determination.
The preparation took concentration and considerable effort. Every necessary item was carefully organized. Documentation, accommodation, transportation — all arranged with meticulous attention.
"Impossible is just an opinion," Eleanor reminded everyone. "Determination transforms impossibility into reality."
And with that unforgettable statement, they began their incredible journey — a testament to the power of perseverance and the beauty of believing in the impossible.`,
  },
  {
    id: "prosody-rhythm",
    title: "The Ocean's Rhythm",
    description: "Practice prosody and rhythmic pacing — emphasis, pitch variation, and natural phrasing.",
    difficulty: "advanced",
    duration: 65,
    targets: [
      { grapheme: "emphasis", ipa: "prosody", difficulty: "hard" },
      { grapheme: "pitch", ipa: "intonation", difficulty: "hard" },
    ],
    text: `The ocean has its own rhythm. Not a hurried rhythm, but a patient one. It breathes in — and waits. It breathes out — and the waves caress the sand.
"Listen," the old sailor said, his voice rising and falling like the tide. "The ocean speaks in paragraphs, not sentences. Each wave is a word. Each tide is a story."
I stood at the water's edge and listened. Really listened. The waves didn't rush. They arrived exactly when they were meant to — unhurried, deliberate, perfect.
"Your voice is like the ocean," the sailor continued. "It has its own rhythm. Don't fight it. Find it. And when you find it — let it carry you."
The wind picked up, and the waves grew bolder. But the rhythm remained. Patient. Steady. Eternal. I closed my eyes and let the sound wash over me — wave after wave, breath after breath.`,
  },
];

// ─── Utility: get a random passage ──────────────────────────────────────

export function getRandomPassage(): SLPPassage {
  return SLP_PASSAGES[Math.floor(Math.random() * SLP_PASSAGES.length)];
}

// ─── Utility: get passages by difficulty ────────────────────────────────

export function getPassagesByDifficulty(
  difficulty: SLPPassage["difficulty"]
): SLPPassage[] {
  return SLP_PASSAGES.filter((p) => p.difficulty === difficulty);
}