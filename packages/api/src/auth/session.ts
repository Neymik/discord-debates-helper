import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
export const SESSION_COOKIE = "debates_session";

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(userId: string, secret: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key(secret));
}

export async function verifySession(token: string, secret: string): Promise<string> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: [ALG] });
  if (!payload.sub) throw new Error("no subject");
  return payload.sub;
}
