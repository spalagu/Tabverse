const required = ["TABVERSE_RESIDENT_SIGNING_KEY_HEX"];
if ((process.env.TABVERSE_RELEASE_PLATFORM ?? process.platform) === "macOS") {
  required.push(
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  );
}
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `release environment is missing required secret names: ${missing.join(", ")}`,
  );
}
process.stdout.write(
  `${JSON.stringify({ schema: "tabverse-release-environment/v1", present: required })}\n`,
);
