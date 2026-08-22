/**
 * The standards policy itself.
 *
 * Deliberately small: it checks `canManageStandards` and nothing else. Whether
 * the *endpoint* enforces it is a different question, answered over HTTP by
 * scripts/verify-standards-http.mts — reimplementing the rule here and
 * asserting against the reimplementation would only test the test.
 *
 * Run with:  npx tsx scripts/verify-standards-guard.mts
 */
import { canManageStandards, OWNER, MEMBER } from "../src/lib/access/roles";

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean) => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
  }
};

console.log("\nWho may curate the standards");
ok("administrator may", canManageStandards(OWNER));
ok("member may not", !canManageStandards(MEMBER));
// "consultant" and "viewer" predate the two-role model and exist in live rows.
// Neither was ever owner-equivalent, so both must land on the safe side.
ok("legacy 'consultant' may not", !canManageStandards("consultant"));
ok("legacy 'viewer' may not", !canManageStandards("viewer"));
ok("an unrecognised role may not", !canManageStandards("wizard"));
ok("null may not", !canManageStandards(null));
ok("undefined may not", !canManageStandards(undefined));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
