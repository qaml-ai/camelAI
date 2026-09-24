import {
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_ALGORITHM = "scrypt";
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      keyLength,
      {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * Hash a password into a self-contained, versionable scrypt string.
 *
 * Format: scrypt$N$r$p$salt(base64url)$hash(base64url)
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string");
  }

  const salt = randomBytes(16);
  const hash = await deriveKey(
    password,
    salt,
    SCRYPT_KEY_LENGTH,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
  );

  return [
    SCRYPT_ALGORITHM,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/** Verify a password without throwing for malformed or unsupported hashes. */
export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (typeof password !== "string" || typeof encodedHash !== "string") {
    return false;
  }

  const [algorithm, costRaw, blockSizeRaw, parallelizationRaw, saltRaw, hashRaw] =
    encodedHash.split("$");
  if (
    algorithm !== SCRYPT_ALGORITHM ||
    !costRaw ||
    !blockSizeRaw ||
    !parallelizationRaw ||
    !saltRaw ||
    !hashRaw
  ) {
    return false;
  }

  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelization = Number(parallelizationRaw);
  if (
    !Number.isInteger(cost) ||
    cost < 2 ||
    (cost & (cost - 1)) !== 0 ||
    !Number.isInteger(blockSize) ||
    blockSize <= 0 ||
    !Number.isInteger(parallelization) ||
    parallelization <= 0
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(saltRaw, "base64url");
    const expectedHash = Buffer.from(hashRaw, "base64url");
    if (
      salt.length === 0 ||
      expectedHash.length === 0 ||
      expectedHash.length > 1024
    ) {
      return false;
    }
    const actualHash = await deriveKey(
      password,
      salt,
      expectedHash.length,
      cost,
      blockSize,
      parallelization,
    );
    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}
