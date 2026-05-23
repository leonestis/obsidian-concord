// Tiny CLI: prints a signed JWT for a user. Run on the server as the `collab`
// user so JWT_SECRET is available from the systemd environment, e.g.:
//
//   sudo -u collab JWT_SECRET="$(cat /etc/obsidian-collab/secret)" \
//     npx tsx /opt/obsidian-collab/server/src/gen-token.ts alex
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

const token = jwt.sign({ name }, secret, { expiresIn } as jwt.SignOptions);

console.log(token);
