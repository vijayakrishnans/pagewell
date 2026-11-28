// PW3's permission matrix: org role × grant × link × action, through `authorize` exactly as
// policy-worker runs it. The expected table below is written out from the design (§1,
// "Permissions"), independently of packages/policy-engine/src/files.ts.
import { actionsFor, authorize, decideFiles } from "@saas/policy-engine";
import type { AuthorizationRequest, MembershipFact } from "@saas/contracts/policy";
import type { TenancyRole } from "@saas/contracts/tenancy";

const ORG = "org_1";
const ACTIONS = ["files.read", "files.comment", "files.write", "files.delete", "files.share"] as const;
type Action = (typeof ACTIONS)[number];

// What each drive role may do, from the design.
const CAN: Record<string, readonly Action[]> = {
  none: [],
  viewer: ["files.read"],
  commenter: ["files.read", "files.comment"],
  editor: ["files.read", "files.comment", "files.write", "files.delete", "files.share"],
};
// The floor each org role gives; "guest" is a person outside the org.
const FLOOR: Record<string, string> = { owner: "editor", admin: "editor", builder: "editor", viewer: "viewer", billing_admin: "none", guest: "none" };
const RANK: Record<string, number> = { none: 0, viewer: 1, commenter: 2, editor: 3 };
const best = (...roles: string[]) => roles.reduce((a, b) => (RANK[b]! > RANK[a]! ? b : a), "none");

const req = (action: string, memberships: MembershipFact[], files: Record<string, unknown>, orgId = ORG): AuthorizationRequest => ({
  subject: { type: "user", id: "usr_x" },
  action,
  resource: { kind: "files", id: "doc_1", orgId },
  context: { memberships, attributes: { files } },
});
const fact = (role: string, orgId = ORG): MembershipFact => ({ kind: "role_assignment", role: role as TenancyRole, scope: { kind: "organization", orgId } });

describe("permission matrix: org role × grant × action", () => {
  const people = ["owner", "admin", "builder", "viewer", "billing_admin", "guest"];
  const grantSets: string[][] = [[], ["viewer"], ["commenter"], ["editor"], ["viewer", "editor"], ["commenter", "viewer"]];
  for (const who of people) {
    for (const grants of grantSets) {
      it(`${who} with grants [${grants.join(", ")}]`, () => {
        const member = who !== "guest";
        const role = best(FLOOR[who]!, ...grants);
        for (const action of ACTIONS) {
          let expected = CAN[role]!.includes(action);
          if (action === "files.share" && !member) expected = false; // guests never share
          const got = authorize(req(action, member ? [fact(who)] : [], { principal: member ? "member" : "guest", grants }));
          expect({ action, allow: got.allow }).toEqual({ action, allow: expected });
        }
      });
    }
  }
});

describe("permission matrix: share links", () => {
  for (const link of ["viewer", "commenter", "editor", null]) {
    it(`a ${link ?? "missing"} link`, () => {
      for (const action of ACTIONS) {
        // A link never edits, deletes or shares; a stored "editor" is not a link role at all.
        const role = link === "viewer" || link === "commenter" ? link : "none";
        const expected = CAN[role]!.includes(action) && action !== "files.share";
        expect({ action, allow: authorize(req(action, [], { principal: "link", grants: [], link })).allow }).toEqual({ action, allow: expected });
      }
    });
  }

  it("a link holder's grants and membership are not counted through the link", () => {
    const got = authorize(req("files.write", [fact("owner")], { principal: "link", grants: ["editor"], link: "viewer" }));
    expect(got.allow).toBe(false);
  });
});

describe("the files decision", () => {
  it("names where access came from", () => {
    expect(authorize(req("files.read", [fact("viewer")], { principal: "member", grants: [] })).reason).toBe("org_viewer");
    expect(authorize(req("files.write", [fact("viewer")], { principal: "member", grants: ["editor"] })).reason).toBe("grant_editor");
    expect(authorize(req("files.comment", [], { principal: "link", grants: [], link: "commenter" })).reason).toBe("link_commenter");
    expect(authorize(req("files.read", [], { principal: "guest", grants: [] })).reason).toBe("no_access");
    expect(authorize(req("files.share", [], { principal: "guest", grants: ["editor"] })).reason).toBe("only_members_share");
  });

  it("an owner of another org has no floor here, only grants", () => {
    expect(authorize(req("files.read", [fact("owner", "org_2")], { principal: "member", grants: [] })).allow).toBe(false);
    expect(authorize(req("files.read", [fact("owner", "org_2")], { principal: "member", grants: ["viewer"] })).allow).toBe(true);
  });

  it("the widest org role counts when a person holds several", () => {
    expect(authorize(req("files.write", [fact("viewer"), fact("builder")], { principal: "member", grants: [] })).allow).toBe(true);
  });

  it("unknown roles and actions allow nothing", () => {
    expect(authorize(req("files.read", [], { principal: "guest", grants: ["owner", "admin"] })).allow).toBe(false);
    expect(decideFiles("files.purge", "owner", { principal: "member", grants: [] }).allow).toBe(false);
    expect(authorize(req("files.read", [], { principal: "superuser", grants: ["editor"] })).allow).toBe(false);
  });

  it("without file facts, org-level checks behave as before", () => {
    const orgLevel: AuthorizationRequest = { subject: { type: "user", id: "usr_x" }, action: "files.write", resource: { kind: "files", orgId: ORG }, context: { memberships: [fact("viewer")] } };
    expect(authorize(orgLevel).allow).toBe(false);
    expect(authorize({ ...orgLevel, context: { memberships: [fact("builder")] } }).allow).toBe(true);
  });

  it("lists what each principal can do", () => {
    expect(actionsFor("editor", "guest")).toEqual(["files.read", "files.comment", "files.write", "files.delete"]);
    expect(actionsFor("commenter", "link")).toEqual(["files.read", "files.comment"]);
    expect(actionsFor(null, "member")).toEqual([]);
  });
});
