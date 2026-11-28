import { LINK_MAX_DAYS, LINK_PASSWORD_HEADER, LINK_PASSWORD_MIN, SHARING_ERROR_CODES } from "@saas/contracts/sharing";
import * as all from "@saas/contracts";

describe("sharing contract (PW3)", () => {
  it("names a lower-case header for link passwords and one new error code", () => {
    expect(LINK_PASSWORD_HEADER).toBe(LINK_PASSWORD_HEADER.toLowerCase());
    expect(SHARING_ERROR_CODES).toEqual({ LINK_PASSWORD_REQUIRED: "link_password_required" });
  });

  it("bounds links: a year at most, passwords of 8 characters or more", () => {
    expect(LINK_MAX_DAYS).toBe(365);
    expect(LINK_PASSWORD_MIN).toBeGreaterThanOrEqual(8);
  });

  it("is re-exported from the package root", () => {
    expect(all.LINK_PASSWORD_HEADER).toBe(LINK_PASSWORD_HEADER);
  });
});
