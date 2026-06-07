// Tiny CLI: prints a signed JWT for a user. Run on the server as the `collab`
// user so JWT_SECRET is available from the systemd environment, e.g.:
//
//   sudo -u collab JWT_SECRET="$(cat /etc/concord/secret)" \
//     npx tsx /opt/concord/server/src/gen-token.ts alex
//
// Usage:  gen-token <username> [expiresIn]   e.g.  gen-token alex 90d
//
// The "user" payload is just a label that lands in server context.user — no
// authorization beyond "the token verifies". Fine-grained ACLs come later.

import jwt from "jsonwebtoken";

const [name, expiresIn = "365d"] = process.argv.slice(2);
const secret = process.env.JWT_SECRET ?? "";

if (!name) {
  console.error("usage: gen-token <username> [expiresIn]");
  process.exit(2);
}
if (!secret) {
  console.error("JWT_SECRET environment variable is not set");
  process.exit(2);
}

// jsonwebtoken accepts `expiresIn` as either a bare number (seconds) or
// a string in `1s | 2m | 3h | 4d | 5w | 6y` form. If you pass it the
// string "365", it silently treats it as 365 *seconds* — about six
// minutes — which has caught people before. Validate up front so we
// never sign a token that expires the same hour it was minted.
const validExpiresIn = /^\d+(ms|s|m|h|d|w|y)?$/i;
if (!validExpiresIn.test(expiresIn)) {
  console.error(
    `invalid expiresIn "${expiresIn}". Use a number followed by a unit (s|m|h|d|w|y), e.g. 90d, 12h, 30s.`,
  );
  process.exit(2);
}

const token = jwt.sign({ name }, secret, { expiresIn } as jwt.SignOptions);

console.log(token);
