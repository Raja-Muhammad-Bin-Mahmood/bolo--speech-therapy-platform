/**
 * Test entry — imports the REAL functions under test so the bundle exercises
 * the production code (not a copy).
 */
export { scriptWordMatches } from "../src/hooks/useScriptMatcher";
export { paginateScript, WORDS_PER_LINE } from "../src/lib/scriptCorrelation";
